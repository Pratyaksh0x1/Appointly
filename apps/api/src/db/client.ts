/**
 * Database Client Interface for Appointly
 * Enforces transaction-based booking with idempotency and double-booking prevention.
 */

import {
  Doctor,
  Appointment,
  CallbackRequest,
  BookingRequestInput,
  BookingResult,
  DoctorCallSummary,
  ReminderRecord,
} from '../types/index.js';

export interface IDatabaseClient {
  initialize(): Promise<void>;
  close(): Promise<void>;

  getDoctors(): Promise<Doctor[]>;
  getDoctorById(id: string): Promise<Doctor | null>;
  updateDoctorSchedule(
    doctorId: string,
    schedule: {
      workingHoursStart: string;
      workingHoursEnd: string;
      activeDays?: string[];
      durationMinutes?: number;
      fee?: number;
    }
  ): Promise<Doctor>;
  getAvailableSlots(doctorId: string, date: string): Promise<string[]>;

  /**
   * Atomic, serializable appointment booking.
   * MUST enforce:
   * 1. Idempotency check on input.idempotencyKey.
   * 2. Row-level or unique constraint check on (doctorId, date, startTime).
   * 3. Return success ONLY after successful commit.
   */
  bookAppointment(input: BookingRequestInput): Promise<BookingResult>;

  saveCallbackRequest(
    callId: string,
    phone: string,
    reason: string,
    preferredSlot?: string
  ): Promise<CallbackRequest>;
  getAppointments(doctorId?: string, date?: string): Promise<Appointment[]>;
  getCallbackRequests(): Promise<CallbackRequest[]>;

  cancelAppointment(
    appointmentId: string,
    reason?: string
  ): Promise<{ success: boolean; message: string }>;
  rescheduleAppointment(
    appointmentId: string,
    newDate: string,
    newStartTime: string
  ): Promise<BookingResult>;
  completeAppointment(appointmentId: string): Promise<{ success: boolean; message: string }>;
  resolveCallbackRequest(callbackId: string): Promise<{ success: boolean; message: string }>;

  /** Phase 7: Caller verification for cancel/reschedule without PHI leakage */
  findAppointmentForVerification(
    patientName: string,
    last4Phone: string
  ): Promise<Appointment | null>;

  /** Phase 7: Doctor Call Summary Lifecycle */
  saveCallSummary(summary: DoctorCallSummary): Promise<void>;
  getCallSummaries(limit?: number): Promise<DoctorCallSummary[]>;

  /** Phase 7: Outbound Reminders (24h and 2h before) driven by outbox */
  scheduleAppointmentReminders(appointment: Appointment): Promise<void>;
  pollPendingReminders(dueOnly?: boolean): Promise<ReminderRecord[]>;
  markReminderProcessed(id: string, scriptGenerated?: string): Promise<void>;

  saveOutboxEvent?(id: string, eventType: string, payload: Record<string, unknown>): Promise<void>;
  drainPendingOutbox?(): Promise<any[]>;
  markOutboxEventFailed?(id: string, error: string): Promise<void>;
  getDeadLetterOutboxEvents?(): Promise<any[]>;

  /** Phase 8: Data Protection & Transcript Retention */
  deleteTranscriptsOlderThan?(days: number): Promise<number>;
}
