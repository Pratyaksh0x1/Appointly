/**
 * Doctor Call Summary Generator
 *
 * Generates a structured clinical summary after each call:
 * - Patient: Name & masked phone
 * - Concern: In the patient's own words without medical diagnosis (Strict Rule 4!)
 * - Preferred Time: Time requested by caller
 * - Outcome: BOOKED | RESCHEDULED | CANCELLED | CALLBACK_SAVED | EMERGENCY_ESCALATED | CALL_DROPPED | INQUIRY_ONLY
 * - AI Summary: High-level operational summary for the doctor dashboard
 */

import { DoctorCallSummary, CallOutcome } from '../types/index.js';
import { maskPhone, maskName, redactPiiFromTranscript, rootLogger } from '../logger/logger.js';
import { getDatabaseClient } from '../db/index.js';

export interface GenerateSummaryParams {
  callId: string;
  patientName?: string;
  patientPhone: string;
  history: { role: 'user' | 'assistant' | 'system'; content: string }[];
  state: string;
  intent: string;
  doctorId?: string;
  doctorName?: string;
  appointmentId?: string;
  targetDate?: string;
  targetTime?: string;
  cancellationReason?: string;
  callbackReason?: string;
  isEmergency?: boolean;
}

export function extractPatientConcernInOwnWords(
  history: { role: string; content: string }[]
): string {
  const userMessages = history
    .filter((h) => h.role === 'user')
    .map((h) => h.content.trim())
    .filter((t) => t.length > 0);

  if (userMessages.length === 0) {
    return 'No verbal concern expressed by caller.';
  }

  // Look for symptom or concern expressions
  const symptomKeywords = [
    'dard',
    'pain',
    'bukhar',
    'fever',
    'khansi',
    'cough',
    'cold',
    'jukham',
    'gala',
    'throat',
    'allergy',
    'skin',
    'rash',
    'headache',
    'sir dard',
    'pet dard',
    'stomach',
    'vomit',
    'ulti',
    'saans',
    'breath',
    'checkup',
    'consultation',
    'routine',
  ];

  for (const msg of userMessages) {
    const lower = msg.toLowerCase();
    for (const kw of symptomKeywords) {
      if (lower.includes(kw)) {
        // Return patient words with PII scrubbed, and explicit non-diagnostic notice
        const cleanMsg = redactPiiFromTranscript(msg);
        return `"${cleanMsg}" (Caller's verbatim words; non-diagnostic)`;
      }
    }
  }

  // Default to first substantive user statement
  const firstSubstantive = userMessages.find((m) => m.length > 4) || userMessages[0];
  const cleanFirst = redactPiiFromTranscript(firstSubstantive);
  return `"${cleanFirst}" (Caller's verbatim statement; non-diagnostic)`;
}

export function determineCallOutcome(params: GenerateSummaryParams): CallOutcome {
  if (params.isEmergency || params.state === 'ESCALATE') {
    return 'EMERGENCY_ESCALATED';
  }
  if (params.state === 'BOOKED') {
    if (params.intent === 'RESCHEDULE') {
      return 'RESCHEDULED';
    }
    return 'BOOKED';
  }
  if (params.state === 'CANCEL') {
    return 'CANCELLED';
  }
  if (params.state === 'FALLBACK' || params.callbackReason) {
    return 'CALLBACK_SAVED';
  }
  if (params.intent === 'QUERY_HOURS') {
    return 'INQUIRY_ONLY';
  }
  if (params.history.filter((h) => h.role === 'user').length === 0) {
    return 'PATIENT_SILENT_DISCONNECT';
  }
  // If call ended in an intermediate state before booking was confirmed
  if (
    [
      'GREETING_CONSENT',
      'UNDERSTAND_INTENT',
      'COLLECT_DETAILS',
      'OFFER_SLOTS',
      'CONFIRM_READBACK',
    ].includes(params.state)
  ) {
    return 'CALL_DROPPED';
  }
  return 'INQUIRY_ONLY';
}

export async function generateAndSaveCallSummary(
  params: GenerateSummaryParams
): Promise<DoctorCallSummary> {
  const patientName = params.patientName || 'Patient (Unspecified)';
  const patientPhoneMasked = maskPhone(params.patientPhone);
  const concern = extractPatientConcernInOwnWords(params.history);
  const outcome = determineCallOutcome(params);

  const preferredTime =
    params.targetDate && params.targetTime
      ? `${params.targetDate} at ${params.targetTime}`
      : params.targetDate || params.targetTime || 'Not specified';

  let aiSummaryText = '';
  const docRef = params.doctorName ? `with ${params.doctorName}` : 'at Arogya Clinic';

  switch (outcome) {
    case 'BOOKED':
      aiSummaryText = `Caller ${patientName} requested OPD consultation ${docRef}. Successfully confirmed for ${preferredTime}. Patient concern: ${concern}.`;
      break;
    case 'RESCHEDULED':
      aiSummaryText = `Caller ${patientName} rescheduled prior booking ${docRef} to ${preferredTime}.`;
      break;
    case 'CANCELLED':
      aiSummaryText = `Caller ${patientName} verified identity and cancelled existing booking ${docRef}. Reason: ${params.cancellationReason || 'Patient request'}. Slot released.`;
      break;
    case 'EMERGENCY_ESCALATED':
      aiSummaryText = `CRITICAL: Caller reported acute distress (${concern}). Agent immediately triggered 108 Emergency Medical Protocol. No diagnosis attempted.`;
      break;
    case 'CALLBACK_SAVED':
      aiSummaryText = `Caller ${patientName} could not find preferred slot (${preferredTime}) or encountered service fallback. Callback ticket saved for reception team.`;
      break;
    case 'CALL_DROPPED':
      aiSummaryText = `Call ended before confirmation was committed (state: ${params.state}). Active temporary slot hold expired with zero ghost booking.`;
      break;
    case 'PATIENT_SILENT_DISCONNECT':
      aiSummaryText = `Caller remained silent after multiple voice prompts. Call closed gracefully with no holds or bookings made.`;
      break;
    default:
      aiSummaryText = `General inquiry call regarding clinic timings or doctor fees.`;
      break;
  }

  const summary: DoctorCallSummary = {
    id: `sum_${params.callId}`,
    callId: params.callId,
    patientName,
    patientPhoneMasked,
    concern,
    preferredTime,
    outcome,
    aiSummary: aiSummaryText,
    doctorId: params.doctorId,
    doctorName: params.doctorName,
    appointmentId: params.appointmentId,
    createdAt: new Date(),
  };

  rootLogger.info(`[CallSummary] Generated doctor summary for call ${params.callId}`, {
    callId: params.callId,
    patient: patientName,
    outcome,
    preferredTime,
  });

  try {
    const db = getDatabaseClient();
    await db.saveCallSummary(summary);
  } catch (err) {
    rootLogger.error(`[CallSummary] Error persisting summary for call ${params.callId}:`, err);
  }

  return summary;
}
