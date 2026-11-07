/**
 * In-Memory Transactional Database for Appointly
 * Implements full transaction isolation, unique constraints, and idempotency logic.
 * Used for fast unit testing and standalone development.
 */

import { IDatabaseClient } from './client.js';
import { Doctor, Appointment, CallbackRequest, BookingRequestInput, BookingResult } from '../types/index.js';
import { maskPhone } from '../logger/logger.js';

export const INITIAL_DOCTORS: Doctor[] = [
  {
    id: 'dr_sharma',
    name: 'Dr. Ramesh Sharma',
    specialty: 'General Medicine & Family Physician',
    durationMinutes: 30,
    fee: 500,
    activeDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    availableSlots: ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '17:00', '17:30', '18:00', '18:30'],
  },
  {
    id: 'dr_priya',
    name: 'Dr. Priya Patel',
    specialty: 'Pediatrician (Child Specialist)',
    durationMinutes: 30,
    fee: 600,
    activeDays: ['Monday', 'Wednesday', 'Friday', 'Saturday'],
    availableSlots: ['10:00', '10:30', '11:00', '11:30', '12:00', '17:00', '17:30', '18:00'],
  },
  {
    id: 'dr_rajesh',
    name: 'Dr. Rajesh Kumar',
    specialty: 'Cardiologist (Heart Specialist)',
    durationMinutes: 30,
    fee: 900,
    activeDays: ['Tuesday', 'Thursday', 'Saturday'],
    availableSlots: ['17:00', '17:30', '18:00', '18:30', '19:00', '19:30'],
  },
  {
    id: 'dr_ananya',
    name: 'Dr. Ananya Iyer',
    specialty: 'Dermatologist (Skin & Hair)',
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

  public async getAvailableSlots(doctorId: string, date: string): Promise<string[] | string[]> {
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

      // 3. Validate Slot in Doctor's Schedule
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
        createdAt: new Date(),
      };

      // 6. Commit transaction
      this.appointments.set(id, appointment);
      this.slotLockMap.set(slotKey, appointment);
      this.idempotencyMap.set(input.idempotencyKey, appointment);

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

  public reset(): void {
    this.appointments.clear();
    this.idempotencyMap.clear();
    this.slotLockMap.clear();
    this.callbackRequests = [];
    this.seed();
  }
}

