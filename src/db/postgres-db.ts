/**
 * PostgreSQL Database Client for Appointly
 * Enforces PostgreSQL transactions with SERIALIZABLE isolation and FOR UPDATE locks.
 */

import pg from 'pg';
import { IDatabaseClient } from './client.js';
import { Doctor, Appointment, CallbackRequest, BookingRequestInput, BookingResult } from '../types/index.js';
import { maskPhone, rootLogger } from '../logger/logger.js';
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
      rootLogger.warn('Could not auto-apply schema.sql on Postgres (tables might already exist):', err);
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

  public async getAvailableSlots(doctorId: string, date: string): Promise<string[]> {
    const doc = await this.getDoctorById(doctorId);
    if (!doc) return [];

    const bookedRes = await this.pool.query(
      `SELECT start_time FROM appointments WHERE doctor_id = $1 AND appointment_date = $2 AND status = 'CONFIRMED'`,
      [doctorId, date]
    );

    const bookedSet = new Set(bookedRes.rows.map((r) => r.start_time));
    return doc.availableSlots.filter((slot) => !bookedSet.has(slot));
  }

  public async bookAppointment(input: BookingRequestInput): Promise<BookingResult> {
    const client = await this.pool.connect();

    try {
      // Begin transaction with SERIALIZABLE isolation level
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE');

      // 1. Idempotency Check
      const idemRes = await client.query('SELECT * FROM appointments WHERE idempotency_key = $1', [input.idempotencyKey]);
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

      // 3. Check Slot validity
      if (!doctor.availableSlots.includes(input.startTime)) {
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

      // 5. Calculate End Time
      const [hours, minutes] = input.startTime.split(':').map((v) => parseInt(v, 10));
      const totalMinutes = hours * 60 + minutes + doctor.durationMinutes;
      const endH = Math.floor(totalMinutes / 60) % 24;
      const endM = totalMinutes % 60;
      const endTime = `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;

      // 6. Insert Appointment
      const id = `apt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const insertRes = await client.query(
        `INSERT INTO appointments 
         (id, doctor_id, patient_name, patient_phone_masked, appointment_date, start_time, end_time, duration_minutes, status, idempotency_key, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'CONFIRMED', $9, NOW())
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
          input.idempotencyKey,
        ]
      );

      await client.query('COMMIT');

      const createdAppointment = this.mapAppointmentRow(insertRes.rows[0]);
      createdAppointment.doctorName = doctor.name;

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

  private mapDoctorRow(row: Record<string, unknown>): Doctor {
    return {
      id: String(row.id),
      name: String(row.name),
      specialty: String(row.specialty),
      durationMinutes: Number(row.duration_minutes),
      fee: Number(row.fee),
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
      status: row.status as Appointment['status'],
      idempotencyKey: String(row.idempotency_key),
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

