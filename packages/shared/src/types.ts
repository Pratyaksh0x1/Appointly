/**
 * Core Domain Types for Appointly
 * Phase 2 Relational Data Models & Booking Core
 */

export type AppointmentStatus = 'CONFIRMED' | 'CANCELLED' | 'COMPLETED';
export type SlotHoldStatus = 'ACTIVE' | 'RELEASED' | 'EXPIRED' | 'CONVERTED';
export type CallStatus = 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'ESCALATED';
export type OutboxStatus = 'PENDING' | 'PROCESSED' | 'FAILED';
export type CallbackStatus = 'PENDING' | 'RESOLVED';
export type AiServiceType = 'PRISMA_STT' | 'TIMBRE_TTS' | 'EVON_LLM';

export interface Doctor {
  id: string;
  name: string;
  specialty: string;
  workingHoursStart: string; // HH:mm in Asia/Kolkata, e.g. "09:00"
  workingHoursEnd: string; // HH:mm in Asia/Kolkata, e.g. "18:00"
  activeDays: string[]; // ['Monday', 'Tuesday', ...]
  createdAt?: Date;
  // Backward compatibility
  durationMinutes?: number;
  fee?: number;
  availableSlots?: string[];
}

export interface AppointmentType {
  id: string;
  name: string;
  durationMin: number;
  fee: number;
  description?: string;
  createdAt?: Date;
}

export interface Patient {
  id: string;
  name: string;
  phone: string;
  phoneMasked: string;
  createdAt: Date;
}

export interface Appointment {
  id: string;
  doctorId: string;
  doctorName?: string;
  patientId: string;
  patientName?: string;
  patientPhoneMasked?: string;
  appointmentTypeId: string;
  appointmentTypeName?: string;
  slotStart: Date; // UTC
  slotEnd: Date; // UTC
  durationMin: number;
  status: AppointmentStatus;
  idempotencyKey: string;
  cancellationReason?: string;
  createdAt: Date;
  updatedAt: Date;
  // Formatted display helpers
  displayDateKolkata?: string; // YYYY-MM-DD in Asia/Kolkata
  displayTimeKolkata?: string; // HH:mm in Asia/Kolkata
  // Backward compatibility fields
  appointmentDate?: string;
  startTime?: string;
  endTime?: string;
  durationMinutes?: number;
}

export interface SlotHold {
  id: string;
  doctorId: string;
  slotStart: Date; // UTC
  slotEnd: Date; // UTC
  holdToken: string;
  patientPhone: string;
  expiresAt: Date; // UTC (NOW() + 2 minutes)
  status: SlotHoldStatus;
  createdAt: Date;
}

export interface Call {
  id: string;
  patientPhoneMasked?: string;
  status: CallStatus;
  creditsUsed: number;
  summary?: string;
  startedAt: Date;
  endedAt?: Date;
}

export interface OutboxEvent {
  id: string;
  eventType:
    | 'APPOINTMENT_BOOKED'
    | 'APPOINTMENT_CANCELLED'
    | 'APPOINTMENT_RESCHEDULED'
    | 'CALLBACK_REQUESTED';
  payload: Record<string, unknown>;
  status: OutboxStatus;
  createdAt: Date;
  processedAt?: Date;
}

export interface CallbackRequest {
  id: string;
  callId?: string;
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
  unitsConsumed: number;
  estimatedCredits: number;
  timestamp: Date;
}

export interface EmergencyCheckResult {
  isEmergency: boolean;
  matchedKeywords: string[];
  escalationMessage: string;
}

export interface GeneratedSlot {
  slotStartUtc: Date;
  slotEndUtc: Date;
  timeKolkata: string; // HH:mm (e.g. "09:30")
  displayKolkata: string; // e.g. "09:30 AM"
  dateKolkata: string; // YYYY-MM-DD
  durationMin: number;
  available: boolean;
  reasonIfUnavailable?: 'BOOKED' | 'HELD' | 'PAST_TIME' | 'OUTSIDE_HOURS' | 'DOCTOR_UNAVAILABLE';
}

export interface BookingRequestInput {
  doctorId: string;
  date: string; // YYYY-MM-DD in Asia/Kolkata
  startTime: string; // HH:mm in Asia/Kolkata
  patientName: string;
  patientPhone: string;
  idempotencyKey: string;
  appointmentTypeId?: string;
  holdToken?: string;
  slotStart?: Date;
}

export interface HoldSlotInput {
  doctorId: string;
  date: string; // YYYY-MM-DD in Asia/Kolkata
  startTime: string; // HH:mm in Asia/Kolkata
  patientPhone: string;
  appointmentTypeId?: string;
  slotStart?: Date;
}

export interface HoldSlotResult {
  success: boolean;
  holdToken?: string;
  expiresAt?: Date;
  slotStartUtc?: Date;
  slotEndUtc?: Date;
  error?:
    | 'SLOT_UNAVAILABLE'
    | 'DOCTOR_NOT_FOUND'
    | 'INVALID_SLOT'
    | 'DATABASE_ERROR'
    | 'OUTSIDE_WORKING_HOURS';
  message: string;
}

export interface BookingResult {
  success: boolean;
  appointment?: Appointment;
  error?:
    | 'SLOT_ALREADY_BOOKED'
    | 'INVALID_DOCTOR'
    | 'INVALID_SLOT'
    | 'HOLD_EXPIRED'
    | 'DATABASE_ERROR'
    | 'IDEMPOTENT_REPLAY'
    | 'OUTSIDE_WORKING_HOURS';
  message: string;
}

export interface RescheduleResult {
  success: boolean;
  appointment?: Appointment;
  error?: 'APPOINTMENT_NOT_FOUND' | 'SLOT_ALREADY_BOOKED' | 'INVALID_SLOT' | 'DATABASE_ERROR';
  message: string;
}

export interface CancelResult {
  success: boolean;
  appointment?: Appointment;
  error?: 'APPOINTMENT_NOT_FOUND' | 'ALREADY_CANCELLED' | 'DATABASE_ERROR';
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
