/**
 * Zod-Validated Server-Side Tools for Appointly Voice Agent
 * Non-negotiable Rules:
 * 1. The LLM never writes to the database. It only calls these validated tools.
 * 2. Every tool argument is validated server-side with Zod (Prompt-injection defense).
 * 3. Booking is decided strictly by a DB transaction.
 * 4. Structured JSON logs with callId/requestId; never log raw PII.
 */

import { z } from 'zod';
import crypto from 'crypto';
import { getBookingCoreService } from '../services/booking-service.js';
import { getDatabaseClient } from '../db/index.js';
import { kolkataToUtc, formatKolkata } from '../utils/timezone.js';
import { maskPhone, rootLogger } from '../logger/logger.js';
import { ToolDefinition } from '../services/evon-llm-client.js';

// ==========================================
// 1. ZOD SCHEMAS
// ==========================================

export const checkSlotsArgsSchema = z.object({
  doctorId: z.string().min(1, 'doctorId is required'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  appointmentTypeId: z.string().optional().default('general_consultation'),
});

export const holdSlotArgsSchema = z.object({
  doctorId: z.string().min(1, 'doctorId is required'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'startTime must be HH:mm'),
  patientPhone: z
    .string()
    .regex(/^[6-9]\d{9}$/, 'patientPhone must be a valid 10-digit Indian number'),
});

export const bookAppointmentArgsSchema = z.object({
  doctorId: z.string().min(1, 'doctorId is required'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'startTime must be HH:mm'),
  patientName: z.string().min(2, 'patientName must be at least 2 chars').max(100),
  patientPhone: z
    .string()
    .regex(/^[6-9]\d{9}$/, 'patientPhone must be a valid 10-digit Indian number'),
  appointmentTypeId: z.string().optional().default('general_consultation'),
  holdId: z.string().optional(),
  idempotencyKey: z.string().optional(),
});

export const rescheduleAppointmentArgsSchema = z.object({
  appointmentId: z.string().min(1, 'appointmentId is required'),
  newDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'newDate must be YYYY-MM-DD'),
  newStartTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'newStartTime must be HH:mm'),
  patientPhone: z.string().regex(/^[6-9]\d{9}$/, 'patientPhone must be 10 digits'),
  idempotencyKey: z.string().optional(),
});

export const cancelAppointmentArgsSchema = z.object({
  appointmentId: z.string().min(1, 'appointmentId is required'),
  patientPhone: z.string().regex(/^[6-9]\d{9}$/, 'patientPhone must be 10 digits'),
  cancellationReason: z.string().optional(),
});

export const escalateToHumanArgsSchema = z.object({
  reason: z.enum(['EMERGENCY_MEDICAL', 'COMPLEX_INQUIRY', 'PATIENT_REQUEST', 'SYSTEM_ERROR']),
  patientPhone: z.string().optional(),
  notes: z.string().optional(),
});

export const saveCallbackRequestArgsSchema = z.object({
  patientPhone: z.string().regex(/^[6-9]\d{9}$/, 'patientPhone must be 10 digits'),
  patientName: z.string().optional(),
  reason: z.string().min(1, 'reason is required'),
  preferredTime: z.string().optional(),
});

export const releaseHoldArgsSchema = z.object({
  holdId: z.string().min(1, 'holdId is required'),
});

// ==========================================
// 2. EVON / OPENAI TOOL DEFINITIONS
// ==========================================

export const AGENT_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'check_slots',
      description:
        'Check available open appointment slots for a doctor on a specific date (YYYY-MM-DD).',
      parameters: {
        type: 'object',
        properties: {
          doctorId: {
            type: 'string',
            description: 'ID of the doctor, e.g. dr_sharma, dr_priya, dr_rajesh',
          },
          date: { type: 'string', description: 'Target date in YYYY-MM-DD format' },
          appointmentTypeId: {
            type: 'string',
            description: 'Type of appointment (default: general_consultation)',
          },
        },
        required: ['doctorId', 'date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hold_slot',
      description: 'Temporarily hold an appointment slot for 2 minutes while patient confirms.',
      parameters: {
        type: 'object',
        properties: {
          doctorId: { type: 'string', description: 'ID of the doctor' },
          date: { type: 'string', description: 'Date in YYYY-MM-DD format' },
          startTime: { type: 'string', description: 'Start time in HH:mm format, e.g. 17:00' },
          patientPhone: { type: 'string', description: '10-digit Indian phone number' },
        },
        required: ['doctorId', 'date', 'startTime', 'patientPhone'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'book_appointment',
      description:
        'Commit an appointment booking atomically in the clinic database. Only called when patient confirms.',
      parameters: {
        type: 'object',
        properties: {
          doctorId: { type: 'string', description: 'ID of the doctor' },
          date: { type: 'string', description: 'Date in YYYY-MM-DD format' },
          startTime: { type: 'string', description: 'Start time in HH:mm format, e.g. 17:00' },
          patientName: { type: 'string', description: 'Full name of the patient' },
          patientPhone: { type: 'string', description: '10-digit Indian phone number' },
          appointmentTypeId: { type: 'string', description: 'Optional appointment type' },
          holdId: { type: 'string', description: 'Optional active hold ID' },
        },
        required: ['doctorId', 'date', 'startTime', 'patientName', 'patientPhone'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reschedule_appointment',
      description: 'Reschedule an existing confirmed appointment to a new date and time.',
      parameters: {
        type: 'object',
        properties: {
          appointmentId: { type: 'string', description: 'Existing appointment ID' },
          newDate: { type: 'string', description: 'New date in YYYY-MM-DD format' },
          newStartTime: { type: 'string', description: 'New start time in HH:mm format' },
          patientPhone: { type: 'string', description: '10-digit patient phone number' },
        },
        required: ['appointmentId', 'newDate', 'newStartTime', 'patientPhone'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_appointment',
      description:
        'Cancel an existing confirmed appointment and release the slot back to the clinic.',
      parameters: {
        type: 'object',
        properties: {
          appointmentId: { type: 'string', description: 'Existing appointment ID' },
          patientPhone: { type: 'string', description: '10-digit patient phone number' },
          cancellationReason: { type: 'string', description: 'Reason for cancellation' },
        },
        required: ['appointmentId', 'patientPhone'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'escalate_to_human',
      description:
        'Escalate to human clinic staff or emergency services when patient needs assistance beyond booking.',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            enum: ['EMERGENCY_MEDICAL', 'COMPLEX_INQUIRY', 'PATIENT_REQUEST', 'SYSTEM_ERROR'],
          },
          patientPhone: { type: 'string', description: 'Patient phone number if known' },
          notes: { type: 'string', description: 'Context notes for clinic staff' },
        },
        required: ['reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_callback_request',
      description:
        'Save a callback request when slots are unavailable or system is in fallback mode.',
      parameters: {
        type: 'object',
        properties: {
          patientPhone: { type: 'string', description: '10-digit patient phone number' },
          patientName: { type: 'string', description: 'Patient name if known' },
          reason: { type: 'string', description: 'Reason for callback request' },
          preferredTime: { type: 'string', description: 'Preferred contact time' },
        },
        required: ['patientPhone', 'reason'],
      },
    },
  },
];

// ==========================================
// 3. SERVER-SIDE TOOL EXECUTORS
// ==========================================

export interface ToolExecutionContext {
  callId: string;
}

export interface ToolExecutionResponse {
  success: boolean;
  data?: unknown;
  error?: string;
  userMessage?: string;
}

export async function executeAgentTool(
  toolName: string,
  rawArgs: unknown,
  context: ToolExecutionContext
): Promise<ToolExecutionResponse> {
  const { callId } = context;
  const bookingService = getBookingCoreService();
  const db = getDatabaseClient();

  rootLogger.info(`[AgentTool] Executing tool: ${toolName}`, {
    callId,
    toolName,
  });

  try {
    switch (toolName) {
      case 'check_slots': {
        const parseRes = checkSlotsArgsSchema.safeParse(rawArgs);
        if (!parseRes.success) {
          return {
            success: false,
            error: `INVALID_ARGUMENTS: ${parseRes.error.issues.map((i) => i.message).join(', ')}`,
          };
        }
        const { doctorId, date, appointmentTypeId } = parseRes.data;
        const slotsResult = await bookingService.checkSlots(doctorId, date, appointmentTypeId);

        return {
          success: true,
          data: {
            doctorId: slotsResult.doctor.id,
            doctorName: slotsResult.doctor.name,
            specialty: slotsResult.doctor.specialty,
            date: slotsResult.dateKolkata,
            workingHours: `${slotsResult.doctor.workingHoursStart} - ${slotsResult.doctor.workingHoursEnd}`,
            availableSlots: slotsResult.availableSlots.map((s) => s.timeKolkata),
            totalAvailable: slotsResult.availableSlots.length,
            durationMinutes: slotsResult.appointmentType.durationMin,
          },
        };
      }

      case 'hold_slot': {
        const parseRes = holdSlotArgsSchema.safeParse(rawArgs);
        if (!parseRes.success) {
          return {
            success: false,
            error: `INVALID_ARGUMENTS: ${parseRes.error.issues.map((i) => i.message).join(', ')}`,
          };
        }
        const { doctorId, date, startTime, patientPhone } = parseRes.data;
        const slotStartUtc = kolkataToUtc(date, startTime);

        const holdRes = await bookingService.holdSlot({
          doctorId,
          date,
          startTime,
          slotStart: slotStartUtc,
          patientPhone,
        });

        if (!holdRes.success || !holdRes.holdToken) {
          return {
            success: false,
            error: holdRes.error || 'HOLD_FAILED',
            userMessage: 'Yeh slot hold nahi ho paya. Kripya doosra samay chunein.',
          };
        }

        return {
          success: true,
          data: {
            holdId: holdRes.holdToken,
            holdToken: holdRes.holdToken,
            doctorId,
            slotStart: startTime,
            expiresAt: holdRes.expiresAt ? formatKolkata(holdRes.expiresAt).displayTime : undefined,
          },
        };
      }

      case 'release_hold': {
        const parseRes = releaseHoldArgsSchema.safeParse(rawArgs);
        if (!parseRes.success) {
          return {
            success: false,
            error: `INVALID_ARGUMENTS: ${parseRes.error.issues.map((i) => i.message).join(', ')}`,
          };
        }
        const { holdId } = parseRes.data;
        const released = await bookingService.releaseHold(holdId);
        return {
          success: released,
          data: { released, holdId },
          userMessage: 'Slot hold release kar diya gaya hai.',
        };
      }

      case 'book_appointment': {
        const parseRes = bookAppointmentArgsSchema.safeParse(rawArgs);
        if (!parseRes.success) {
          return {
            success: false,
            error: `INVALID_ARGUMENTS: ${parseRes.error.issues.map((i) => i.message).join(', ')}`,
          };
        }
        const {
          doctorId,
          date,
          startTime,
          patientName,
          patientPhone,
          appointmentTypeId,
          holdId,
          idempotencyKey,
        } = parseRes.data;

        const slotStartUtc = kolkataToUtc(date, startTime);
        const finalIdempotencyKey =
          idempotencyKey || `idem_${callId}_${doctorId}_${date}_${startTime}`;

        const bookRes = await bookingService.bookAppointment({
          doctorId,
          date,
          startTime,
          slotStart: slotStartUtc,
          patientName,
          patientPhone,
          appointmentTypeId,
          holdToken: holdId,
          idempotencyKey: finalIdempotencyKey,
        });

        if (!bookRes.success || !bookRes.appointment) {
          let userMsg = 'Appointment book nahi ho payi.';
          if (bookRes.error === 'OUTSIDE_WORKING_HOURS') {
            userMsg = 'Yeh samay doctor ke OPD hours se bahar hai.';
          } else if (bookRes.error === 'SLOT_ALREADY_BOOKED') {
            userMsg = 'Yeh slot pehle se book ho chuka hai. Kripya doosra samay chunein.';
          }
          return {
            success: false,
            error: bookRes.error || 'BOOKING_FAILED',
            userMessage: userMsg,
          };
        }

        const appt = bookRes.appointment;
        return {
          success: true,
          data: {
            appointmentId: appt.id,
            doctorName: appt.doctorName,
            doctorId: appt.doctorId,
            date: appt.appointmentDate || appt.displayDateKolkata,
            startTime: appt.startTime,
            durationMinutes: appt.durationMinutes || appt.durationMin,
            patientName: appt.patientName,
            patientPhoneMasked: maskPhone(patientPhone),
            status: appt.status,
          },
          userMessage: `Aapki appointment Dr. ${appt.doctorName} ke saath ${appt.appointmentDate} ko ${appt.startTime} baje confirm ho gayi hai. Duration: ${appt.durationMinutes} minute.`,
        };
      }

      case 'reschedule_appointment': {
        const parseRes = rescheduleAppointmentArgsSchema.safeParse(rawArgs);
        if (!parseRes.success) {
          return {
            success: false,
            error: `INVALID_ARGUMENTS: ${parseRes.error.issues.map((i) => i.message).join(', ')}`,
          };
        }
        const { appointmentId, newDate, newStartTime, patientPhone, idempotencyKey } =
          parseRes.data;
        const newSlotStartUtc = kolkataToUtc(newDate, newStartTime);
        const finalIdempotencyKey =
          idempotencyKey || `resched_${callId}_${appointmentId}_${newDate}_${newStartTime}`;

        const reschedRes = await bookingService.rescheduleAppointment(
          appointmentId,
          newDate,
          newStartTime,
          finalIdempotencyKey
        );

        if (!reschedRes.success || !reschedRes.appointment) {
          return {
            success: false,
            error: reschedRes.error || 'RESCHEDULE_FAILED',
            userMessage: 'Appointment reschedule nahi ho saki. Kripya samay dobara chunein.',
          };
        }

        const appt = reschedRes.appointment;
        return {
          success: true,
          data: {
            appointmentId: appt.id,
            doctorName: appt.doctorName,
            newDate: appt.appointmentDate || appt.displayDateKolkata,
            newStartTime: appt.startTime,
            durationMinutes: appt.durationMinutes || appt.durationMin,
          },
          userMessage: `Aapki appointment successfully reschedule ho gayi hai. Naya samay: Dr. ${appt.doctorName}, ${appt.appointmentDate} ko ${appt.startTime} baje. Duration: ${appt.durationMinutes} minute.`,
        };
      }

      case 'cancel_appointment': {
        const parseRes = cancelAppointmentArgsSchema.safeParse(rawArgs);
        if (!parseRes.success) {
          return {
            success: false,
            error: `INVALID_ARGUMENTS: ${parseRes.error.issues.map((i) => i.message).join(', ')}`,
          };
        }
        const { appointmentId, cancellationReason } = parseRes.data;

        const cancelRes = await bookingService.cancelAppointment(
          appointmentId,
          cancellationReason || 'Cancelled by patient via voice agent'
        );

        if (!cancelRes.success) {
          return {
            success: false,
            error: cancelRes.error || 'CANCEL_FAILED',
            userMessage:
              'Appointment cancel nahi ho payi. Kripya check karein ki details sahi hain.',
          };
        }

        return {
          success: true,
          data: {
            appointmentId,
            status: 'CANCELLED',
          },
          userMessage:
            'Aapki appointment cancel kar di gayi hai. Agar aapko dobara book karna ho toh zaroor batayein.',
        };
      }

      case 'escalate_to_human': {
        const parseRes = escalateToHumanArgsSchema.safeParse(rawArgs);
        if (!parseRes.success) {
          return {
            success: false,
            error: `INVALID_ARGUMENTS: ${parseRes.error.issues.map((i) => i.message).join(', ')}`,
          };
        }
        const { reason, patientPhone, notes } = parseRes.data;

        rootLogger.warn(`[Escalation] Human intervention requested`, {
          callId,
          reason,
          patientPhoneMasked: patientPhone ? maskPhone(patientPhone) : undefined,
          notes,
        });

        if (reason === 'EMERGENCY_MEDICAL') {
          return {
            success: true,
            data: { target: '108_EMERGENCY', reason },
            userMessage:
              'Kripya turant 108 dial karein ya nazdeeki hospital ke emergency room jayein.',
          };
        }

        return {
          success: true,
          data: { target: 'CLINIC_RECEPTION', reason },
          userMessage:
            'Main aapki call clinic staff ko transfer kar rahi hoon. Kripya line par bane rahein.',
        };
      }

      case 'save_callback_request': {
        const parseRes = saveCallbackRequestArgsSchema.safeParse(rawArgs);
        if (!parseRes.success) {
          return {
            success: false,
            error: `INVALID_ARGUMENTS: ${parseRes.error.issues.map((i) => i.message).join(', ')}`,
          };
        }
        const { patientPhone, patientName, reason, preferredTime } = parseRes.data;

        const cbRecord = await db.saveCallbackRequest(
          callId,
          patientPhone,
          `[VoiceAgent] ${reason} (Preferred: ${preferredTime || 'ASAP'}, Name: ${patientName || 'Anonymous'})`
        );

        return {
          success: true,
          data: {
            callbackId: cbRecord.id,
            patientPhoneMasked: maskPhone(patientPhone),
          },
          userMessage:
            'Humne aapka callback request note kar liya hai. Clinic staff jald hi aapse sampark karega.',
        };
      }

      default:
        return {
          success: false,
          error: `UNKNOWN_TOOL: "${toolName}" is not recognized`,
        };
    }
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    rootLogger.error(`[AgentTool] Error executing ${toolName}: ${errorMsg}`, {
      callId,
      toolName,
      error: errorMsg,
    });
    return {
      success: false,
      error: errorMsg,
      userMessage: 'System mein takneeki dikkat aayi hai. Kripya thodi der baad koshish karein.',
    };
  }
}
