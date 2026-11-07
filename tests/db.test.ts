import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryDatabaseClient } from '../src/db/memory-db.js';

describe('Database Transaction & Concurrency Controls', () => {
  let db: MemoryDatabaseClient;

  beforeEach(() => {
    db = new MemoryDatabaseClient();
  });

  it('should list pre-seeded clinic doctors', async () => {
    const doctors = await db.getDoctors();
    expect(doctors.length).toBeGreaterThan(0);
    const sharma = doctors.find((d) => d.id === 'dr_sharma');
    expect(sharma).toBeDefined();
    expect(sharma?.specialty).toContain('General Medicine');
  });

  it('should book an appointment successfully within transaction', async () => {
    const booking = await db.bookAppointment({
      doctorId: 'dr_sharma',
      date: '2026-11-10',
      startTime: '09:30',
      patientName: 'Aarav Mehta',
      patientPhone: '+91 98765 43210',
      idempotencyKey: 'idem_test_001',
    });

    expect(booking.success).toBe(true);
    expect(booking.appointment).toBeDefined();
    expect(booking.appointment?.doctorName).toBe('Dr. Ramesh Sharma');
    expect(booking.appointment?.startTime).toBe('09:30');
    expect(booking.appointment?.endTime).toBe('10:00');
    expect(booking.appointment?.durationMinutes).toBe(30);
    expect(booking.appointment?.patientPhoneMasked).toBe('+91 ******3210');
  });

  it('NON-NEGOTIABLE RULE 2: should strictly prevent double-booking on same doctor, date & time', async () => {
    // First booking succeeds
    const first = await db.bookAppointment({
      doctorId: 'dr_priya',
      date: '2026-11-12',
      startTime: '10:00',
      patientName: 'Sunita Roy',
      patientPhone: '9876543210',
      idempotencyKey: 'idem_user_1',
    });
    expect(first.success).toBe(true);

    // Second booking on same slot MUST fail
    const second = await db.bookAppointment({
      doctorId: 'dr_priya',
      date: '2026-11-12',
      startTime: '10:00',
      patientName: 'Vikas Gupta',
      patientPhone: '9123456789',
      idempotencyKey: 'idem_user_2',
    });
    expect(second.success).toBe(false);
    expect(second.error).toBe('SLOT_ALREADY_BOOKED');
    expect(second.message).toContain('pehle se booked hai');
  });

  it('should handle concurrent race condition: exactly 1 succeeds among 20 simultaneous requests', async () => {
    const slot = '17:00'; // Dr. Rajesh evening slot
    const date = '2026-11-15';
    const attempts = 20;

    const promises = Array.from({ length: attempts }, (_, i) =>
      db.bookAppointment({
        doctorId: 'dr_rajesh',
        date,
        startTime: slot,
        patientName: `Patient ${i}`,
        patientPhone: `98765432${String(i).padStart(2, '0')}`,
        idempotencyKey: `race_idem_${i}`,
      })
    );

    const results = await Promise.all(promises);
    const successful = results.filter((r) => r.success);
    const rejected = results.filter((r) => !r.success && r.error === 'SLOT_ALREADY_BOOKED');

    expect(successful.length).toBe(1);
    expect(rejected.length).toBe(attempts - 1);
  });

  it('should return IDEMPOTENT_REPLAY if same idempotency key is resent', async () => {
    const payload = {
      doctorId: 'dr_ananya',
      date: '2026-11-18',
      startTime: '10:30',
      patientName: 'Kavita Verma',
      patientPhone: '9988776655',
      idempotencyKey: 'same_key_retry',
    };

    const first = await db.bookAppointment(payload);
    expect(first.success).toBe(true);

    const retry = await db.bookAppointment(payload);
    expect(retry.success).toBe(true);
    expect(retry.error).toBe('IDEMPOTENT_REPLAY');
    expect(retry.appointment?.id).toBe(first.appointment?.id);
  });

  it('should save and retrieve callback requests upon booking failure or drop', async () => {
    const cb = await db.saveCallbackRequest('call_101', '9876543210', 'Preferred slot 09:30 was full', '09:30 AM');
    expect(cb.id).toBeDefined();
    expect(cb.status).toBe('PENDING');
    expect(cb.patientPhoneMasked).toBe('+91 ******3210');

    const list = await db.getCallbackRequests();
    expect(list.some((item) => item.callId === 'call_101')).toBe(true);
  });
});
