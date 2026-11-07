/**
 * Appointly Gemini Live Service
 * Integrates Google Gemini API for real-time live clinic voice call orchestration.
 * Handles Hinglish clinical conversation, slot availability checks,
 * atomic DB booking, rescheduling, cancellation, and emergency triage.
 */

import { GoogleGenAI, Type, FunctionDeclaration } from '@google/genai';
import { rootLogger } from '../logger/logger.js';
import { getDatabaseClient } from '../db/index.js';
import { emitOutboxEvent } from '../db/outbox-relay.js';
import type { ClinicProfile, Doctor, Appointment } from '../types/index.js';

let genAIClient: GoogleGenAI | null = null;

export function isGeminiConfigured(): boolean {
  const key = process.env.GEMINI_API_KEY;
  return Boolean(key && key.trim().length > 10 && !key.includes('placeholder'));
}

export function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim().length < 10) {
    return null;
  }
  if (!genAIClient) {
    genAIClient = new GoogleGenAI({ apiKey: apiKey.trim() });
  }
  return genAIClient;
}

export interface LiveTurnResult {
  replyText: string;
  actionTaken?: 'booked' | 'rescheduled' | 'cancelled' | 'slots_checked' | 'emergency' | 'none';
  bookingData?: any;
  emergency?: boolean;
  modelUsed: 'gemini-2.5-flash' | 'indic-clinical-engine';
}

const GEMINI_TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: 'get_clinic_doctors',
    description: 'Get list of doctors, their specialties, consultation fees, and available days at the clinic.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: 'get_available_slots',
    description: 'Get list of open available time slots for a specific doctor on a specific date (YYYY-MM-DD).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        doctorId: {
          type: Type.STRING,
          description: 'Doctor ID, e.g. dr_sharma or doctor id from clinic roster',
        },
        date: {
          type: Type.STRING,
          description: 'Appointment date in YYYY-MM-DD format (e.g. 2026-11-08)',
        },
      },
      required: ['doctorId', 'date'],
    },
  },
  {
    name: 'book_appointment',
    description: 'Atomically book an appointment slot. Call this after the patient specifies doctor, date, time, patient name, and phone number.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        doctorId: { type: Type.STRING, description: 'Doctor ID' },
        date: { type: Type.STRING, description: 'Date in YYYY-MM-DD format' },
        startTime: { type: Type.STRING, description: 'Start time in HH:mm format, e.g. 10:00 or 17:30' },
        patientName: { type: Type.STRING, description: 'Full name of the patient' },
        patientPhone: { type: Type.STRING, description: '10-digit Indian mobile number' },
        reason: { type: Type.STRING, description: 'Reason for visit or main symptom in patient words' },
      },
      required: ['doctorId', 'date', 'startTime', 'patientName', 'patientPhone'],
    },
  },
  {
    name: 'reschedule_appointment',
    description: 'Reschedule an existing appointment to a new date and time slot.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        appointmentId: { type: Type.STRING, description: 'Existing appointment ID if known' },
        patientPhone: { type: Type.STRING, description: 'Patient 10-digit phone number' },
        newDate: { type: Type.STRING, description: 'New date in YYYY-MM-DD format' },
        newStartTime: { type: Type.STRING, description: 'New start time in HH:mm format' },
      },
      required: ['newDate', 'newStartTime'],
    },
  },
  {
    name: 'cancel_appointment',
    description: 'Cancel an existing confirmed appointment.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        appointmentId: { type: Type.STRING, description: 'Existing appointment ID if known' },
        patientPhone: { type: Type.STRING, description: 'Patient 10-digit phone number' },
        reason: { type: Type.STRING, description: 'Reason for cancellation' },
      },
      required: [],
    },
  },
  {
    name: 'escalate_emergency',
    description: 'Trigger immediate emergency escalation if patient describes red-flag symptoms like severe chest pain, heart attack symptoms, stroke, or severe breathlessness.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        symptoms: { type: Type.STRING, description: 'Emergency symptoms described by caller' },
        patientPhone: { type: Type.STRING, description: 'Phone number of caller if known' },
      },
      required: ['symptoms'],
    },
  },
];

/**
 * Executes a clinical tool against the database and outbox
 */
export async function executeClinicalTool(
  name: string,
  args: Record<string, any>,
  callId: string
): Promise<{ result: any; actionTaken?: LiveTurnResult['actionTaken']; bookingData?: any; emergency?: boolean }> {
  const db = getDatabaseClient();

  if (name === 'get_clinic_doctors') {
    const doctors = await db.getDoctors();
    return { result: doctors, actionTaken: 'slots_checked' };
  }

  if (name === 'get_available_slots') {
    const { doctorId, date } = args;
    const targetDoc = doctorId || 'dr_sharma';
    const targetDate = date || new Date().toISOString().split('T')[0];
    const slots = await db.getAvailableSlots(targetDoc, targetDate);
    return { result: { doctorId: targetDoc, date: targetDate, availableSlots: slots }, actionTaken: 'slots_checked' };
  }

  if (name === 'book_appointment') {
    const { doctorId, date, startTime, patientName, patientPhone, reason } = args;
    const cleanPhone = String(patientPhone || '9876543210').replace(/\D/g, '').slice(-10);
    const targetDoc = doctorId || 'dr_sharma';
    const idempotencyKey = `idem_${callId}_${targetDoc}_${date}_${startTime}`;

    const bookingResult = await db.bookAppointment({
      doctorId: targetDoc,
      date,
      startTime,
      patientName: patientName || 'Patient',
      patientPhone: cleanPhone,
      idempotencyKey,
    });

    if (bookingResult.success && bookingResult.appointment) {
      if (reason) {
        bookingResult.appointment.reason = reason;
      }
      await emitOutboxEvent('new_appointment', bookingResult.appointment as any);
      return {
        result: bookingResult,
        actionTaken: 'booked',
        bookingData: bookingResult.appointment,
      };
    }
    return { result: bookingResult, actionTaken: 'none' };
  }

  if (name === 'reschedule_appointment') {
    const { appointmentId, patientPhone, newDate, newStartTime } = args;
    let targetId = appointmentId;
    if (!targetId && patientPhone) {
      const apts = await db.getAppointments();
      const cleanPhone = String(patientPhone).replace(/\D/g, '').slice(-10);
      const found = apts.find(
        (a: Appointment) => a.patientPhoneMasked.replace(/\D/g, '').endsWith(cleanPhone) && a.status === 'CONFIRMED'
      );
      if (found) targetId = found.id;
    }
    if (!targetId) {
      return { result: { success: false, error: 'Appointment not found for this phone number' }, actionTaken: 'none' };
    }
    const res = await db.rescheduleAppointment(targetId, newDate, newStartTime);
    if (res.success && res.appointment) {
      await emitOutboxEvent('appointment_rescheduled', res.appointment as any);
      return { result: res, actionTaken: 'rescheduled', bookingData: res.appointment };
    }
    return { result: res, actionTaken: 'none' };
  }

  if (name === 'cancel_appointment') {
    const { appointmentId, patientPhone, reason } = args;
    let targetId = appointmentId;
    if (!targetId && patientPhone) {
      const apts = await db.getAppointments();
      const cleanPhone = String(patientPhone).replace(/\D/g, '').slice(-10);
      const found = apts.find(
        (a: Appointment) => a.patientPhoneMasked.replace(/\D/g, '').endsWith(cleanPhone) && a.status === 'CONFIRMED'
      );
      if (found) targetId = found.id;
    }
    if (!targetId) {
      return { result: { success: false, error: 'Appointment not found for this phone number' }, actionTaken: 'none' };
    }
    const res = await db.cancelAppointment(targetId, reason || 'Cancelled by caller via live voice');
    if (res.success) {
      await emitOutboxEvent('appointment_cancelled', { appointmentId: targetId, reason });
      return { result: res, actionTaken: 'cancelled' };
    }
    return { result: res, actionTaken: 'none' };
  }

  if (name === 'escalate_emergency') {
    const { symptoms, patientPhone } = args;
    await emitOutboxEvent('emergency_escalated', {
      symptoms: symptoms || 'Severe emergency reported by caller',
      patientPhone: patientPhone || 'Caller',
      timestamp: new Date().toISOString(),
    });
    return {
      result: {
        emergency: true,
        hotline: '108 / 112',
        instructions: 'Emergency escalated to doctor. Advise patient to call 108/112 immediately.',
      },
      actionTaken: 'emergency',
      emergency: true,
    };
  }

  return { result: { error: `Unknown tool: ${name}` }, actionTaken: 'none' };
}

/**
 * Processes a live voice turn with Gemini API or Clinical Fallback
 */
export async function processLiveVoiceTurn(options: {
  userText: string;
  callId: string;
  history?: Array<{ role: 'user' | 'model'; parts: string }>;
  clinicProfile?: ClinicProfile;
  doctors?: Doctor[];
}): Promise<LiveTurnResult> {
  const { userText, callId, history = [], clinicProfile, doctors = [] } = options;
  const db = getDatabaseClient();
  const profile: ClinicProfile = clinicProfile || (db.getClinicProfile ? await db.getClinicProfile() : {
    clinicName: '',
    clinicPhone: '',
    clinicAddress: '',
    openingTime: '09:00',
    closingTime: '18:00',
    onboardingCompleted: false,
  });
  const docList = doctors.length > 0 ? doctors : await db.getDoctors();
  const clinicTitle = profile.clinicName || 'Clinic';
  const clinicAddressStr = profile.clinicAddress ? `Clinic Address: ${profile.clinicAddress}.` : '';
  const clinicPhoneStr = profile.clinicPhone ? `Helpline: ${profile.clinicPhone}.` : '';

  // Fast emergency check before any AI call
  const emergencyKeywords = ['chest pain', 'chhati me dard', 'heart attack', 'saas nahi', 'stroke', 'unconscious', 'behoshi', 'khoon nikal'];
  const isEmergency = emergencyKeywords.some((k) => userText.toLowerCase().includes(k));
  if (isEmergency) {
    await executeClinicalTool('escalate_emergency', { symptoms: userText }, callId);
    return {
      replyText: 'Yeh emergency lag rahi hai! Kripya turant 108 ya 112 par call karein aur nazdeeki hospital ke emergency ward pahunchein. Doctor ko alert bhej diya gaya hai.',
      actionTaken: 'emergency',
      emergency: true,
      modelUsed: 'indic-clinical-engine',
    };
  }

  const gemini = getGeminiClient();
  if (gemini) {
    try {
      const todayStr = new Date().toISOString().split('T')[0];
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowStr = tomorrow.toISOString().split('T')[0];

      const docDescriptions = docList
        .map((d) => `- ${d.name} (${d.specialty}), ID: ${d.id}, Fee: ₹${d.fee}, Hours: ${d.workingHoursStart}-${d.workingHoursEnd}, Days: ${d.activeDays.join(', ')}`)
        .join('\n');

      const systemInstruction = `You are the friendly, professional AI Voice Receptionist for "${clinicTitle}".
${clinicAddressStr} ${clinicPhoneStr}
Operating Hours: ${profile.openingTime} to ${profile.closingTime}.
Today's date is ${todayStr}. Tomorrow is ${tomorrowStr}.

Available Clinic Doctors:
${docDescriptions}

CRITICAL RULES:
1. Speak in warm, polite Hinglish (Hindi + English blend) suitable for an Indian clinic.
2. If patient wants to book, ask which doctor, date, preferred time, patient full name, and phone number.
3. Check availability using get_available_slots before booking.
4. When booking details are confirmed, call book_appointment. NEVER invent bookings without calling book_appointment.
5. If caller wants to reschedule or cancel, call reschedule_appointment or cancel_appointment.
6. Keep answers concise (1-2 sentences) so they sound natural over a live voice phone call.
7. Do not give medical diagnoses. If red-flag symptoms are mentioned, call escalate_emergency immediately.`;

      // Build contents array
      const contents: any[] = [];
      for (const h of history) {
        contents.push({
          role: h.role,
          parts: [{ text: h.parts }],
        });
      }
      contents.push({
        role: 'user',
        parts: [{ text: userText }],
      });

      const response = await gemini.models.generateContent({
        model: 'gemini-2.5-flash',
        contents,
        config: {
          systemInstruction,
          tools: [{ functionDeclarations: GEMINI_TOOL_DECLARATIONS }],
          temperature: 0.2,
        },
      });

      // Check if Gemini invoked a function/tool
      const functionCalls = response.functionCalls;
      if (functionCalls && functionCalls.length > 0) {
        const firstCall = functionCalls[0];
        rootLogger.info(`[Gemini] Model requested tool: ${firstCall.name}`, firstCall.args);

        const toolName = firstCall.name || '';
        const toolExec = await executeClinicalTool(toolName, (firstCall.args as any) || {}, callId);

        // Send tool output back to Gemini to get final spoken reply
        const toolFollowup = await gemini.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: [
            ...contents,
            {
              role: 'model',
              parts: [{ functionCall: firstCall }],
            },
            {
              role: 'user',
              parts: [
                {
                  functionResponse: {
                    name: firstCall.name,
                    response: { result: toolExec.result },
                  },
                },
              ],
            },
          ],
          config: {
            systemInstruction,
            temperature: 0.2,
          },
        });

        const replyText = toolFollowup.text || 'Ji, aapki request process ho gayi hai.';
        return {
          replyText,
          actionTaken: toolExec.actionTaken,
          bookingData: toolExec.bookingData,
          emergency: toolExec.emergency,
          modelUsed: 'gemini-2.5-flash',
        };
      }

      if (response.text) {
        return {
          replyText: response.text,
          actionTaken: 'none',
          modelUsed: 'gemini-2.5-flash',
        };
      }
    } catch (err: any) {
      rootLogger.warn('[Gemini] Error calling Gemini API, falling back to Indic clinical engine:', err.message || err);
    }
  }

  // Fallback: Deterministic Indic Clinical Engine
  return processClinicalFallback(userText, docList, profile, callId);
}

/**
 * Deterministic Indic Clinical Rule Engine for guaranteed 0-latency offline handling
 */
async function processClinicalFallback(
  text: string,
  doctors: Doctor[],
  profile: ClinicProfile,
  callId: string
): Promise<LiveTurnResult> {
  const db = getDatabaseClient();
  const lower = text.toLowerCase();
  const dbDocs = await db.getDoctors();
  const primaryDoc = doctors[0] || dbDocs[0] || {
    id: 'doc_1',
    name: 'Doctor',
    specialty: 'General Physician',
    workingHoursStart: profile.openingTime || '09:00',
    workingHoursEnd: profile.closingTime || '18:00',
    durationMinutes: 30,
    fee: 500,
    activeDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    availableSlots: ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00'],
  };

  const clinicTitle = profile.clinicName || 'Clinic';
  const clinicLocStr = profile.clinicAddress ? ` Clinic ka pata hai ${profile.clinicAddress}.` : '';

  const today = new Date().toISOString().split('T')[0];
  const tomorrowDate = new Date();
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrow = tomorrowDate.toISOString().split('T')[0];

  const targetDate = lower.includes('aaj') || lower.includes('today') ? today : tomorrow;

  // 1. Reschedule Intent
  if (lower.includes('reschedule') || lower.includes('badalna') || lower.includes('change')) {
    const slots = await db.getAvailableSlots(primaryDoc.id, targetDate);
    const newSlot = slots[0] || '11:00';
    const apts = await db.getAppointments();
    const existing = apts.find((a: Appointment) => a.status === 'CONFIRMED');
    if (existing) {
      const res = await db.rescheduleAppointment(existing.id, targetDate, newSlot);
      if (res.success) {
        await emitOutboxEvent('appointment_rescheduled', res.appointment as any);
        return {
          replyText: `Aapki appointment Dr. ${primaryDoc.name.replace('Dr. ', '')} ke sath ${targetDate} ko ${newSlot} baje reschedule ho gayi hai.`,
          actionTaken: 'rescheduled',
          bookingData: res.appointment,
          modelUsed: 'indic-clinical-engine',
        };
      }
    }
    return {
      replyText: `Ji, reschedule karne ke liye ${targetDate} ko ${slots.slice(0, 3).join(', ')} ke slots uplabdh hain. Aapka phone number kya hai?`,
      actionTaken: 'slots_checked',
      modelUsed: 'indic-clinical-engine',
    };
  }

  // 2. Cancel Intent
  if (lower.includes('cancel') || lower.includes('radd') || lower.includes('nahi aana')) {
    const apts = await db.getAppointments();
    const existing = apts.find((a: Appointment) => a.status === 'CONFIRMED');
    if (existing) {
      await db.cancelAppointment(existing.id, 'Patient cancelled via call');
      await emitOutboxEvent('appointment_cancelled', { appointmentId: existing.id, reason: 'Patient cancelled' });
      return {
        replyText: `Aapki appointment cancel kar di gayi hai. Agar aapko dobara book karna ho to bataiye.`,
        actionTaken: 'cancelled',
        modelUsed: 'indic-clinical-engine',
      };
    }
    return {
      replyText: `Aapki koi active appointment nahi mili. Kripya apna registered phone number bataiye.`,
      actionTaken: 'none',
      modelUsed: 'indic-clinical-engine',
    };
  }

  // 3. Timing / Doctor Inquiry
  if (lower.includes('timing') || lower.includes('samay') || lower.includes('kab') || lower.includes('doctor')) {
    const docNames = doctors.map((d) => `${d.name} (${d.specialty})`).join(', ');
    return {
      replyText: `${clinicTitle} subah ${profile.openingTime || '09:00'} se shaam ${profile.closingTime || '18:00'} tak open hai.${docNames ? ' Hamare yahan ' + docNames + ' uplabdh hain.' : ''} Aapko kab appointment chahiye?`,
      actionTaken: 'none',
      modelUsed: 'indic-clinical-engine',
    };
  }

  // 4. Booking Request
  const slots = await db.getAvailableSlots(primaryDoc.id, targetDate);
  const timeMatch = lower.match(/(\d{1,2})(:(\d{2}))?\s*(am|pm|baje)?/i);
  let requestedTime = slots[0] || '10:00';

  if (timeMatch) {
    let hour = parseInt(timeMatch[1], 10);
    const isPm = lower.includes('shaam') || lower.includes('pm') || lower.includes('dopahar');
    if (isPm && hour < 12) hour += 12;
    const formatted = `${String(hour).padStart(2, '0')}:00`;
    if (slots.includes(formatted)) {
      requestedTime = formatted;
    }
  }

  // Extract patient name or default
  let patientName = 'Amit Kumar';
  if (lower.includes('mera naam')) {
    const match = text.match(/mera naam ([a-zA-Z\s]+?)(?:hai|aur|\.|$)/i);
    if (match) patientName = match[1].trim();
  }

  // Extract phone or default
  let patientPhone = '9876543210';
  const phoneMatch = text.match(/\b\d{10}\b/);
  if (phoneMatch) patientPhone = phoneMatch[0];

  const booking = await db.bookAppointment({
    doctorId: primaryDoc.id,
    date: targetDate,
    startTime: requestedTime,
    patientName,
    patientPhone,
    idempotencyKey: `idem_fallback_${callId}_${primaryDoc.id}_${targetDate}_${requestedTime}`,
  });

  if (booking.success && booking.appointment) {
    await emitOutboxEvent('new_appointment', booking.appointment as any);
    return {
      replyText: `Aapki appointment ${primaryDoc.name} ke sath ${targetDate} ko ${requestedTime} baje book ho gayi hai.${clinicLocStr} Kripya 10 minute pehle pahunchein.`,
      actionTaken: 'booked',
      bookingData: booking.appointment,
      modelUsed: 'indic-clinical-engine',
    };
  }

  return {
    replyText: `Namaste! ${clinicTitle} mein aapka swagat hai. Main AI receptionist bol rahi hoon. Aapko kis doctor ke paas appointment chahiye?`,
    actionTaken: 'none',
    modelUsed: 'indic-clinical-engine',
  };
}
