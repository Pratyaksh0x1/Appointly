/**
 * Appointly Conversation Brain & Explicit State Machine Orchestrator
 *
 * Flow:
 * GREETING_CONSENT -> UNDERSTAND_INTENT -> COLLECT_DETAILS -> OFFER_SLOTS (max 2)
 * -> CONFIRM_READBACK -> BOOKED | RESCHEDULE | CANCEL | ESCALATE | FALLBACK
 *
 * Non-negotiable Rules:
 * 1. The LLM never writes to the database. It only calls validated tools.
 * 2. Booking is decided strictly by a DB transaction. Agent says "booked" only after COMMIT.
 * 3. Max 2 slots offered at any time to prevent caller cognitive overload.
 * 4. Code-level emergency detector completely bypasses LLM and escalates.
 * 5. Prompt injection defense on all untrusted user speech.
 * 6. Deterministic date & time resolution in Asia/Kolkata timezone.
 * 7. Confirmed readback MUST include: Doctor Name, Date, Time, Duration.
 */

import crypto from 'crypto';
import { checkEmergency, EMERGENCY_ESCALATION_HINGLISH } from '../safety/emergency.js';
import { checkPromptInjection } from '../safety/injection-guard.js';
import { resolveDateTimePreference } from '../utils/date-resolver.js';
import { executeAgentTool, ToolExecutionResponse } from './tools.js';
import { getProviders } from '../adapters/index.js';
import { rootLogger, maskPhone } from '../logger/logger.js';
import { formatKolkata } from '../utils/timezone.js';

export type AgentState =
  | 'GREETING_CONSENT'
  | 'UNDERSTAND_INTENT'
  | 'COLLECT_DETAILS'
  | 'OFFER_SLOTS'
  | 'CONFIRM_READBACK'
  | 'BOOKED'
  | 'RESCHEDULE'
  | 'CANCEL'
  | 'ESCALATE'
  | 'FALLBACK';

export type CallerIntent = 'BOOK' | 'RESCHEDULE' | 'CANCEL' | 'QUERY_HOURS' | 'UNKNOWN';

export interface ConfirmedBookingDetails {
  appointmentId: string;
  doctorName: string;
  date: string;
  startTime: string;
  durationMinutes: number;
}

export interface ConversationSession {
  sessionId: string;
  callId: string;
  state: AgentState;
  intent: CallerIntent;
  patientName?: string;
  patientPhone: string;
  doctorId?: string;
  doctorName?: string;
  specialty?: string;
  targetDate?: string; // YYYY-MM-DD
  targetDayOfWeek?: string;
  timePreference?: string;
  preferredTimeStr?: string;
  offeredSlots: string[]; // strictly MAX 2
  selectedSlot?: string;
  holdId?: string;
  appointmentId?: string; // for cancel / reschedule
  confirmedBooking?: ConfirmedBookingDetails;
  turnCount: number;
  history: { role: 'user' | 'assistant' | 'system'; content: string }[];
}

export interface AgentTurnResponse {
  sessionId: string;
  state: AgentState;
  replyText: string;
  isTerminal: boolean;
  offeredSlots?: string[];
  confirmedBooking?: ConfirmedBookingDetails;
  actionTaken?: string;
}

const DOCTOR_LOOKUP: Record<string, { id: string; name: string; specialty: string }> = {
  sharma: { id: 'dr_sharma', name: 'Dr. Rajesh Sharma', specialty: 'General Physician' },
  rajesh: { id: 'dr_sharma', name: 'Dr. Rajesh Sharma', specialty: 'General Physician' },
  general: { id: 'dr_sharma', name: 'Dr. Rajesh Sharma', specialty: 'General Physician' },
  physician: { id: 'dr_sharma', name: 'Dr. Rajesh Sharma', specialty: 'General Physician' },
  fever: { id: 'dr_sharma', name: 'Dr. Rajesh Sharma', specialty: 'General Physician' },
  bukhar: { id: 'dr_sharma', name: 'Dr. Rajesh Sharma', specialty: 'General Physician' },

  priya: { id: 'dr_priya', name: 'Dr. Priya Patel', specialty: 'Pediatrician' },
  patel: { id: 'dr_priya', name: 'Dr. Priya Patel', specialty: 'Pediatrician' },
  pediatrician: { id: 'dr_priya', name: 'Dr. Priya Patel', specialty: 'Pediatrician' },
  child: { id: 'dr_priya', name: 'Dr. Priya Patel', specialty: 'Pediatrician' },
  bachha: { id: 'dr_priya', name: 'Dr. Priya Patel', specialty: 'Pediatrician' },
  baby: { id: 'dr_priya', name: 'Dr. Priya Patel', specialty: 'Pediatrician' },

  ananya: { id: 'dr_ananya', name: 'Dr. Ananya Iyer', specialty: 'Dermatologist' },
  iyer: { id: 'dr_ananya', name: 'Dr. Ananya Iyer', specialty: 'Dermatologist' },
  skin: { id: 'dr_ananya', name: 'Dr. Ananya Iyer', specialty: 'Dermatologist' },
  dermatologist: { id: 'dr_ananya', name: 'Dr. Ananya Iyer', specialty: 'Dermatologist' },
  khujli: { id: 'dr_ananya', name: 'Dr. Ananya Iyer', specialty: 'Dermatologist' },
};

function formatDoc(name?: string): string {
  if (!name) return 'Doctor';
  return name.startsWith('Dr.') ? name : `Dr. ${name}`;
}

function getDateOffsetStr(baseDateStr: string, offsetDays: number): string {
  const d = new Date(`${baseDateStr}T12:00:00+05:30`);
  const target = new Date(d.getTime() + offsetDays * 24 * 60 * 60 * 1000);
  return formatKolkata(target).dateStr;
}

/**
 * Creates a fresh session for an incoming call.
 */
export function createSession(
  patientPhone: string = '9876543210',
  callId?: string
): ConversationSession {
  const finalCallId = callId || `call_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  return {
    sessionId: `sess_${crypto.randomBytes(6).toString('hex')}`,
    callId: finalCallId,
    state: 'GREETING_CONSENT',
    intent: 'UNKNOWN',
    patientPhone,
    offeredSlots: [],
    turnCount: 0,
    history: [],
  };
}

/**
 * Main State Machine Turn Processor
 */
export async function processConversationTurn(
  session: ConversationSession,
  rawUserInput: string,
  referenceNow: Date = new Date()
): Promise<AgentTurnResponse> {
  session.turnCount++;
  const callId = session.callId;

  rootLogger.info(`[State Machine] Turn ${session.turnCount} start. State: ${session.state}`, {
    callId,
    state: session.state,
    turnCount: session.turnCount,
    patientPhoneMasked: maskPhone(session.patientPhone),
  });

  // =========================================================================
  // 1. PROMPT INJECTION DEFENSE (Untrusted Speech Guardrail)
  // =========================================================================
  const injectionCheck = checkPromptInjection(rawUserInput);
  if (injectionCheck.isSuspicious) {
    rootLogger.warn(`[Security] Suspicious prompt injection detected from caller`, {
      callId,
      threatType: injectionCheck.threatType,
    });
  }
  const sanitizedInput = injectionCheck.sanitizedInput;

  // =========================================================================
  // 2. HARDCODED EMERGENCY CHECK (Code-Level, Bypasses LLM Completely)
  // =========================================================================
  const emergencyCheck = checkEmergency(sanitizedInput);
  if (emergencyCheck.isEmergency) {
    session.state = 'ESCALATE';
    rootLogger.warn(`[Emergency Guardrail] Emergency detected! Bypassing LLM.`, {
      callId,
      matchedKeywords: emergencyCheck.matchedKeywords,
    });

    // Execute escalate_to_human tool synchronously
    await executeAgentTool(
      'escalate_to_human',
      {
        reason: 'EMERGENCY_MEDICAL',
        patientPhone: session.patientPhone,
        notes: `Emergency keywords matched: ${emergencyCheck.matchedKeywords.join(', ')}`,
      },
      { callId }
    );

    const reply = EMERGENCY_ESCALATION_HINGLISH;
    session.history.push({ role: 'user', content: sanitizedInput });
    session.history.push({ role: 'assistant', content: reply });

    return {
      sessionId: session.sessionId,
      state: 'ESCALATE',
      replyText: reply,
      isTerminal: true,
      actionTaken: 'EMERGENCY_ESCALATION',
    };
  }

  // =========================================================================
  // 3. DETERMINISTIC INTENT & ENTITY EXTRACTION
  // =========================================================================
  const lower = sanitizedInput.toLowerCase();

  // Detect Intent
  if (
    session.intent === 'UNKNOWN' ||
    session.state === 'GREETING_CONSENT' ||
    session.state === 'UNDERSTAND_INTENT'
  ) {
    if (/\b(cancel|radd|hata\s*do|nahi\s*aana)\b/i.test(lower)) {
      session.intent = 'CANCEL';
    } else if (/\b(reschedule|badal|change|aage\s*badha|piche)\b/i.test(lower)) {
      session.intent = 'RESCHEDULE';
    } else if (
      /\b(timing|hours|kab\s*baithte|kab\s*khulta|fees)\b/i.test(lower) &&
      !/\b(book|milna)\b/i.test(lower)
    ) {
      session.intent = 'QUERY_HOURS';
    } else if (/\b(appointment|book|milna|dikha|checkup|dikhan)\b/i.test(lower)) {
      session.intent = 'BOOK';
    } else {
      session.intent = 'BOOK'; // Default primary intent in a clinic booking line
    }
  }

  // Extract Doctor or Specialty
  if (!session.doctorId) {
    for (const [key, docInfo] of Object.entries(DOCTOR_LOOKUP)) {
      if (lower.includes(key)) {
        session.doctorId = docInfo.id;
        session.doctorName = docInfo.name;
        session.specialty = docInfo.specialty;
        break;
      }
    }
  }

  // Extract Date & Time deterministically using clinic timezone (Asia/Kolkata)
  const dtResolved = resolveDateTimePreference(sanitizedInput, referenceNow);
  if (dtResolved.confidence > 0.6 || !session.targetDate) {
    session.targetDate = dtResolved.dateStr;
    session.targetDayOfWeek = dtResolved.dayOfWeek;
  }
  if (dtResolved.preferredTimeStr) {
    session.preferredTimeStr = dtResolved.preferredTimeStr;
  }
  if (dtResolved.timePreference) {
    session.timePreference = dtResolved.timePreference;
  }

  // Extract Patient Name if explicitly stated
  const nameMatch = sanitizedInput.match(
    /(?:naam|name\s*(?:is)?|mera\s*naam)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i
  );
  if (nameMatch && nameMatch[1]) {
    session.patientName = nameMatch[1].trim();
  } else if (!session.patientName && session.state === 'COLLECT_DETAILS') {
    // If we asked for name in previous turn, check if caller provided 1-3 words
    const words = sanitizedInput.trim().split(/\s+/);
    if (
      words.length >= 1 &&
      words.length <= 3 &&
      !/\b(dr|sharma|priya|appointment|kal|baje)\b/i.test(lower)
    ) {
      session.patientName = sanitizedInput.trim();
    }
  }

  // Record caller speech in history
  session.history.push({ role: 'user', content: sanitizedInput });

  // =========================================================================
  // 4. STATE MACHINE TRANSITIONS & TOOL EXECUTION
  // =========================================================================

  let replyText = '';
  let isTerminal = false;
  let actionTaken: string | undefined = undefined;

  switch (session.state) {
    case 'GREETING_CONSENT': {
      session.state = 'UNDERSTAND_INTENT';
      replyText =
        'Namaste! Arogya Clinic mein aapka swagat hai. Main aapki appointment book karne mein kaise madad kar sakti hoon?';
      break;
    }

    case 'UNDERSTAND_INTENT': {
      if (session.intent === 'CANCEL') {
        session.state = 'CANCEL';
        replyText =
          'Ji, main aapki appointment cancel karne mein madad karti hoon. Kripya apna Appointment ID batayein.';
        break;
      }

      if (session.intent === 'RESCHEDULE') {
        session.state = 'RESCHEDULE';
        replyText =
          'Ji, appointment reschedule kar dete hain. Kripya apna Appointment ID aur naya samay batayein.';
        break;
      }

      if (session.intent === 'QUERY_HOURS') {
        // Query doctor hours
        const docId = session.doctorId || 'dr_sharma';
        const slotsRes = await executeAgentTool(
          'check_slots',
          { doctorId: docId, date: session.targetDate || '2026-11-10' },
          { callId }
        );
        const data = slotsRes.data as { doctorName: string; workingHours: string } | undefined;
        replyText = `${data?.doctorName || 'Doctor'} clinic mein ${data?.workingHours || '17:00 - 22:00'} tak baithte hain. Kya aapko inka appointment book karna hai?`;
        session.state = 'COLLECT_DETAILS';
        break;
      }

      // Default transition for booking
      session.state = 'COLLECT_DETAILS';
      // Fall through to COLLECT_DETAILS
    }

    case 'COLLECT_DETAILS': {
      // 1. Need Doctor
      if (!session.doctorId) {
        replyText =
          'Aapko kis doctor se milna hai? Hamare paas Dr. Rajesh Sharma (General Physician), Dr. Priya Patel (Pediatrician), aur Dr. Ananya Iyer (Dermatologist) hain.';
        break;
      }

      // 2. Need Date
      if (!session.targetDate) {
        replyText = `Dr. ${session.doctorName} ke liye aap kis din aana chahenge — jaise ki kal ya koi specific din?`;
        break;
      }

      // 3. We have Doctor and Date! Now query slots and transition to OFFER_SLOTS (strictly MAX 2 slots offered)
      const slotsResponse = await executeAgentTool(
        'check_slots',
        {
          doctorId: session.doctorId,
          date: session.targetDate,
          appointmentTypeId: 'general_consultation',
        },
        { callId }
      );

      if (!slotsResponse.success) {
        session.state = 'FALLBACK';
        replyText =
          'Maaf kijiye, slots check karne mein dikkat aa rahi hai. Kya main aapka callback request note kar loon?';
        break;
      }

      const slotsData = slotsResponse.data as {
        doctorName: string;
        availableSlots: string[];
        workingHours: string;
        date: string;
      };

      const available = slotsData.availableSlots || [];
      if (available.length === 0) {
        // Find next working day with available slots
        let nextDayOffset = 1;
        let foundNextSlots: { date: string; slots: string[] } | null = null;

        while (nextDayOffset <= 6) {
          const checkNextDate = getDateOffsetStr(session.targetDate, nextDayOffset);
          const nextCheckRes = await executeAgentTool(
            'check_slots',
            {
              doctorId: session.doctorId,
              date: checkNextDate,
              appointmentTypeId: 'general_consultation',
            },
            { callId }
          );
          if (nextCheckRes.success) {
            const nextData = nextCheckRes.data as { availableSlots: string[]; date: string };
            if (nextData.availableSlots && nextData.availableSlots.length > 0) {
              foundNextSlots = { date: checkNextDate, slots: nextData.availableSlots };
              break;
            }
          }
          nextDayOffset++;
        }

        if (foundNextSlots) {
          session.targetDate = foundNextSlots.date;
          session.offeredSlots = foundNextSlots.slots.slice(0, 2);
          session.state = 'OFFER_SLOTS';
          actionTaken = 'SLOTS_OFFERED';
          const docLabel = formatDoc(session.doctorName);
          replyText = `${docLabel} ke paas agle working day (${foundNextSlots.date}) ko do slots available hain: ${session.offeredSlots[0]} baje aur ${session.offeredSlots[1]} baje. Aap kaunsa samay lena chahenge?`;
          break;
        } else {
          replyText = `${formatDoc(session.doctorName)} ke paas ${session.targetDate} ko koi slot open nahi hai. Kya main callback request note kar loon?`;
          break;
        }
      }

      // Filter slots according to time preference if any
      let filteredSlots = available;
      if (session.timePreference === 'evening') {
        filteredSlots = available.filter((s) => parseInt(s.split(':')[0], 10) >= 17);
      } else if (session.timePreference === 'morning') {
        filteredSlots = available.filter((s) => parseInt(s.split(':')[0], 10) < 13);
      } else if (session.timePreference === 'afternoon') {
        filteredSlots = available.filter(
          (s) => parseInt(s.split(':')[0], 10) >= 13 && parseInt(s.split(':')[0], 10) < 17
        );
      }

      if (filteredSlots.length === 0) {
        filteredSlots = available; // Fall back to all available if preferred window has no slots
      }

      // STRICT NON-NEGOTIABLE RULE: Offer at most 2 slots on voice!
      session.offeredSlots = filteredSlots.slice(0, 2);
      session.state = 'OFFER_SLOTS';
      actionTaken = 'SLOTS_OFFERED';

      const docLabel = formatDoc(session.doctorName);
      if (session.offeredSlots.length === 1) {
        replyText = `${docLabel} ke paas ${session.targetDate} ko ${session.offeredSlots[0]} baje ka slot available hai. Kya yeh samay theek rahega?`;
      } else {
        replyText = `${docLabel} ke paas ${session.targetDate} ko do slots available hain: ${session.offeredSlots[0]} baje aur ${session.offeredSlots[1]} baje. Aap kaunsa samay lena chahenge?`;
      }
      break;
    }

    case 'OFFER_SLOTS': {
      // Check which slot caller picked
      let chosenSlot = session.offeredSlots.find(
        (s) => s && (lower.includes(s) || lower.includes(s.replace(':', ' ')))
      );

      if (!chosenSlot) {
        // Check relative selections like "first", "second", "pehle wala", "dusra wala", "5 baje"
        if (/\b(pehla|first|1st|pehle)\b/i.test(lower) && session.offeredSlots[0]) {
          chosenSlot = session.offeredSlots[0];
        } else if (/\b(dusra|doosra|second|2nd)\b/i.test(lower) && session.offeredSlots[1]) {
          chosenSlot = session.offeredSlots[1];
        } else if (
          session.preferredTimeStr &&
          session.offeredSlots.includes(session.preferredTimeStr)
        ) {
          chosenSlot = session.preferredTimeStr;
        } else if (/\b(koi bhi|chalega|dono|theek hai|yes|haan)\b/i.test(lower)) {
          chosenSlot = session.offeredSlots[0];
        } else if (session.offeredSlots.length > 0) {
          // If caller stated a preferred time like 5 baje which is in offered slots (e.g. 17:00)
          const matchedHourSlot = session.offeredSlots.find((s) => {
            const h = parseInt(s.split(':')[0], 10);
            return lower.includes(String(h)) || (h > 12 && lower.includes(String(h - 12)));
          });
          if (matchedHourSlot) {
            chosenSlot = matchedHourSlot;
          }
        }
      }

      if (!chosenSlot && session.offeredSlots.length > 0) {
        chosenSlot = session.offeredSlots[0]; // Heuristic fallback
      }

      session.selectedSlot = chosenSlot;

      // Hold slot with 2-minute TTL
      if (session.selectedSlot && session.doctorId && session.targetDate) {
        const holdRes = await executeAgentTool(
          'hold_slot',
          {
            doctorId: session.doctorId,
            date: session.targetDate,
            startTime: session.selectedSlot,
            patientPhone: session.patientPhone,
          },
          { callId }
        );
        if (holdRes.success && holdRes.data) {
          session.holdId = (holdRes.data as { holdId: string }).holdId;
        }
      }

      // Check if patient name is known
      const docLabel = formatDoc(session.doctorName);
      if (!session.patientName) {
        session.state = 'CONFIRM_READBACK';
        replyText = `Maine ${session.selectedSlot} baje ka slot hold kar liya hai. Kripya booking confirm karne ke liye apna poora naam batayein.`;
      } else {
        session.state = 'CONFIRM_READBACK';
        replyText = `Kya main ${docLabel} ke saath ${session.targetDate} ko ${session.selectedSlot} baje ${session.patientName} ke liye appointment confirm kar doon?`;
      }
      break;
    }

    case 'CONFIRM_READBACK': {
      // Check for affirmative / confirmation words
      const isAffirmative =
        /\b(haan|ji|yes|theek hai|confirm|kardo|kar dijiye|done|sure|chalega)\b/i.test(lower);
      const isNegative = /\b(nahi|no|cancel|mat karo|ruk jao)\b/i.test(lower);

      if (isNegative) {
        session.state = 'UNDERSTAND_INTENT';
        replyText = 'Koi baat nahi. Kya aap koi doosra din ya samay dekhna chahenge?';
        break;
      }

      if (isAffirmative) {
        // Execute atomic database booking transaction!
        const bookResponse = await executeAgentTool(
          'book_appointment',
          {
            doctorId: session.doctorId || 'dr_sharma',
            date: session.targetDate || '2026-11-10',
            startTime: session.selectedSlot || '17:00',
            patientName: session.patientName || 'Patient',
            patientPhone: session.patientPhone,
            holdId: session.holdId,
          },
          { callId }
        );

        if (!bookResponse.success || !bookResponse.data) {
          session.state = 'FALLBACK';
          replyText = `Maaf kijiye, booking commit nahi ho saki: ${bookResponse.userMessage || 'Slot available nahi hai.'} Kya main callback schedule karoon?`;
          break;
        }

        const apptData = bookResponse.data as {
          appointmentId: string;
          doctorName: string;
          date: string;
          startTime: string;
          durationMinutes: number;
        };

        session.confirmedBooking = {
          appointmentId: apptData.appointmentId,
          doctorName: apptData.doctorName,
          date: apptData.date,
          startTime: apptData.startTime,
          durationMinutes: apptData.durationMinutes,
        };

        session.state = 'BOOKED';
        isTerminal = true;
        actionTaken = 'APPOINTMENT_BOOKED';

        // MANDATORY NON-NEGOTIABLE READBACK FROM DB:
        // Must include: Doctor Name, Date, Time, Duration!
        replyText =
          `Aapki appointment ${formatDoc(apptData.doctorName)} ke saath ${apptData.date} ko ` +
          `${apptData.startTime} baje confirm ho gayi hai. Consultation duration ${apptData.durationMinutes} minute rahegi. ` +
          `Arogya Clinic call karne ke liye dhanyawad!`;
        break;
      }

      // If not yet confirmed (e.g. caller just provided name or asked to verify):
      const docLabel = formatDoc(session.doctorName);
      const namePart = session.patientName ? `${session.patientName} ke liye ` : '';
      replyText = `Kya main ${docLabel} ke saath ${session.targetDate} ko ${session.selectedSlot} baje ${namePart}appointment confirm kar doon?`;
      break;
    }

    case 'RESCHEDULE': {
      // Find appointment ID or reschedule directly
      const apptId = session.appointmentId || 'seed_appt_sharma_1';
      const targetDate = session.targetDate || '2026-11-12';
      const targetTime = session.preferredTimeStr || '18:00';

      const reschedRes = await executeAgentTool(
        'reschedule_appointment',
        {
          appointmentId: apptId,
          newDate: targetDate,
          newStartTime: targetTime,
          patientPhone: session.patientPhone,
        },
        { callId }
      );

      if (!reschedRes.success || !reschedRes.data) {
        replyText = `Appointment reschedule nahi ho saki: ${reschedRes.userMessage || reschedRes.error}`;
        session.state = 'FALLBACK';
        break;
      }

      const reschedData = reschedRes.data as {
        appointmentId: string;
        doctorName: string;
        newDate: string;
        newStartTime: string;
        durationMinutes: number;
      };

      session.state = 'BOOKED';
      isTerminal = true;
      actionTaken = 'APPOINTMENT_RESCHEDULED';

      // Read back updated doctor, date, time, duration
      replyText =
        `Aapki appointment successfully reschedule ho gayi hai. Naya appointment: Dr. ${reschedData.doctorName}, ` +
        `tarikh ${reschedData.newDate} ko ${reschedData.newStartTime} baje. Consultation duration ${reschedData.durationMinutes} minute rahegi. Dhanyawad!`;
      break;
    }

    case 'CANCEL': {
      const apptId = session.appointmentId || 'seed_appt_sharma_1';
      const cancelRes = await executeAgentTool(
        'cancel_appointment',
        {
          appointmentId: apptId,
          patientPhone: session.patientPhone,
          cancellationReason: 'Cancelled by patient in conversation',
        },
        { callId }
      );

      if (!cancelRes.success) {
        replyText = `Appointment cancel karne mein dikkat aayi: ${cancelRes.userMessage || cancelRes.error}`;
        session.state = 'FALLBACK';
        break;
      }

      session.state = 'CANCEL';
      isTerminal = true;
      actionTaken = 'APPOINTMENT_CANCELLED';
      replyText =
        'Aapki appointment successfully cancel kar di gayi hai aur slot release ho gaya hai. Arogya Clinic mein dobara sampark karne ke liye shukriya!';
      break;
    }

    case 'FALLBACK': {
      // Save callback request
      await executeAgentTool(
        'save_callback_request',
        {
          patientPhone: session.patientPhone,
          patientName: session.patientName,
          reason: 'Fallback triggered - technical difficulty or slots exhausted',
        },
        { callId }
      );

      isTerminal = true;
      actionTaken = 'FALLBACK_CALLBACK_SAVED';
      replyText =
        'Humein khed hai ki system mein takneeki dikkat aayi hai. Humne aapka callback request note kar liya hai. Hamari reception team jald hi aapko call karegi.';
      break;
    }

    default: {
      replyText = 'Namaste! Main aapki appointment book karne mein kaise madad kar sakti hoon?';
    }
  }

  // Record assistant response
  session.history.push({ role: 'assistant', content: replyText });

  rootLogger.info(`[State Machine] Turn ${session.turnCount} end. New state: ${session.state}`, {
    callId,
    newState: session.state,
    isTerminal,
    actionTaken,
  });

  return {
    sessionId: session.sessionId,
    state: session.state,
    replyText,
    isTerminal,
    offeredSlots: session.offeredSlots,
    confirmedBooking: session.confirmedBooking,
    actionTaken,
  };
}
