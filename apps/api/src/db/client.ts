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
} from '../types/index.js';

export interface IDatabaseClient {
  initialize(): Promise<void>;
  close(): Promise<void>;

  getDoctors(): Promise<Doctor[]>;
  getDoctorById(id: string): Promise<Doctor | null>;
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
}
