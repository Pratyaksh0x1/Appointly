/**
 * PostgreSQL Database Client for Appointly
 * Enforces PostgreSQL transactions with SERIALIZABLE isolation and FOR UPDATE locks.
 */

import pg from 'pg';
import { IDatabaseClient } from './client.js';
import {
  Doctor,
  Appointment,
  CallbackRequest,
  BookingRequestInput,
  BookingResult,
} from '../types/index.js';
import { maskPhone, rootLogger } from '../logger/logger.js';
import { kolkataToUtc, addMinutes } from '../utils/timezone.js';
import fs from 'fs';
import path from 'path';

export class PostgresDatabaseClient implements IDatabaseClient {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    const isSsl = connectionString.includes('sslmode=') || connectionString.includes('neon.tech');
    this.pool = new pg.Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      ssl: isSsl ? { rejectUnauthorized: false } : undefined,
    });
  }

  public async initialize(): Promise<void> {
    try {
      const candidates = [
        path.resolve(process.cwd(), 'src/db/schema.sql'),
        path.resolve(__dirname, 'schema.sql'),
        path.resolve(process.cwd(), 'dist/src/db/schema.sql'),
      ];
      const schemaPath = candidates.find((p) => fs.existsSync(p));
      if (schemaPath) {
        const sql = fs.readFileSync(schemaPath, 'utf8');
        await this.pool.query(sql);
        rootLogger.info('Postgres schema verified and initialized successfully on Neon');
      }
    } catch (err) {
      rootLogger.warn(
        'Could not auto-apply schema.sql on Postgres (tables might already exist):',
        err
      );
    }
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }

  public async getDoctors(): Promise<Doctor[]> {
    const res = await this.pool.query('SELECT * FROM doctors ORDER BY name ASC');
    return res.rows.map(this.mapDoctorRow);
  }

  public async getDoctorById(id: string): Promise<Doctor | null> {
    const res = await this.pool.query('SELECT * FROM doctors WHERE id = $1', [id]);
    if (res.rows.length === 0) return null;
    return this.mapDoctorRow(res.rows[0]);
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
    const doc = await this.getDoctorById(doctorId);
    if (!doc) throw new Error(`Doctor "${doctorId}" not found.`);

    const activeDays = schedule.activeDays || doc.activeDays;
    const durationMinutes = schedule.durationMinutes || doc.durationMinutes || 30;
    const fee = schedule.fee !== undefined ? schedule.fee : doc.fee;

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

    const res = await this.pool.query(
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

    if (res.rows.length === 0) {
      throw new Error(`Failed to update doctor "${doctorId}".`);
    }

    return this.mapDoctorRow(res.rows[0]);
  }

  public async getAvailableSlots(doctorId: string, date: string): Promise<string[]> {
    const doc = await this.getDoctorById(doctorId);
    if (!doc) return [];

    const bookedRes = await this.pool.query(
      `SELECT start_time FROM appointments WHERE doctor_id = $1 AND appointment_date = $2 AND status = 'CONFIRMED'`,
      [doctorId, date]
    );

    const bookedSet = new Set(bookedRes.rows.map((r) => r.start_time));

    // Dynamically generate slots from workingHoursStart and workingHoursEnd
    const [sh, sm] = (doc.workingHoursStart || '09:00').split(':').map((v) => parseInt(v, 10));
    const [eh, em] = (doc.workingHoursEnd || '18:00').split(':').map((v) => parseInt(v, 10));
    const startMin = sh * 60 + sm;
    const endMin = eh * 60 + em;
    const duration = doc.durationMinutes || 30;

    const slots: string[] = [];
    for (let cur = startMin; cur + duration <= endMin; cur += duration) {
      const h = Math.floor(cur / 60)
        .toString()
        .padStart(2, '0');
      const m = (cur % 60).toString().padStart(2, '0');
      const slotTime = `${h}:${m}`;
      if (!bookedSet.has(slotTime)) {
        slots.push(slotTime);
      }
    }
    return slots;
  }

  public async bookAppointment(input: BookingRequestInput): Promise<BookingResult> {
    const client = await this.pool.connect();

    try {
      // Begin transaction with SERIALIZABLE isolation level
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE');

      // 1. Idempotency Check
      const idemRes = await client.query('SELECT * FROM appointments WHERE idempotency_key = $1', [
        input.idempotencyKey,
      ]);
      if (idemRes.rows.length > 0) {
        await client.query('COMMIT');
        return {
          success: true,
          appointment: this.mapAppointmentRow(idemRes.rows[0]),
          error: 'IDEMPOTENT_REPLAY',
          message: 'Yeh appointment pehle hi book ho chuka hai (idempotent request).',
        };
      }

      // 2. Fetch Doctor
      const docRes = await client.query('SELECT * FROM doctors WHERE id = $1', [input.doctorId]);
      if (docRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return {
          success: false,
          error: 'INVALID_DOCTOR',
          message: `Doctor ${input.doctorId} nahi mile.`,
        };
      }
      const doctor = this.mapDoctorRow(docRes.rows[0]);

      // 3. Validate Working Hours & Slot validity
      const [sh, sm] = (doctor.workingHoursStart || '09:00').split(':').map((v) => parseInt(v, 10));
      const [eh, em] = (doctor.workingHoursEnd || '18:00').split(':').map((v) => parseInt(v, 10));
      const [th, tm] = input.startTime.split(':').map((v) => parseInt(v, 10));
      const startMin = sh * 60 + sm;
      const endMin = eh * 60 + em;
      const targetMin = th * 60 + tm;
      const duration = doctor.durationMinutes || 30;

      if (targetMin < startMin || targetMin + duration > endMin) {
        await client.query('ROLLBACK');
        return {
          success: false,
          error: 'OUTSIDE_WORKING_HOURS',
          message: `Dr. ${doctor.name} kewal ${doctor.workingHoursStart} se ${doctor.workingHoursEnd} tak hi baithte hain.`,
        };
      }

      if (
        doctor.availableSlots &&
        doctor.availableSlots.length > 0 &&
        !doctor.availableSlots.includes(input.startTime)
      ) {
        await client.query('ROLLBACK');
        return {
          success: false,
          error: 'INVALID_SLOT',
          message: `Slot ${input.startTime} is not valid for ${doctor.name}.`,
        };
      }

      // 4. Lock Slot Check (FOR UPDATE)
      const slotRes = await client.query(
        `SELECT id FROM appointments 
         WHERE doctor_id = $1 AND appointment_date = $2 AND start_time = $3 AND status = 'CONFIRMED'
         FOR UPDATE`,
        [input.doctorId, input.date, input.startTime]
      );

      if (slotRes.rows.length > 0) {
        await client.query('ROLLBACK');
        return {
          success: false,
          error: 'SLOT_ALREADY_BOOKED',
          message: `Slot ${input.startTime} on ${input.date} pehle se booked hai.`,
        };
      }

      // 5. Calculate End Time & UTC timestamps
      const [hours, minutes] = input.startTime.split(':').map((v) => parseInt(v, 10));
      const totalMinutes = hours * 60 + minutes + doctor.durationMinutes;
      const endH = Math.floor(totalMinutes / 60) % 24;
      const endM = totalMinutes % 60;
      const endTime = `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;

      const slotStartUtc = kolkataToUtc(input.date, input.startTime);
      const slotEndUtc = addMinutes(slotStartUtc, doctor.durationMinutes);

      // 6. Insert Appointment
      const id = `apt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const insertRes = await client.query(
        `INSERT INTO appointments 
         (id, doctor_id, patient_name, patient_phone_masked, appointment_date, start_time, end_time, duration_minutes, slot_start, slot_end, status, idempotency_key, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'CONFIRMED', $11, NOW())
         RETURNING *`,
        [
          id,
          doctor.id,
          input.patientName,
          maskPhone(input.patientPhone),
          input.date,
          input.startTime,
          endTime,
          doctor.durationMinutes,
          slotStartUtc.toISOString(),
          slotEndUtc.toISOString(),
          input.idempotencyKey,
        ]
      );

      const createdAppointment = this.mapAppointmentRow(insertRes.rows[0]);
      createdAppointment.doctorName = doctor.name;

      // 7. Write to outbox table inside same transaction
      const outboxId = `out_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      await client.query(
        `INSERT INTO outbox (id, event_type, payload, status, created_at)
         VALUES ($1, 'new_appointment', $2, 'PENDING', NOW())`,
        [outboxId, JSON.stringify(createdAppointment)]
      );

      await client.query('COMMIT');

      return {
        success: true,
        appointment: createdAppointment,
        message: `Appointment successfully booked with ${doctor.name} for ${input.date} at ${input.startTime}.`,
      };
    } catch (err: unknown) {
      await client.query('ROLLBACK');
      const pgErr = err as { code?: string };
      // PostgreSQL unique_violation error code = 23505
      if (pgErr.code === '23505') {
        return {
          success: false,
          error: 'SLOT_ALREADY_BOOKED',
          message: `Slot ${input.startTime} on ${input.date} pehle se booked hai (Unique constraint violation).`,
        };
      }
      throw err;
    } finally {
      client.release();
    }
  }

  public async saveCallbackRequest(
    callId: string,
    phone: string,
    reason: string,
    preferredSlot?: string
  ): Promise<CallbackRequest> {
    const id = `cb_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const res = await this.pool.query(
      `INSERT INTO callback_requests (id, call_id, patient_phone_masked, preferred_slot, reason, status, created_at)
       VALUES ($1, $2, $3, $4, $5, 'PENDING', NOW())
       RETURNING *`,
      [id, callId, maskPhone(phone), preferredSlot || null, reason]
    );
    return this.mapCallbackRow(res.rows[0]);
  }

  public async getAppointments(doctorId?: string, date?: string): Promise<Appointment[]> {
    let query = `
      SELECT a.*, d.name as doctor_name 
      FROM appointments a
      JOIN doctors d ON a.doctor_id = d.id
    `;
    const params: unknown[] = [];
    const conditions: string[] = [];

    if (doctorId) {
      params.push(doctorId);
      conditions.push(`a.doctor_id = $${params.length}`);
    }
    if (date) {
      params.push(date);
      conditions.push(`a.appointment_date = $${params.length}`);
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }
    query += ` ORDER BY a.created_at DESC`;

    const res = await this.pool.query(query, params);
    return res.rows.map(this.mapAppointmentRow);
  }

  public async getCallbackRequests(): Promise<CallbackRequest[]> {
    const res = await this.pool.query(`SELECT * FROM callback_requests ORDER BY created_at DESC`);
    return res.rows.map(this.mapCallbackRow);
  }

  public async saveOutboxEvent(
    id: string,
    eventType: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO outbox (id, event_type, payload, status, created_at)
       VALUES ($1, $2, $3, 'PENDING', NOW())`,
      [id, eventType, JSON.stringify(payload)]
    );
  }

  public async drainPendingOutbox(): Promise<any[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query(
        `SELECT * FROM outbox WHERE status = 'PENDING' ORDER BY created_at ASC LIMIT 50 FOR UPDATE SKIP LOCKED`
      );
      if (res.rows.length > 0) {
        const ids = res.rows.map((r) => r.id);
        await client.query(
          `UPDATE outbox SET status = 'PROCESSED', processed_at = NOW() WHERE id = ANY($1)`,
          [ids]
        );
      }
      await client.query('COMMIT');
      return res.rows.map((r) => ({
        id: r.id,
        eventType: r.event_type,
        payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
        status: r.status,
        createdAt: r.created_at,
      }));
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  public async cancelAppointment(
    appointmentId: string,
    reason?: string
  ): Promise<{ success: boolean; message: string }> {
    const res = await this.pool.query(
      `UPDATE appointments
       SET status = 'CANCELLED', cancellation_reason = $1, updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [reason || 'Cancelled by doctor/patient', appointmentId]
    );
    if (res.rows.length === 0) {
      return { success: false, message: 'Appointment not found' };
    }
    const apt = this.mapAppointmentRow(res.rows[0]);
    await this.saveOutboxEvent(`out_cancel_${Date.now()}`, 'appointment_cancelled', apt as any);
    return { success: true, message: `Appointment ${appointmentId} has been cancelled.` };
  }

  public async completeAppointment(
    appointmentId: string
  ): Promise<{ success: boolean; message: string }> {
    const res = await this.pool.query(
      `UPDATE appointments
       SET status = 'COMPLETED', updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [appointmentId]
    );
    if (res.rows.length === 0) {
      return { success: false, message: 'Appointment not found' };
    }
    const apt = this.mapAppointmentRow(res.rows[0]);
    await this.saveOutboxEvent(`out_comp_${Date.now()}`, 'appointment_completed', apt as any);
    return { success: true, message: `Appointment ${appointmentId} marked as completed.` };
  }

  public async rescheduleAppointment(
    appointmentId: string,
    newDate: string,
    newStartTime: string
  ): Promise<BookingResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE');
      const aptRes = await client.query('SELECT * FROM appointments WHERE id = $1', [
        appointmentId,
      ]);
      if (aptRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return { success: false, error: 'INVALID_DOCTOR', message: 'Appointment not found.' };
      }
      const existing = aptRes.rows[0];

      const doc = await this.getDoctorById(existing.doctor_id);
      if (!doc) {
        await client.query('ROLLBACK');
        return { success: false, error: 'INVALID_DOCTOR', message: 'Doctor not found.' };
      }

      // Check conflict
      const conflictRes = await client.query(
        `SELECT id FROM appointments 
         WHERE doctor_id = $1 AND appointment_date = $2 AND start_time = $3 AND status = 'CONFIRMED' AND id != $4 
         FOR UPDATE`,
        [existing.doctor_id, newDate, newStartTime, appointmentId]
      );
      if (conflictRes.rows.length > 0) {
        await client.query('ROLLBACK');
        return {
          success: false,
          error: 'SLOT_ALREADY_BOOKED',
          message: `Slot ${newStartTime} on ${newDate} is already booked.`,
        };
      }

      const duration = existing.duration_minutes || doc.durationMinutes || 30;
      const [hours, minutes] = newStartTime.split(':').map((v) => parseInt(v, 10));
      const totalMinutes = hours * 60 + minutes + duration;
      const endH = Math.floor(totalMinutes / 60) % 24;
      const endM = totalMinutes % 60;
      const newEndTime = `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;

      const slotStartUtc = kolkataToUtc(newDate, newStartTime);
      const slotEndUtc = addMinutes(slotStartUtc, duration);

      const updateRes = await client.query(
        `UPDATE appointments 
         SET appointment_date = $1, start_time = $2, end_time = $3, slot_start = $4, slot_end = $5, status = 'CONFIRMED', updated_at = NOW()
         WHERE id = $6 RETURNING *`,
        [
          newDate,
          newStartTime,
          newEndTime,
          slotStartUtc.toISOString(),
          slotEndUtc.toISOString(),
          appointmentId,
        ]
      );

      await client.query('COMMIT');
      const updatedApt = this.mapAppointmentRow(updateRes.rows[0]);
      updatedApt.doctorName = doc.name;
      await this.saveOutboxEvent(
        `out_resched_${Date.now()}`,
        'appointment_rescheduled',
        updatedApt as any
      );
      return {
        success: true,
        appointment: updatedApt,
        message: `Appointment rescheduled to ${newDate} at ${newStartTime}.`,
      };
    } catch (err: unknown) {
      await client.query('ROLLBACK');
      const pgErr = err as { code?: string };
      if (pgErr.code === '23505') {
        return {
          success: false,
          error: 'SLOT_ALREADY_BOOKED',
          message: `Slot ${newStartTime} on ${newDate} is already booked.`,
        };
      }
      throw err;
    } finally {
      client.release();
    }
  }

  public async resolveCallbackRequest(
    callbackId: string
  ): Promise<{ success: boolean; message: string }> {
    const res = await this.pool.query(
      `UPDATE callback_requests SET status = 'RESOLVED' WHERE id = $1 RETURNING *`,
      [callbackId]
    );
    if (res.rows.length === 0) {
      return { success: false, message: 'Callback request not found' };
    }
    return { success: true, message: `Callback request ${callbackId} resolved.` };
  }

  private mapDoctorRow(row: Record<string, unknown>): Doctor {
    return {
      id: String(row.id),
      name: String(row.name),
      specialty: String(row.specialty),
      workingHoursStart: String(row.working_hours_start || '09:00'),
      workingHoursEnd: String(row.working_hours_end || '18:00'),
      durationMinutes: Number(row.duration_minutes || 30),
      fee: Number(row.fee || 500),
      activeDays: (row.active_days as string[]) || [],
      availableSlots: (row.available_slots as string[]) || [],
    };
  }

  private mapAppointmentRow(row: Record<string, unknown>): Appointment {
    return {
      id: String(row.id),
      doctorId: String(row.doctor_id),
      doctorName: row.doctor_name ? String(row.doctor_name) : undefined,
      patientName: String(row.patient_name),
      patientPhoneMasked: String(row.patient_phone_masked),
      appointmentDate: String(row.appointment_date).slice(0, 10),
      startTime: String(row.start_time),
      endTime: String(row.end_time),
      durationMinutes: Number(row.duration_minutes),
      status: (row.status as Appointment['status']) || 'CONFIRMED',
      idempotencyKey: String(row.idempotency_key),
      visitType: (row.visit_type as string) || 'General Consultation',
      reason: (row.reason as string) || 'Clinical consultation & follow-up',
      aiSummary:
        (row.ai_summary as string) ||
        `Booked via Appointly Voice AI triage for ${String(row.patient_name)}. Patient triage completed, confirmed without red flags.`,
      createdAt: new Date(String(row.created_at)),
    };
  }

  private mapCallbackRow(row: Record<string, unknown>): CallbackRequest {
    return {
      id: String(row.id),
      callId: String(row.call_id),
      patientPhoneMasked: String(row.patient_phone_masked),
      preferredSlot: row.preferred_slot ? String(row.preferred_slot) : undefined,
      reason: String(row.reason),
      status: row.status as CallbackRequest['status'],
      createdAt: new Date(String(row.created_at)),
    };
  }
}
