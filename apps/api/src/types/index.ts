/**
 * Core Domain Types for Appointly
 */

export type AppointmentStatus = 'CONFIRMED' | 'CANCELLED' | 'COMPLETED' | 'RESCHEDULED';
export type CallbackStatus = 'PENDING' | 'RESOLVED';
export type AiServiceType = 'PRISMA_STT' | 'TIMBRE_TTS' | 'EVON_LLM';

export interface Doctor {
  id: string;
  name: string;
  specialty: string;
  workingHoursStart: string; // HH:mm, e.g. "09:00" or "17:00"
  workingHoursEnd: string; // HH:mm, e.g. "18:00" or "22:00"
  durationMinutes: number;
  fee: number;
  activeDays: string[]; // e.g. ["Monday", "Tuesday", ...]
  availableSlots: string[]; // e.g. ["09:00", "09:30", "10:00"]
}

export interface Appointment {
  id: string;
  doctorId: string;
  doctorName?: string;
  patientName: string;
  patientPhoneMasked: string;
  appointmentDate: string; // YYYY-MM-DD
  startTime: string; // HH:mm
  endTime: string; // HH:mm
  durationMinutes: number;
  status: AppointmentStatus;
  idempotencyKey: string;
  visitType?: string;
  reason?: string;
  aiSummary?: string;
  createdAt: Date;
}

export interface CallbackRequest {
  id: string;
  callId: string;
  patientPhoneMasked: string;
  preferredSlot?: string;
  reason: string;
  status: CallbackStatus;
  createdAt: Date;
}

export interface CreditUsageRecord {
  id: string;
  callId: string;
  service: AiServiceType;
  unitsConsumed: number; // seconds for STT, chars for TTS, tokens for LLM
  estimatedCredits: number;
  timestamp: Date;
}

export interface EmergencyCheckResult {
  isEmergency: boolean;
  matchedKeywords: string[];
  escalationMessage: string;
}

export interface BookingRequestInput {
  doctorId: string;
  date: string; // YYYY-MM-DD
  startTime: string; // HH:mm
  patientName: string;
  patientPhone: string;
  idempotencyKey: string;
}

export interface BookingResult {
  success: boolean;
  appointment?: Appointment;
  error?:
    | 'SLOT_ALREADY_BOOKED'
    | 'INVALID_DOCTOR'
    | 'INVALID_SLOT'
    | 'DATABASE_ERROR'
    | 'IDEMPOTENT_REPLAY'
    | 'OUTSIDE_WORKING_HOURS';
  message: string;
}

export interface CallSessionContext {
  callId: string;
  patientPhoneMasked?: string;
  step:
    | 'GREETING'
    | 'SELECTING_DOCTOR'
    | 'SELECTING_SLOT'
    | 'CONFIRMING'
    | 'BOOKED'
    | 'EMERGENCY'
    | 'CALLBACK_OFFERED';
  selectedDoctor?: Doctor;
  selectedDate?: string;
  selectedSlot?: string;
  patientName?: string;
  totalCreditsUsed: number;
  createdAt: Date;
}
