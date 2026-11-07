import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { createServer } from '../src/index.js';
import { getDatabaseClient, MemoryDatabaseClient } from '../src/db/index.js';
import { BookingCoreService } from '../src/services/booking-service.js';
import dotenv from 'dotenv';

dotenv.config();

const dbUrl = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/appointly';

describe('Doctor Dynamic Schedule Configuration & Agent Synchronization', () => {
  let server: http.Server;
  const testPort = 3198;
  const memoryDb = new MemoryDatabaseClient();
  let bookingService: BookingCoreService;

  beforeAll(async () => {
    bookingService = new BookingCoreService(dbUrl, { max: 10 });
    const pool = bookingService.getPool();
    // Clean up test records for dr_priya on test dates
    await pool.query(
      `DELETE FROM appointments WHERE doctor_id = 'dr_priya' AND (appointment_date >= '2026-12-01' OR slot_start >= '2026-12-01')`
    );
    await pool.query(
      `DELETE FROM slot_holds WHERE doctor_id = 'dr_priya' AND (slot_start >= '2026-12-01')`
    );

    const db = getDatabaseClient();
    await db.initialize();
    server = createServer();
    await new Promise<void>((resolve) => server.listen(testPort, () => resolve()));
  }, 30000);

  afterAll(async () => {
    try {
      const pool = bookingService.getPool();
      await pool.query(
        `DELETE FROM appointments WHERE doctor_id = 'dr_priya' AND (appointment_date >= '2026-12-01' OR slot_start >= '2026-12-01')`
      );
      await pool.query(
        `DELETE FROM slot_holds WHERE doctor_id = 'dr_priya' AND slot_start >= '2026-12-01'`
      );
      // Restore Dr. Priya's default schedule
      await bookingService.updateDoctorSchedule('dr_priya', {
        workingHoursStart: '10:00',
        workingHoursEnd: '18:00',
        activeDays: ['Monday', 'Wednesday', 'Friday', 'Saturday'],
        durationMinutes: 30,
        fee: 600,
      });
    } catch {
      // ignore
    }
    await bookingService.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }, 30000);

  const requestJson = (
    method: string,
    path: string,
    data?: any
  ): Promise<{ status?: number; data: any }> => {
    return new Promise((resolve, reject) => {
      const payload = data ? JSON.stringify(data) : '';
      const req = http.request(
        `http://localhost:${testPort}${path}`,
        {
          method,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode, data: JSON.parse(body || '{}') });
            } catch {
              resolve({ status: res.statusCode, data: body });
            }
          });
        }
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  };

  it('1. MemoryDatabaseClient: doctor can configure evening OPD timing (17:00 - 22:00)', async () => {
    const updated = await memoryDb.updateDoctorSchedule('dr_priya', {
      workingHoursStart: '17:00',
      workingHoursEnd: '22:00',
      activeDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
      durationMinutes: 30,
      fee: 650,
    });

    expect(updated.workingHoursStart).toBe('17:00');
    expect(updated.workingHoursEnd).toBe('22:00');
    expect(updated.fee).toBe(650);

    // Dynamic slot generation should ONLY have evening slots (17:00 to 21:30)
    const slots = await memoryDb.getAvailableSlots('dr_priya', '2026-12-01');
    expect(slots.length).toBe(10); // 17:00, 17:30, 18:00, 18:30, 19:00, 19:30, 20:00, 20:30, 21:00, 21:30
    expect(slots[0]).toBe('17:00');
    expect(slots[slots.length - 1]).toBe('21:30');
    expect(slots.includes('09:30')).toBe(false);
    expect(slots.includes('10:00')).toBe(false);
  });

  it('2. MemoryDatabaseClient: booking outside working hours is rejected with OUTSIDE_WORKING_HOURS', async () => {
    const res = await memoryDb.bookAppointment({
      doctorId: 'dr_priya',
      date: '2026-12-01',
      startTime: '10:00', // morning slot when doctor sits 17:00 - 22:00
      patientName: 'Amit Verma',
      patientPhone: '9876543210',
      idempotencyKey: `idem_test_priya_out_${Date.now()}`,
    });

    expect(res.success).toBe(false);
    expect(res.error).toBe('OUTSIDE_WORKING_HOURS');
    expect(res.message).toContain('17:00 se 22:00 tak');
  });

  it('3. MemoryDatabaseClient: booking within updated evening hours succeeds', async () => {
    const res = await memoryDb.bookAppointment({
      doctorId: 'dr_priya',
      date: '2026-12-01',
      startTime: '17:30',
      patientName: 'Amit Verma',
      patientPhone: '9876543210',
      idempotencyKey: `idem_test_priya_evening_${Date.now()}`,
    });

    expect(res.success).toBe(true);
    expect(res.appointment).toBeDefined();
    expect(res.appointment?.startTime).toBe('17:30');
  });

  it('4. HTTP API: PUT /api/doctors/:id/schedule validates and updates schedule', async () => {
    const res = await requestJson('PUT', '/api/doctors/dr_priya/schedule', {
      workingHoursStart: '17:00',
      workingHoursEnd: '22:00',
      activeDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
      durationMinutes: 30,
      fee: 750,
    });

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.doctor.workingHoursStart).toBe('17:00');
    expect(res.data.doctor.workingHoursEnd).toBe('22:00');
    expect(res.data.doctor.fee).toBe(750);

    // Verify GET /api/doctors returns the updated timing
    const docRes = await requestJson('GET', '/api/doctors');
    expect(docRes.status).toBe(200);
    const doc = docRes.data.find((d: any) => d.id === 'dr_priya');
    expect(doc.workingHoursStart).toBe('17:00');
    expect(doc.workingHoursEnd).toBe('22:00');
  });

  it('5. HTTP API: PUT /api/doctors/:id/schedule rejects invalid start >= end times', async () => {
    const res = await requestJson('PUT', '/api/doctors/dr_priya/schedule', {
      workingHoursStart: '20:00',
      workingHoursEnd: '10:00', // invalid: start is later than end
      activeDays: ['Monday'],
    });

    expect(res.status).toBe(400);
    expect(res.data.error).toBe('INVALID_SCHEDULE_DATA');
  });

  it('6. BookingCoreService: holdSlot rejects slot outside configured doctor hours', async () => {
    // Configure Dr. Priya for evening OPD 17:00 - 22:00 in BookingCoreService
    await bookingService.updateDoctorSchedule('dr_priya', {
      workingHoursStart: '17:00',
      workingHoursEnd: '22:00',
      activeDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
      durationMinutes: 30,
    });

    const testDate = '2026-12-08'; // Tuesday
    const morningTime = '09:30';
    const refNow = new Date('2026-12-08T03:00:00.000Z');

    const holdRes = await bookingService.holdSlot(
      {
        doctorId: 'dr_priya',
        date: testDate,
        startTime: morningTime,
        patientPhone: '9876543210',
      },
      refNow
    );

    expect(holdRes.success).toBe(false);
    expect(holdRes.error).toBe('OUTSIDE_WORKING_HOURS');
    expect(holdRes.message).toContain('17:00 se 22:00');
  });

  it('7. BookingCoreService: checkSlots reflects updated 17:00 - 22:00 schedule', async () => {
    const testDate = '2026-12-08'; // Tuesday
    const refNow = new Date('2026-12-08T03:00:00.000Z');

    const slotsResult = await bookingService.checkSlots('dr_priya', testDate, undefined, refNow);
    expect(slotsResult.availableSlots.length).toBeGreaterThan(0);
    expect(slotsResult.availableSlots[0].timeKolkata).toBe('17:00');
    expect(slotsResult.availableSlots[slotsResult.availableSlots.length - 1].timeKolkata).toBe(
      '21:30'
    );
    expect(slotsResult.availableSlots.some((s) => s.timeKolkata === '09:00')).toBe(false);
  });

  it('8. BookingCoreService: booking on an inactive day is rejected', async () => {
    // Set Dr. Rajesh to only sit on Tuesday, Thursday, Saturday
    const testDate = '2026-12-06'; // Sunday
    const eveningTime = '17:00';
    const refNow = new Date('2026-12-06T03:00:00.000Z');

    const bookRes = await bookingService.bookAppointment(
      {
        doctorId: 'dr_rajesh',
        date: testDate,
        startTime: eveningTime,
        patientName: 'Sunil Gupta',
        patientPhone: '9876543210',
        idempotencyKey: `idem_sunday_priya_test_${Date.now()}`,
      },
      refNow
    );

    expect(bookRes.success).toBe(false);
    expect(bookRes.error).toBe('OUTSIDE_WORKING_HOURS');
    expect(bookRes.message).toContain('available nahi hain');
  });

  it('9. Voice Agent /api/chat: queries doctor roster and returns timing in Hinglish', async () => {
    const res = await requestJson('POST', '/api/chat', {
      text: 'Hamare clinic me kaunse doctors uplabdh hain?',
      callId: `call_chat_docs_${Date.now()}`,
      phone: '9876543210',
    });

    expect(res.status).toBe(200);
    expect(res.data.replyText).toContain('Dr. Priya Patel');
    expect(res.data.replyText).toContain('Timing: 17:00 - 22:00');
  });

  it('10. Voice Agent /api/chat: books appointment in evening and confirms with doctor, date, time, duration', async () => {
    // Use an isolated future Wednesday date (2026-12-16)
    const res = await requestJson('POST', '/api/chat', {
      text: 'Mujhe Dr. Priya ke sath 2026-12-16 shaam 17:30 baje appointment book karna hai.',
      callId: `call_chat_book_priya_${Date.now()}`,
      phone: '9876543210',
    });

    expect(res.status).toBe(200);
    expect(res.data.replyText).toContain('confirm ho gaya hai');
    expect(res.data.replyText).toContain('Dr. Priya Patel');
    expect(res.data.replyText).toContain('17:30');
    expect(res.data.replyText).toContain('Duration: 30 minutes');
  });
});
