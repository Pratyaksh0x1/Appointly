/**
 * In-Memory Transactional Database for Appointly
 * Implements full transaction isolation, unique constraints, and idempotency logic.
 * Used for fast unit testing and standalone development.
 */

import { IDatabaseClient } from './client.js';
import {
  Doctor,
  Appointment,
  CallbackRequest,
  BookingRequestInput,
  BookingResult,
  DoctorCallSummary,
  ReminderRecord,
} from '../types/index.js';
import { maskPhone } from '../logger/logger.js';

export const INITIAL_DOCTORS: Doctor[] = [
  {
    id: 'dr_sharma',
    name: 'Dr. Ramesh Sharma',
    specialty: 'General Medicine & Family Physician',
    workingHoursStart: '09:00',
    workingHoursEnd: '18:00',
    durationMinutes: 30,
    fee: 500,
    activeDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    availableSlots: [
      '09:00',
      '09:30',
      '10:00',
      '10:30',
      '11:00',
      '11:30',
      '17:00',
      '17:30',
      '18:00',
      '18:30',
    ],
  },
  {
    id: 'dr_priya',
    name: 'Dr. Priya Patel',
    specialty: 'Pediatrician (Child Specialist)',
    workingHoursStart: '10:00',
    workingHoursEnd: '18:00',
    durationMinutes: 30,
    fee: 600,
    activeDays: ['Monday', 'Wednesday', 'Friday', 'Saturday'],
    availableSlots: ['10:00', '10:30', '11:00', '11:30', '12:00', '17:00', '17:30', '18:00'],
  },
  {
    id: 'dr_rajesh',
    name: 'Dr. Rajesh Kumar',
    specialty: 'Cardiologist (Heart Specialist)',
    workingHoursStart: '16:00',
    workingHoursEnd: '20:00',
    durationMinutes: 30,
    fee: 900,
    activeDays: ['Tuesday', 'Thursday', 'Saturday'],
    availableSlots: ['16:00', '16:30', '17:00', '17:30', '18:00', '18:30', '19:00', '19:30'],
  },
  {
    id: 'dr_ananya',
    name: 'Dr. Ananya Iyer',
    specialty: 'Dermatologist (Skin & Hair)',
    workingHoursStart: '10:00',
    workingHoursEnd: '18:30',
    durationMinutes: 30,
    fee: 700,
    activeDays: ['Monday', 'Tuesday', 'Thursday', 'Friday'],
    availableSlots: ['10:00', '10:30', '11:00', '11:30', '17:30', '18:00', '18:30'],
  },
];

export class MemoryDatabaseClient implements IDatabaseClient {
  private doctors: Map<string, Doctor> = new Map();
  private appointments: Map<string, Appointment> = new Map(); // key = appointment.id
  private idempotencyMap: Map<string, Appointment> = new Map(); // key = idempotencyKey
  private slotLockMap: Map<string, Appointment> = new Map(); // key = `${doctorId}:${date}:${startTime}`
  private callbackRequests: CallbackRequest[] = [];
  private outboxEvents: any[] = [];
  private callSummaries: DoctorCallSummary[] = [];
  private reminders: ReminderRecord[] = [];

  // Simple async lock to emulate atomic DB transaction
  private transactionMutex: Promise<void> = Promise.resolve();

  constructor() {
    this.seed();
  }

  private seed() {
    for (const doc of INITIAL_DOCTORS) {
      this.doctors.set(doc.id, doc);
    }
  }

  public async initialize(): Promise<void> {
    // Already in memory
  }

  public async close(): Promise<void> {
    // No-op
  }

  public async getDoctors(): Promise<Doctor[]> {
    return Array.from(this.doctors.values());
  }

  public async getDoctorById(id: string): Promise<Doctor | null> {
    return this.doctors.get(id) || null;
  }

  public async updateDoctorSchedule(
    doctorId: string,
    schedule: {
      workingHoursStart: string;
      workingHoursEnd: string;
      activeDays?: string[];
      durationMinutes?: number;
      fee?: number;
    }
  ): Promise<Doctor> {
    const doc = this.doctors.get(doctorId);
    if (!doc) {
      throw new Error(`Doctor "${doctorId}" not found.`);
    }

    doc.workingHoursStart = schedule.workingHoursStart;
    doc.workingHoursEnd = schedule.workingHoursEnd;
    if (schedule.activeDays) doc.activeDays = schedule.activeDays;
    if (schedule.durationMinutes) doc.durationMinutes = schedule.durationMinutes;
    if (schedule.fee !== undefined) doc.fee = schedule.fee;

    // Dynamically regenerate doctor.availableSlots from new working hours
    const [sh, sm] = doc.workingHoursStart.split(':').map((v) => parseInt(v, 10));
    const [eh, em] = doc.workingHoursEnd.split(':').map((v) => parseInt(v, 10));
    const startMin = sh * 60 + sm;
    const endMin = eh * 60 + em;
    const duration = doc.durationMinutes || 30;

    const slots: string[] = [];
    for (let cur = startMin; cur + duration <= endMin; cur += duration) {
      const h = Math.floor(cur / 60)
        .toString()
        .padStart(2, '0');
      const m = (cur % 60).toString().padStart(2, '0');
      slots.push(`${h}:${m}`);
    }
    doc.availableSlots = slots;

    this.doctors.set(doctorId, doc);
    return doc;
  }

  public async getAvailableSlots(doctorId: string, date: string): Promise<string[]> {
    const doctor = this.doctors.get(doctorId);
    if (!doctor) return [];

    const bookedSlots = new Set<string>();
    for (const app of this.appointments.values()) {
      if (app.doctorId === doctorId && app.appointmentDate === date && app.status === 'CONFIRMED') {
        bookedSlots.add(app.startTime);
      }
    }

    return doctor.availableSlots.filter((slot) => !bookedSlots.has(slot));
  }

  private calculateEndTime(startTime: string, durationMinutes: number): string {
    const [hours, minutes] = startTime.split(':').map((v) => parseInt(v, 10));
    const totalMinutes = hours * 60 + minutes + durationMinutes;
    const endH = Math.floor(totalMinutes / 60) % 24;
    const endM = totalMinutes % 60;
    return `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
  }

  public async bookAppointment(input: BookingRequestInput): Promise<BookingResult> {
    // Acquire transaction mutex to guarantee atomic serializable execution
    let releaseLock: () => void = () => {};
    const lockPromise = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    const previousLock = this.transactionMutex;
    this.transactionMutex = previousLock.then(() => lockPromise);

    await previousLock;

    try {
      // 1. Idempotency Check
      const existingByIdempotency = this.idempotencyMap.get(input.idempotencyKey);
      if (existingByIdempotency) {
        return {
          success: true,
          appointment: existingByIdempotency,
          error: 'IDEMPOTENT_REPLAY',
          message: 'Yeh appointment pehle hi book ho chuka hai (idempotent request).',
        };
      }

      // 2. Validate Doctor
      const doctor = this.doctors.get(input.doctorId);
      if (!doctor) {
        return {
          success: false,
          error: 'INVALID_DOCTOR',
          message: `Doctor ${input.doctorId} nahi mile. Kripya valid doctor select karein.`,
        };
      }

      // 3. Validate Working Hours & Slot in Doctor's Schedule
      const [sh, sm] = (doctor.workingHoursStart || '09:00').split(':').map((v) => parseInt(v, 10));
      const [eh, em] = (doctor.workingHoursEnd || '18:00').split(':').map((v) => parseInt(v, 10));
      const [th, tm] = input.startTime.split(':').map((v) => parseInt(v, 10));
      const startMin = sh * 60 + sm;
      const endMin = eh * 60 + em;
      const targetMin = th * 60 + tm;
      const duration = doctor.durationMinutes || 30;

      if (targetMin < startMin || targetMin + duration > endMin) {
        return {
          success: false,
          error: 'OUTSIDE_WORKING_HOURS',
          message: `Dr. ${doctor.name} kewal ${doctor.workingHoursStart} se ${doctor.workingHoursEnd} tak hi baithte hain.`,
        };
      }

      if (!doctor.availableSlots.includes(input.startTime)) {
        return {
          success: false,
          error: 'INVALID_SLOT',
          message: `Slot ${input.startTime} is not valid for ${doctor.name}. Available slots: ${doctor.availableSlots.join(', ')}`,
        };
      }

      // 4. Enforce UNIQUE Constraint (No Double Booking)
      const slotKey = `${input.doctorId}:${input.date}:${input.startTime}`;
      if (this.slotLockMap.has(slotKey)) {
        return {
          success: false,
          error: 'SLOT_ALREADY_BOOKED',
          message: `Slot ${input.startTime} on ${input.date} pehle se booked hai. Kripya koi dusra samay chunein.`,
        };
      }

      // 5. Create Appointment Record
      const id = `apt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const endTime = this.calculateEndTime(input.startTime, doctor.durationMinutes);

      const appointment: Appointment = {
        id,
        doctorId: doctor.id,
        doctorName: doctor.name,
        patientName: input.patientName,
        patientPhoneMasked: maskPhone(input.patientPhone),
        appointmentDate: input.date,
        startTime: input.startTime,
        endTime,
        durationMinutes: doctor.durationMinutes,
        status: 'CONFIRMED',
        idempotencyKey: input.idempotencyKey,
        visitType: 'General Consultation',
        reason: 'Regular consultation and health triage',
        aiSummary: `Booked via Voice AI assistant. Triage completed, slot confirmed for ${input.patientName}.`,
        createdAt: new Date(),
      };

      // 6. Commit transaction
      this.appointments.set(id, appointment);
      this.slotLockMap.set(slotKey, appointment);
      this.idempotencyMap.set(input.idempotencyKey, appointment);
      await this.saveOutboxEvent(`out_${Date.now()}`, 'new_appointment', appointment as any);

      return {
        success: true,
        appointment,
        message: `Appointment successfully booked with ${doctor.name} for ${input.date} at ${input.startTime} (Duration: ${doctor.durationMinutes} mins).`,
      };
    } finally {
      releaseLock();
    }
  }

  public async saveCallbackRequest(
    callId: string,
    phone: string,
    reason: string,
    preferredSlot?: string
  ): Promise<CallbackRequest> {
    const callback: CallbackRequest = {
      id: `cb_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      callId,
      patientPhoneMasked: maskPhone(phone),
      preferredSlot,
      reason,
      status: 'PENDING',
      createdAt: new Date(),
    };

    this.callbackRequests.push(callback);
    return callback;
  }

  public async getAppointments(doctorId?: string, date?: string): Promise<Appointment[]> {
    let result = Array.from(this.appointments.values());
    if (doctorId) {
      result = result.filter((a) => a.doctorId === doctorId);
    }
    if (date) {
      result = result.filter((a) => a.appointmentDate === date);
    }
    return result.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  public async getCallbackRequests(): Promise<CallbackRequest[]> {
    return [...this.callbackRequests].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  public async saveOutboxEvent(
    id: string,
    eventType: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    this.outboxEvents.push({
      id,
      eventType,
      payload,
      status: 'PENDING',
      retryCount: 0,
      maxRetries: 3,
      lastError: undefined,
      createdAt: new Date(),
    });
  }

  public async drainPendingOutbox(): Promise<any[]> {
    const pending = this.outboxEvents.filter(
      (e) => e.status === 'PENDING' && (e.retryCount || 0) < (e.maxRetries || 3)
    );
    for (const p of pending) {
      p.status = 'PROCESSED';
      p.processedAt = new Date();
    }
    return pending;
  }

  public async markOutboxEventFailed(id: string, error: string): Promise<void> {
    const evt = this.outboxEvents.find((e) => e.id === id);
    if (evt) {
      evt.retryCount = (evt.retryCount || 0) + 1;
      evt.lastError = error;
      if (evt.retryCount >= (evt.maxRetries || 3)) {
        evt.status = 'DEAD_LETTER';
      } else {
        evt.status = 'PENDING';
      }
    }
  }

  public async getDeadLetterOutboxEvents(): Promise<any[]> {
    return this.outboxEvents.filter((e) => e.status === 'DEAD_LETTER');
  }

  public async deleteTranscriptsOlderThan(days: number): Promise<number> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const beforeCount = this.callSummaries.length;
    this.callSummaries = this.callSummaries.filter((s) => s.createdAt >= cutoff);
    return beforeCount - this.callSummaries.length;
  }

  public async cancelAppointment(
    appointmentId: string,
    reason?: string
  ): Promise<{ success: boolean; message: string }> {
    const apt = this.appointments.get(appointmentId);
    if (!apt) {
      return { success: false, message: 'Appointment not found' };
    }
    apt.status = 'CANCELLED';
    const slotKey = `${apt.doctorId}:${apt.appointmentDate}:${apt.startTime}`;
    this.slotLockMap.delete(slotKey);
    await this.saveOutboxEvent(`out_cancel_${Date.now()}`, 'appointment_cancelled', apt as any);
    return { success: true, message: `Appointment ${appointmentId} cancelled.` };
  }

  public async completeAppointment(
    appointmentId: string
  ): Promise<{ success: boolean; message: string }> {
    const apt = this.appointments.get(appointmentId);
    if (!apt) {
      return { success: false, message: 'Appointment not found' };
    }
    apt.status = 'COMPLETED';
    await this.saveOutboxEvent(`out_comp_${Date.now()}`, 'appointment_completed', apt as any);
    return { success: true, message: `Appointment ${appointmentId} completed.` };
  }

  public async rescheduleAppointment(
    appointmentId: string,
    newDate: string,
    newStartTime: string
  ): Promise<BookingResult> {
    const apt = this.appointments.get(appointmentId);
    if (!apt) {
      return { success: false, error: 'INVALID_DOCTOR', message: 'Appointment not found.' };
    }

    const newSlotKey = `${apt.doctorId}:${newDate}:${newStartTime}`;
    const conflict = this.slotLockMap.get(newSlotKey);
    if (conflict && conflict.id !== appointmentId && conflict.status === 'CONFIRMED') {
      return {
        success: false,
        error: 'SLOT_ALREADY_BOOKED',
        message: `Slot ${newStartTime} on ${newDate} is already booked.`,
      };
    }

    // Release old slot key
    const oldSlotKey = `${apt.doctorId}:${apt.appointmentDate}:${apt.startTime}`;
    this.slotLockMap.delete(oldSlotKey);

    apt.appointmentDate = newDate;
    apt.startTime = newStartTime;
    apt.status = 'CONFIRMED';
    this.slotLockMap.set(newSlotKey, apt);

    await this.saveOutboxEvent(`out_resched_${Date.now()}`, 'appointment_rescheduled', apt as any);
    return {
      success: true,
      appointment: apt,
      message: `Appointment rescheduled to ${newDate} at ${newStartTime}.`,
    };
  }

  public async resolveCallbackRequest(
    callbackId: string
  ): Promise<{ success: boolean; message: string }> {
    const cb = this.callbackRequests.find((c) => c.id === callbackId);
    if (!cb) {
      return { success: false, message: 'Callback request not found' };
    }
    cb.status = 'RESOLVED';
    return { success: true, message: `Callback request ${callbackId} resolved.` };
  }

  public async findAppointmentForVerification(
    patientName: string,
    last4Phone: string
  ): Promise<Appointment | null> {
    const normSearchName = patientName.trim().toLowerCase();
    const cleanLast4 = last4Phone.replace(/\D/g, '').slice(-4);

    for (const apt of this.appointments.values()) {
      if (apt.status !== 'CONFIRMED' && apt.status !== 'RESCHEDULED') continue;

      const normAptName = (apt.patientName || '').trim().toLowerCase();
      const nameMatches =
        normAptName === normSearchName ||
        normAptName.includes(normSearchName) ||
        normSearchName.includes(normAptName);

      const phoneDigits = (apt.patientPhoneMasked || (apt as any).patientPhone || '').replace(
        /\D/g,
        ''
      );
      const last4Matches = phoneDigits.endsWith(cleanLast4);

      if (nameMatches && last4Matches) {
        return apt;
      }
    }
    return null;
  }

  public async saveCallSummary(summary: DoctorCallSummary): Promise<void> {
    this.callSummaries.unshift(summary);
    await this.saveOutboxEvent(`out_sum_${summary.callId}`, 'call_summary_created', summary as any);
  }

  public async getCallSummaries(limit = 20): Promise<DoctorCallSummary[]> {
    return this.callSummaries.slice(0, limit);
  }

  public async scheduleAppointmentReminders(appointment: Appointment): Promise<void> {
    const dateStr = appointment.appointmentDate || '2026-11-20';
    const timeStr = appointment.startTime || '17:00';
    const [h, m] = timeStr.split(':').map((v) => parseInt(v, 10));
    const appointmentTime = new Date(
      `${dateStr}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`
    );

    const time24h = new Date(appointmentTime.getTime() - 24 * 60 * 60 * 1000);
    const time2h = new Date(appointmentTime.getTime() - 2 * 60 * 60 * 1000);

    const r24: ReminderRecord = {
      id: `rem_24h_${appointment.id}`,
      appointmentId: appointment.id,
      patientName: appointment.patientName,
      patientPhoneMasked: appointment.patientPhoneMasked || maskPhone('9876543210'),
      doctorName: appointment.doctorName || 'Dr. Sharma',
      appointmentDate: dateStr,
      startTime: timeStr,
      reminderType: '24h',
      channel: 'SMS_AND_VOICE',
      scheduledFor: time24h,
      status: 'PENDING',
    };

    const r2: ReminderRecord = {
      id: `rem_2h_${appointment.id}`,
      appointmentId: appointment.id,
      patientName: appointment.patientName,
      patientPhoneMasked: appointment.patientPhoneMasked || maskPhone('9876543210'),
      doctorName: appointment.doctorName || 'Dr. Sharma',
      appointmentDate: dateStr,
      startTime: timeStr,
      reminderType: '2h',
      channel: 'SMS_AND_VOICE',
      scheduledFor: time2h,
      status: 'PENDING',
    };

    this.reminders.push(r24, r2);
    await this.saveOutboxEvent(`out_${r24.id}`, 'appointment_reminder', r24 as any);
    await this.saveOutboxEvent(`out_${r2.id}`, 'appointment_reminder', r2 as any);
  }

  public async pollPendingReminders(dueOnly: boolean = true): Promise<ReminderRecord[]> {
    const now = new Date();
    return this.reminders.filter(
      (r) => r.status === 'PENDING' && (!dueOnly || !r.scheduledFor || r.scheduledFor <= now)
    );
  }

  public async markReminderProcessed(id: string, scriptGenerated?: string): Promise<void> {
    const rem = this.reminders.find((r) => r.id === id);
    if (rem) {
      rem.status = 'PROCESSED';
      rem.scriptGenerated = scriptGenerated;
      rem.sentAt = new Date();
    }
  }

  public reset(): void {
    this.appointments.clear();
    this.idempotencyMap.clear();
    this.slotLockMap.clear();
    this.callbackRequests = [];
    this.outboxEvents = [];
    this.callSummaries = [];
    this.reminders = [];
    this.seed();
  }
}
