/**
 * Appointly Booking Core Service
 * Non-negotiable Rules:
 * 1. LLM never writes to DB; it only calls this validated service.
 * 2. Decided by DB transaction: says "booked" only after COMMIT.
 * 3. Zero double-booking: unique constraint + row locking + idempotency key.
 * 4. Store times in UTC, display in Asia/Kolkata.
 * 5. 2-minute auto-expiring slot holds.
 */

import pg from 'pg';
import crypto from 'crypto';
import {
  Doctor,
  AppointmentType,
  Appointment,
  GeneratedSlot,
  BookingRequestInput,
  BookingResult,
  HoldSlotInput,
  HoldSlotResult,
  CancelResult,
  RescheduleResult,
  SEEDED_DOCTORS,
  SEEDED_APPOINTMENT_TYPES,
} from '@appointly/shared';
import {
  kolkataToUtc,
  formatKolkata,
  addMinutes,
  getDayOfWeekInKolkata,
} from '../utils/timezone.js';
import {
  generateDoctorSlots,
  filterAvailableSlots,
  BookingInterval,
  HoldInterval,
} from './slot-generator.js';
import { maskPhone, rootLogger } from '../logger/logger.js';
import { getEnv } from '../config/env.js';

export interface CheckSlotsResult {
  doctor: Doctor;
  appointmentType: AppointmentType;
  dateKolkata: string;
  allSlots: GeneratedSlot[];
  availableSlots: GeneratedSlot[];
}

export class BookingCoreService {
  private pool: pg.Pool;
  private doctorCache: Map<string, { doctor: Doctor; expiry: number }> = new Map();
  private apptTypeCache: Map<string, { type: AppointmentType; expiry: number }> = new Map();

  constructor(poolOrConnectionString: pg.Pool | string, options?: pg.PoolConfig) {
    if (typeof poolOrConnectionString === 'string') {
      const isSsl =
        poolOrConnectionString.includes('sslmode=') || poolOrConnectionString.includes('neon.tech');
      this.pool = new pg.Pool({
        connectionString: poolOrConnectionString,
        max: options?.max || 60,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 15000,
        ssl: isSsl ? { rejectUnauthorized: false } : undefined,
        ...options,
      });
    } else {
      this.pool = poolOrConnectionString;
    }
  }

  public getPool(): pg.Pool {
    return this.pool;
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }

  public async getDoctor(doctorId: string): Promise<Doctor | null> {
    const now = Date.now();
    const cached = this.doctorCache.get(doctorId);
    if (cached && cached.expiry > now) {
      return cached.doctor;
    }

    const docRes = await this.pool.query('SELECT * FROM doctors WHERE id = $1', [doctorId]);
    if (docRes.rows.length === 0) return null;
    const doc = this.mapDoctor(docRes.rows[0]);
    this.doctorCache.set(doctorId, { doctor: doc, expiry: now + 300000 }); // 5 min TTL
    return doc;
  }

  public async getAllDoctors(): Promise<Doctor[]> {
    const docRes = await this.pool.query('SELECT * FROM doctors ORDER BY name ASC');
    return docRes.rows.map((row) => this.mapDoctor(row));
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
    const existing = await this.getDoctor(doctorId);
    if (!existing) {
      throw new Error(`Doctor "${doctorId}" not found.`);
    }

    const activeDays =
      schedule.activeDays && schedule.activeDays.length > 0
        ? schedule.activeDays
        : existing.activeDays;
    const durationMinutes = schedule.durationMinutes || existing.durationMinutes || 30;
    const fee = schedule.fee !== undefined ? schedule.fee : existing.fee || 500;

    // Dynamically regenerate doctor available_slots from new working hours
    const [sh, sm] = schedule.workingHoursStart.split(':').map((v) => parseInt(v, 10));
    const [eh, em] = schedule.workingHoursEnd.split(':').map((v) => parseInt(v, 10));
    const startMin = sh * 60 + sm;
    const endMin = eh * 60 + em;

    const slots: string[] = [];
    for (let cur = startMin; cur + durationMinutes <= endMin; cur += durationMinutes) {
      const h = Math.floor(cur / 60)
        .toString()
        .padStart(2, '0');
      const m = (cur % 60).toString().padStart(2, '0');
      slots.push(`${h}:${m}`);
    }

    const updateRes = await this.pool.query(
      `UPDATE doctors 
       SET working_hours_start = $1, 
           working_hours_end = $2, 
           active_days = $3, 
           duration_minutes = $4, 
           fee = $5,
           available_slots = $6
       WHERE id = $7 
       RETURNING *`,
      [
        schedule.workingHoursStart,
        schedule.workingHoursEnd,
        activeDays,
        durationMinutes,
        fee,
        slots,
        doctorId,
      ]
    );

    if (updateRes.rows.length === 0) {
      throw new Error(`Failed to update doctor "${doctorId}".`);
    }

    const updated = this.mapDoctor(updateRes.rows[0]);
    // Invalidate/refresh cache immediately so voice agent and slot generator see updated hours immediately
    this.doctorCache.set(doctorId, { doctor: updated, expiry: Date.now() + 300000 });
    return updated;
  }

  public async getAppointmentType(typeId: string): Promise<AppointmentType | null> {
    const now = Date.now();
    const cached = this.apptTypeCache.get(typeId);
    if (cached && cached.expiry > now) {
      return cached.type;
    }

    const res = await this.pool.query('SELECT * FROM appointment_types WHERE id = $1', [typeId]);
    if (res.rows.length === 0) return null;
    const type = this.mapAppointmentType(res.rows[0]);
    this.apptTypeCache.set(typeId, { type, expiry: now + 300000 });
    return type;
  }

  /**
   * 1. checkSlots
   * Inspects doctor schedule, working hours, confirmed bookings, and active holds.
   */
  public async checkSlots(
    doctorId: string,
    dateStr: string,
    appointmentTypeId?: string,
    referenceNow: Date = new Date()
  ): Promise<CheckSlotsResult> {
    const doctor = await this.getDoctor(doctorId);
    if (!doctor) {
      throw new Error(`Doctor "${doctorId}" not found.`);
    }

    // Determine appointment type / duration
    let apptType: AppointmentType = SEEDED_APPOINTMENT_TYPES[0]; // General consultation (30 min) by default
    if (appointmentTypeId) {
      const foundType = await this.getAppointmentType(appointmentTypeId);
      if (foundType) {
        apptType = foundType;
      }
    }

    const durationMin = apptType.durationMin || doctor.durationMinutes || 30;

    // Fetch existing confirmed bookings for this doctor on this day
    const dayStartUtc = kolkataToUtc(dateStr, '00:00');
    const dayEndUtc = kolkataToUtc(dateStr, '23:59');

    const bookingsRes = await this.pool.query(
      `SELECT slot_start, slot_end, status 
       FROM appointments 
       WHERE doctor_id = $1 
         AND status = 'CONFIRMED'
         AND slot_start >= $2 
         AND slot_start <= $3`,
      [doctorId, dayStartUtc.toISOString(), dayEndUtc.toISOString()]
    );

    const existingBookings: BookingInterval[] = bookingsRes.rows.map((r) => ({
      slotStart: new Date(r.slot_start),
      slotEnd: new Date(r.slot_end),
      status: r.status,
    }));

    // Fetch active unexpired holds for this doctor
    const holdsRes = await this.pool.query(
      `SELECT slot_start, slot_end, expires_at, status 
       FROM slot_holds 
       WHERE doctor_id = $1 
         AND status = 'ACTIVE' 
         AND expires_at > $2
         AND slot_start >= $3 
         AND slot_start <= $4`,
      [doctorId, referenceNow.toISOString(), dayStartUtc.toISOString(), dayEndUtc.toISOString()]
    );

    const activeHolds: HoldInterval[] = holdsRes.rows.map((r) => ({
      slotStart: new Date(r.slot_start),
      slotEnd: new Date(r.slot_end),
      expiresAt: new Date(r.expires_at),
      status: r.status,
    }));

    const allSlots = generateDoctorSlots({
      doctorId,
      dateStr,
      workingHoursStart: doctor.workingHoursStart,
      workingHoursEnd: doctor.workingHoursEnd,
      activeDays: doctor.activeDays,
      durationMin,
      existingBookings,
      activeHolds,
      referenceNow,
    });

    const availableSlots = filterAvailableSlots(allSlots);

    return {
      doctor,
      appointmentType: apptType,
      dateKolkata: dateStr,
      allSlots,
      availableSlots,
    };
  }

  /**
   * 2. holdSlot
   * Reserves a temporary 2-minute hold on a slot so no one else can grab it while the patient confirms.
   */
  public async holdSlot(
    input: HoldSlotInput,
    referenceNow: Date = new Date()
  ): Promise<HoldSlotResult> {
    const doctor = await this.getDoctor(input.doctorId);
    if (!doctor) {
      return {
        success: false,
        error: 'DOCTOR_NOT_FOUND',
        message: `Doctor "${input.doctorId}" not found.`,
      };
    }

    // Determine duration
    let durationMin = doctor.durationMinutes || 30;
    if (input.appointmentTypeId) {
      const foundType = await this.getAppointmentType(input.appointmentTypeId);
      if (foundType) {
        durationMin = foundType.durationMin;
      }
    }

    const effectiveDate =
      input.date || (input.slotStart ? formatKolkata(input.slotStart).dateStr : '');
    const effectiveTime =
      input.startTime || (input.slotStart ? formatKolkata(input.slotStart).timeStr : '');
    const slotStartUtc = input.slotStart || kolkataToUtc(effectiveDate, effectiveTime);
    const slotEndUtc = addMinutes(slotStartUtc, durationMin);

    // Validate doctor working days
    const dayOfWeek = getDayOfWeekInKolkata(effectiveDate);
    const isWorkingDay = doctor.activeDays.some(
      (day) => day.trim().toLowerCase() === dayOfWeek.trim().toLowerCase()
    );
    if (!isWorkingDay) {
      return {
        success: false,
        error: 'OUTSIDE_WORKING_HOURS',
        message: `Dr. ${doctor.name} ${dayOfWeek} ko available nahi hain. Unke active days hain: ${doctor.activeDays.join(', ')}.`,
      };
    }

    // Validate doctor working hours
    const [sh, sm] = doctor.workingHoursStart.split(':').map((v) => parseInt(v, 10));
    const [eh, em] = doctor.workingHoursEnd.split(':').map((v) => parseInt(v, 10));
    const [th, tm] = input.startTime.split(':').map((v) => parseInt(v, 10));
    const startMin = sh * 60 + sm;
    const endMin = eh * 60 + em;
    const targetMin = th * 60 + tm;
    const targetEndMin = targetMin + durationMin;

    if (targetMin < startMin || targetEndMin > endMin) {
      return {
        success: false,
        error: 'OUTSIDE_WORKING_HOURS',
        message: `Dr. ${doctor.name} kewal ${doctor.workingHoursStart} se ${doctor.workingHoursEnd} tak hi baithte hain.`,
      };
    }

    // Check if slot has already passed
    if (slotStartUtc.getTime() <= referenceNow.getTime()) {
      return {
        success: false,
        error: 'INVALID_SLOT',
        message: 'Yeh slot pehle hi nikal chuka hai (past slot).',
      };
    }

    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // Check if already booked (row lock)
      const bookedRes = await client.query(
        `SELECT id FROM appointments 
         WHERE doctor_id = $1 AND slot_start = $2 AND status = 'CONFIRMED' 
         FOR UPDATE`,
        [input.doctorId, slotStartUtc.toISOString()]
      );

      if (bookedRes.rows.length > 0) {
        await client.query('ROLLBACK');
        return {
          success: false,
          error: 'SLOT_UNAVAILABLE',
          message: `Slot ${input.startTime} pehle se booked hai.`,
        };
      }

      // Check if actively held by another patient (unexpired)
      const heldRes = await client.query(
        `SELECT id FROM slot_holds 
         WHERE doctor_id = $1 AND slot_start = $2 AND status = 'ACTIVE' AND expires_at > $3 
         FOR UPDATE`,
        [input.doctorId, slotStartUtc.toISOString(), referenceNow.toISOString()]
      );

      if (heldRes.rows.length > 0) {
        await client.query('ROLLBACK');
        return {
          success: false,
          error: 'SLOT_UNAVAILABLE',
          message: `Slot ${input.startTime} par kisi doosre patient ka temporary hold hai.`,
        };
      }

      // Insert 2-minute hold
      const holdToken = `hold_${crypto.randomUUID()}`;
      const expiresAt = addMinutes(referenceNow, 2);
      const holdId = `hld_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

      await client.query(
        `INSERT INTO slot_holds 
         (id, doctor_id, slot_start, slot_end, hold_token, patient_phone, expires_at, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE', NOW())`,
        [
          holdId,
          input.doctorId,
          slotStartUtc.toISOString(),
          slotEndUtc.toISOString(),
          holdToken,
          input.patientPhone,
          expiresAt.toISOString(),
        ]
      );

      await client.query('COMMIT');

      return {
        success: true,
        holdToken,
        expiresAt,
        slotStartUtc,
        slotEndUtc,
        message: `Slot held successfully for 2 minutes until ${formatKolkata(expiresAt).displayTime}.`,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      rootLogger.error('Error in holdSlot transaction', { error: err });
      return {
        success: false,
        error: 'DATABASE_ERROR',
        message: 'Could not reserve slot hold.',
      };
    } finally {
      client.release();
    }
  }

  /**
   * 3. bookAppointment
   * Atomically commits appointment in a single transaction.
   * Enforces:
   *  - Idempotency key uniqueness check.
   *  - Release / conversion of holdToken if provided.
   *  - Row-lock verification and unique index (uq_active_doctor_slot) prevention of double-booking.
   *  - Patient record upsert.
   *  - Outbox event publication.
   */
  public async bookAppointment(
    input: BookingRequestInput,
    referenceNow: Date = new Date()
  ): Promise<BookingResult> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED');

      // 1. Idempotency Check
      const idemRes = await client.query(
        `SELECT a.*, d.name as doctor_name, p.name as patient_name, p.phone_masked 
         FROM appointments a
         JOIN doctors d ON a.doctor_id = d.id
         LEFT JOIN patients p ON a.patient_id = p.id
         WHERE a.idempotency_key = $1`,
        [input.idempotencyKey]
      );

      if (idemRes.rows.length > 0) {
        await client.query('COMMIT');
        return {
          success: true,
          appointment: this.mapAppointment(idemRes.rows[0]),
          error: 'IDEMPOTENT_REPLAY',
          message: 'Yeh appointment pehle hi book ho chuka hai (idempotent request).',
        };
      }

      // 2. Fetch Doctor
      const doctor = await this.getDoctor(input.doctorId);
      if (!doctor) {
        await client.query('ROLLBACK');
        return {
          success: false,
          error: 'INVALID_DOCTOR',
          message: `Doctor ${input.doctorId} nahi mile.`,
        };
      }

      // 3. Determine Appointment Type and Durations
      const apptTypeId = input.appointmentTypeId || 'general_consultation';
      const apptType = await this.getAppointmentType(apptTypeId);
      const durationMin = apptType?.durationMin || doctor.durationMinutes || 30;

      const effectiveDate =
        input.date || (input.slotStart ? formatKolkata(input.slotStart).dateStr : '');
      const effectiveTime =
        input.startTime || (input.slotStart ? formatKolkata(input.slotStart).timeStr : '');
      const slotStartUtc = input.slotStart || kolkataToUtc(effectiveDate, effectiveTime);
      const slotEndUtc = addMinutes(slotStartUtc, durationMin);

      // Validate doctor working days
      const dayOfWeek = getDayOfWeekInKolkata(effectiveDate);
      const isWorkingDay = doctor.activeDays.some(
        (day) => day.trim().toLowerCase() === dayOfWeek.trim().toLowerCase()
      );
      if (!isWorkingDay) {
        await client.query('ROLLBACK');
        return {
          success: false,
          error: 'OUTSIDE_WORKING_HOURS',
          message: `Dr. ${doctor.name} ${dayOfWeek} ko available nahi hain. Unke active days hain: ${doctor.activeDays.join(', ')}.`,
        };
      }

      // Validate doctor working hours
      const [sh, sm] = doctor.workingHoursStart.split(':').map((v) => parseInt(v, 10));
      const [eh, em] = doctor.workingHoursEnd.split(':').map((v) => parseInt(v, 10));
      const [th, tm] = input.startTime.split(':').map((v) => parseInt(v, 10));
      const startMin = sh * 60 + sm;
      const endMin = eh * 60 + em;
      const targetMin = th * 60 + tm;
      const targetEndMin = targetMin + durationMin;

      if (targetMin < startMin || targetEndMin > endMin) {
        await client.query('ROLLBACK');
        return {
          success: false,
          error: 'OUTSIDE_WORKING_HOURS',
          message: `Dr. ${doctor.name} kewal ${doctor.workingHoursStart} se ${doctor.workingHoursEnd} tak hi baithte hain.`,
        };
      }

      // 4. Validate or Convert Hold Token if provided
      if (input.holdToken) {
        const holdRes = await client.query(
          `SELECT id, status, expires_at 
           FROM slot_holds 
           WHERE hold_token = $1 
           FOR UPDATE`,
          [input.holdToken]
        );

        if (holdRes.rows.length > 0) {
          const hold = holdRes.rows[0];
          if (
            hold.status !== 'ACTIVE' ||
            new Date(hold.expires_at).getTime() < referenceNow.getTime()
          ) {
            await client.query('ROLLBACK');
            return {
              success: false,
              error: 'HOLD_EXPIRED',
              message: 'Slot hold expire ho gaya hai. Kripya dobara slot chuniye.',
            };
          }
          // Mark hold as converted
          await client.query(`UPDATE slot_holds SET status = 'CONVERTED' WHERE hold_token = $1`, [
            input.holdToken,
          ]);
        }
      }

      // 5. Concurrency Check: Active Confirmed Booking Lock
      const checkRes = await client.query(
        `SELECT id FROM appointments 
         WHERE doctor_id = $1 AND slot_start = $2 AND status = 'CONFIRMED' 
         FOR UPDATE`,
        [input.doctorId, slotStartUtc.toISOString()]
      );

      if (checkRes.rows.length > 0) {
        await client.query('ROLLBACK');
        return {
          success: false,
          error: 'SLOT_ALREADY_BOOKED',
          message: `Slot ${input.startTime} on ${input.date} pehle se booked hai.`,
        };
      }

      // 6. Upsert Patient
      const cleanPhone = input.patientPhone.replace(/\D/g, '');
      const maskedPhone = maskPhone(cleanPhone);
      let patientId: string;

      const patRes = await client.query('SELECT id FROM patients WHERE phone = $1', [cleanPhone]);
      if (patRes.rows.length > 0) {
        patientId = patRes.rows[0].id;
      } else {
        patientId = `pat_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        await client.query(
          `INSERT INTO patients (id, name, phone, phone_masked, created_at)
           VALUES ($1, $2, $3, $4, NOW())`,
          [patientId, input.patientName, cleanPhone, maskedPhone]
        );
      }

      // 7. Insert Appointment
      const appointmentId = `apt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const kolkataFormatted = formatKolkata(slotStartUtc);
      const endFormatted = formatKolkata(slotEndUtc);

      const insertRes = await client.query(
        `INSERT INTO appointments (
           id, doctor_id, patient_id, appointment_type_id, slot_start, slot_end, 
           duration_min, status, idempotency_key, created_at, updated_at,
           patient_name, patient_phone_masked, appointment_date, start_time, end_time, duration_minutes
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'CONFIRMED', $8, NOW(), NOW(), $9, $10, $11, $12, $13, $14)
         RETURNING *`,
        [
          appointmentId,
          doctor.id,
          patientId,
          apptTypeId,
          slotStartUtc.toISOString(),
          slotEndUtc.toISOString(),
          durationMin,
          input.idempotencyKey,
          input.patientName,
          maskedPhone,
          kolkataFormatted.dateStr,
          kolkataFormatted.timeStr,
          endFormatted.timeStr,
          durationMin,
        ]
      );

      // 8. Publish Outbox Event
      const outboxId = `out_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      await client.query(
        `INSERT INTO outbox (id, event_type, payload, status, created_at)
         VALUES ($1, 'APPOINTMENT_BOOKED', $2, 'PENDING', NOW())`,
        [
          outboxId,
          JSON.stringify({
            appointmentId,
            doctorId: doctor.id,
            doctorName: doctor.name,
            patientName: input.patientName,
            patientPhoneMasked: maskedPhone,
            dateKolkata: kolkataFormatted.dateStr,
            timeKolkata: kolkataFormatted.timeStr,
            durationMin,
            slotStartUtc: slotStartUtc.toISOString(),
          }),
        ]
      );

      await client.query('COMMIT');

      const appt = this.mapAppointment(insertRes.rows[0]);
      appt.doctorName = doctor.name;
      appt.patientName = input.patientName;
      appt.patientPhoneMasked = maskedPhone;

      return {
        success: true,
        appointment: appt,
        message: `Appointment successfully booked with ${doctor.name} for ${kolkataFormatted.dateStr} at ${kolkataFormatted.displayTime} (${durationMin} mins).`,
      };
    } catch (err: unknown) {
      await client.query('ROLLBACK');
      const pgErr = err as { code?: string };
      // PostgreSQL unique_violation error code = 23505 (fired by uq_active_doctor_slot)
      if (pgErr.code === '23505') {
        return {
          success: false,
          error: 'SLOT_ALREADY_BOOKED',
          message: `Slot ${input.startTime} on ${input.date} pehle se booked hai (Unique constraint violation).`,
        };
      }
      rootLogger.error('Booking transaction exception', { error: err });
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * 4. cancelAppointment
   * Frees slot for future bookings while preserving audit record.
   */
  public async cancelAppointment(
    appointmentId: string,
    reason: string = 'Patient requested cancellation'
  ): Promise<CancelResult> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const selRes = await client.query(
        `SELECT a.*, d.name as doctor_name 
         FROM appointments a 
         JOIN doctors d ON a.doctor_id = d.id 
         WHERE a.id = $1 
         FOR UPDATE`,
        [appointmentId]
      );

      if (selRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return {
          success: false,
          error: 'APPOINTMENT_NOT_FOUND',
          message: `Appointment "${appointmentId}" nahi mila.`,
        };
      }

      const existing = selRes.rows[0];
      if (existing.status === 'CANCELLED') {
        await client.query('ROLLBACK');
        return {
          success: false,
          error: 'ALREADY_CANCELLED',
          message: 'Yeh appointment pehle hi cancel ho chuka hai.',
        };
      }

      const updateRes = await client.query(
        `UPDATE appointments 
         SET status = 'CANCELLED', cancellation_reason = $1, updated_at = NOW() 
         WHERE id = $2 
         RETURNING *`,
        [reason, appointmentId]
      );

      // Publish outbox event
      const outboxId = `out_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      await client.query(
        `INSERT INTO outbox (id, event_type, payload, status, created_at)
         VALUES ($1, 'APPOINTMENT_CANCELLED', $2, 'PENDING', NOW())`,
        [
          outboxId,
          JSON.stringify({
            appointmentId,
            doctorId: existing.doctor_id,
            reason,
            cancelledAt: new Date().toISOString(),
          }),
        ]
      );

      await client.query('COMMIT');

      const cancelledAppt = this.mapAppointment(updateRes.rows[0]);
      cancelledAppt.doctorName = existing.doctor_name;

      return {
        success: true,
        appointment: cancelledAppt,
        message: 'Appointment successfully cancelled. Slot has been freed.',
      };
    } catch (err) {
      await client.query('ROLLBACK');
      rootLogger.error('Error cancelling appointment', { error: err });
      return {
        success: false,
        error: 'DATABASE_ERROR',
        message: 'Could not cancel appointment.',
      };
    } finally {
      client.release();
    }
  }

  /**
   * 5. rescheduleAppointment
   * Atomically verifies new slot availability, transfers appointment, and frees previous slot.
   */
  public async rescheduleAppointment(
    appointmentId: string,
    newDateStr: string,
    newStartTimeStr: string,
    newIdempotencyKey?: string
  ): Promise<RescheduleResult> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const selRes = await client.query(
        `SELECT a.*, d.name as doctor_name 
         FROM appointments a 
         JOIN doctors d ON a.doctor_id = d.id 
         WHERE a.id = $1 
         FOR UPDATE`,
        [appointmentId]
      );

      if (selRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return {
          success: false,
          error: 'APPOINTMENT_NOT_FOUND',
          message: `Appointment "${appointmentId}" nahi mila.`,
        };
      }

      const existing = selRes.rows[0];
      if (existing.status === 'CANCELLED') {
        await client.query('ROLLBACK');
        return {
          success: false,
          error: 'APPOINTMENT_NOT_FOUND',
          message: 'Cancelled appointment cannot be rescheduled.',
        };
      }

      const durationMin = existing.duration_min || 30;
      const newSlotStartUtc = kolkataToUtc(newDateStr, newStartTimeStr);
      const newSlotEndUtc = addMinutes(newSlotStartUtc, durationMin);

      // Check if new slot has active booking (FOR UPDATE)
      const slotRes = await client.query(
        `SELECT id FROM appointments 
         WHERE doctor_id = $1 AND slot_start = $2 AND status = 'CONFIRMED' AND id != $3 
         FOR UPDATE`,
        [existing.doctor_id, newSlotStartUtc.toISOString(), appointmentId]
      );

      if (slotRes.rows.length > 0) {
        await client.query('ROLLBACK');
        return {
          success: false,
          error: 'SLOT_ALREADY_BOOKED',
          message: `New slot ${newStartTimeStr} on ${newDateStr} pehle se booked hai.`,
        };
      }

      const kolkataFormatted = formatKolkata(newSlotStartUtc);
      const endFormatted = formatKolkata(newSlotEndUtc);

      const updateRes = await client.query(
        `UPDATE appointments 
         SET slot_start = $1, 
             slot_end = $2, 
             appointment_date = $3, 
             start_time = $4, 
             end_time = $5, 
             updated_at = NOW(),
             idempotency_key = COALESCE($6, idempotency_key)
         WHERE id = $7 
         RETURNING *`,
        [
          newSlotStartUtc.toISOString(),
          newSlotEndUtc.toISOString(),
          kolkataFormatted.dateStr,
          kolkataFormatted.timeStr,
          endFormatted.timeStr,
          newIdempotencyKey || null,
          appointmentId,
        ]
      );

      // Publish outbox event
      const outboxId = `out_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      await client.query(
        `INSERT INTO outbox (id, event_type, payload, status, created_at)
         VALUES ($1, 'APPOINTMENT_RESCHEDULED', $2, 'PENDING', NOW())`,
        [
          outboxId,
          JSON.stringify({
            appointmentId,
            doctorId: existing.doctor_id,
            previousSlot: existing.slot_start,
            newSlotStartUtc: newSlotStartUtc.toISOString(),
            newDateKolkata: kolkataFormatted.dateStr,
            newTimeKolkata: kolkataFormatted.timeStr,
          }),
        ]
      );

      await client.query('COMMIT');

      const rescheduled = this.mapAppointment(updateRes.rows[0]);
      rescheduled.doctorName = existing.doctor_name;

      return {
        success: true,
        appointment: rescheduled,
        message: `Appointment successfully rescheduled to ${kolkataFormatted.dateStr} at ${kolkataFormatted.displayTime}.`,
      };
    } catch (err: unknown) {
      await client.query('ROLLBACK');
      const pgErr = err as { code?: string };
      if (pgErr.code === '23505') {
        return {
          success: false,
          error: 'SLOT_ALREADY_BOOKED',
          message: 'Target slot is already booked (Unique constraint violation).',
        };
      }
      rootLogger.error('Error rescheduling appointment', { error: err });
      return {
        success: false,
        error: 'DATABASE_ERROR',
        message: 'Could not reschedule appointment.',
      };
    } finally {
      client.release();
    }
  }

  // Row Mapping Helpers
  private mapDoctor(row: Record<string, unknown>): Doctor {
    return {
      id: String(row.id),
      name: String(row.name),
      specialty: String(row.specialty),
      workingHoursStart: String(row.working_hours_start || '09:00'),
      workingHoursEnd: String(row.working_hours_end || '18:00'),
      activeDays: (row.active_days as string[]) || [],
      durationMinutes: Number(row.duration_minutes || 30),
      fee: Number(row.fee || 500),
      availableSlots: (row.available_slots as string[]) || [],
      createdAt: row.created_at ? new Date(String(row.created_at)) : undefined,
    };
  }

  private mapAppointmentType(row: Record<string, unknown>): AppointmentType {
    return {
      id: String(row.id),
      name: String(row.name),
      durationMin: Number(row.duration_min),
      fee: Number(row.fee),
      description: row.description ? String(row.description) : undefined,
      createdAt: row.created_at ? new Date(String(row.created_at)) : undefined,
    };
  }

  private mapAppointment(row: Record<string, unknown>): Appointment {
    const slotStart = row.slot_start
      ? new Date(String(row.slot_start))
      : kolkataToUtc(String(row.appointment_date).slice(0, 10), String(row.start_time));
    const slotEnd = row.slot_end
      ? new Date(String(row.slot_end))
      : addMinutes(slotStart, Number(row.duration_min || row.duration_minutes || 30));

    const formatted = formatKolkata(slotStart);

    return {
      id: String(row.id),
      doctorId: String(row.doctor_id),
      doctorName: row.doctor_name ? String(row.doctor_name) : undefined,
      patientId: row.patient_id ? String(row.patient_id) : '',
      patientName: row.patient_name ? String(row.patient_name) : undefined,
      patientPhoneMasked: row.patient_phone_masked ? String(row.patient_phone_masked) : undefined,
      appointmentTypeId: row.appointment_type_id
        ? String(row.appointment_type_id)
        : 'general_consultation',
      slotStart,
      slotEnd,
      durationMin: Number(row.duration_min || row.duration_minutes || 30),
      status: row.status as Appointment['status'],
      idempotencyKey: String(row.idempotency_key),
      cancellationReason: row.cancellation_reason ? String(row.cancellation_reason) : undefined,
      createdAt: new Date(String(row.created_at)),
      updatedAt: row.updated_at ? new Date(String(row.updated_at)) : new Date(),
      displayDateKolkata: formatted.dateStr,
      displayTimeKolkata: formatted.displayTime,
      appointmentDate: formatted.dateStr,
      startTime: formatted.timeStr,
      endTime: formatKolkata(slotEnd).timeStr,
      durationMinutes: Number(row.duration_min || row.duration_minutes || 30),
    };
  }
}

let sharedBookingCoreService: BookingCoreService | null = null;

export function getBookingCoreService(): BookingCoreService {
  if (!sharedBookingCoreService) {
    const env = getEnv();
    sharedBookingCoreService = new BookingCoreService(env.DATABASE_URL);
  }
  return sharedBookingCoreService;
}

export function setBookingCoreServiceForTesting(service: BookingCoreService | null): void {
  sharedBookingCoreService = service;
}
