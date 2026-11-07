import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import dotenv from 'dotenv';
import { BookingCoreService } from '../src/services/booking-service.js';
import { kolkataToUtc, addMinutes } from '../src/utils/timezone.js';

dotenv.config();

const dbUrl = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/appointly';

describe('Phase 2: Database and Booking Core Service', () => {
  let service: BookingCoreService;

  beforeAll(async () => {
    service = new BookingCoreService(dbUrl, { max: 60 });
    const pool = service.getPool();
    // Clean up test date range to ensure complete isolation
    await pool.query(`DELETE FROM outbox WHERE created_at >= NOW() - INTERVAL '1 hour'`);
    await pool.query(
      `DELETE FROM appointments WHERE doctor_id = 'dr_sharma' AND slot_start >= '2026-12-01'`
    );
    await pool.query(
      `DELETE FROM slot_holds WHERE doctor_id = 'dr_sharma' AND slot_start >= '2026-12-01'`
    );
  }, 30000);

  afterAll(async () => {
    const pool = service.getPool();
    await pool.query(
      `DELETE FROM appointments WHERE doctor_id = 'dr_sharma' AND slot_start >= '2026-12-01'`
    );
    await pool.query(
      `DELETE FROM slot_holds WHERE doctor_id = 'dr_sharma' AND slot_start >= '2026-12-01'`
    );
    await service.close();
  }, 30000);

  it('checkSlots: retrieves valid slots for Dr. Sharma on a working weekday', async () => {
    // 2026-12-01 is a Tuesday
    const testDate = '2026-12-01';
    const result = await service.checkSlots(
      'dr_sharma',
      testDate,
      'general_consultation',
      kolkataToUtc('2026-12-01', '06:00')
    );

    expect(result.doctor.id).toBe('dr_sharma');
    expect(result.appointmentType.id).toBe('general_consultation');
    expect(result.allSlots.length).toBeGreaterThan(0);
    expect(result.availableSlots.length).toBeGreaterThan(0);
    expect(result.availableSlots[0].timeKolkata).toBe('09:00');
  }, 30000);

  it('holdSlot: reserves a slot with a 2-minute TTL and blocks concurrent holds', async () => {
    const testDate = '2026-12-02'; // Wednesday
    const testTime = '09:00';
    const refNow = new Date('2026-12-02T03:00:00.000Z'); // 08:30 AM IST

    const holdResult = await service.holdSlot(
      {
        doctorId: 'dr_sharma',
        date: testDate,
        startTime: testTime,
        patientPhone: '9876543210',
        appointmentTypeId: 'general_consultation',
      },
      refNow
    );

    expect(holdResult.success).toBe(true);
    expect(holdResult.holdToken).toBeDefined();
    expect(holdResult.expiresAt).toBeDefined();

    // Check TTL is exactly 2 minutes
    const ttlMs = (holdResult.expiresAt?.getTime() || 0) - refNow.getTime();
    expect(ttlMs).toBe(2 * 60 * 1000);

    // Attempting to hold the same slot while active should fail with SLOT_UNAVAILABLE
    const secondHold = await service.holdSlot(
      {
        doctorId: 'dr_sharma',
        date: testDate,
        startTime: testTime,
        patientPhone: '9876543211',
      },
      refNow
    );

    expect(secondHold.success).toBe(false);
    expect(secondHold.error).toBe('SLOT_UNAVAILABLE');
  }, 30000);

  it('holdSlot: allows booking or holding after a previous hold has expired', async () => {
    const testDate = '2026-12-03';
    const testTime = '10:00';
    // Reference now when hold was created:
    const initialTime = new Date('2026-12-03T03:00:00.000Z');

    const firstHold = await service.holdSlot(
      {
        doctorId: 'dr_sharma',
        date: testDate,
        startTime: testTime,
        patientPhone: '9876543210',
      },
      initialTime
    );
    expect(firstHold.success).toBe(true);

    // Now reference time is 3 minutes later (after the 2-minute TTL expired)
    const afterExpiryTime = addMinutes(initialTime, 3);

    const secondHold = await service.holdSlot(
      {
        doctorId: 'dr_sharma',
        date: testDate,
        startTime: testTime,
        patientPhone: '9876543299',
      },
      afterExpiryTime
    );

    expect(secondHold.success).toBe(true);
    expect(secondHold.holdToken).toBeDefined();
  }, 30000);

  it('bookAppointment: converts active hold and creates confirmed appointment', async () => {
    const testDate = '2026-12-04';
    const testTime = '11:00';
    const refNow = new Date('2026-12-04T04:00:00.000Z');

    const hold = await service.holdSlot(
      {
        doctorId: 'dr_sharma',
        date: testDate,
        startTime: testTime,
        patientPhone: '9123456789',
      },
      refNow
    );
    expect(hold.success).toBe(true);

    const bookingResult = await service.bookAppointment(
      {
        doctorId: 'dr_sharma',
        date: testDate,
        startTime: testTime,
        patientName: 'Sunita Verma',
        patientPhone: '9123456789',
        idempotencyKey: `idem_hold_${Date.now()}_${Math.random()}`,
        holdToken: hold.holdToken,
      },
      refNow
    );

    expect(bookingResult.success).toBe(true);
    expect(bookingResult.appointment).toBeDefined();
    expect(bookingResult.appointment?.status).toBe('CONFIRMED');
    expect(bookingResult.appointment?.patientName).toBe('Sunita Verma');
  }, 30000);

  it('idempotency test: duplicate call with same idempotency_key returns identical appointment', async () => {
    const testDate = '2026-12-05';
    const testTime = '10:00';
    const idempotencyKey = `idem_duplicate_test_${Date.now()}_${Math.random()}`;

    // First booking
    const firstCall = await service.bookAppointment({
      doctorId: 'dr_sharma',
      date: testDate,
      startTime: testTime,
      patientName: 'Amit Kapoor',
      patientPhone: '9811122233',
      idempotencyKey,
    });

    expect(firstCall.success).toBe(true);
    expect(firstCall.appointment?.id).toBeDefined();
    const originalAppointmentId = firstCall.appointment?.id;

    // Second booking with EXACT same key
    const secondCall = await service.bookAppointment({
      doctorId: 'dr_sharma',
      date: testDate,
      startTime: testTime,
      patientName: 'Amit Kapoor',
      patientPhone: '9811122233',
      idempotencyKey,
    });

    expect(secondCall.success).toBe(true);
    expect(secondCall.error).toBe('IDEMPOTENT_REPLAY');
    expect(secondCall.appointment?.id).toBe(originalAppointmentId);

    // Verify database only contains 1 appointment for this key
    const pool = service.getPool();
    const countRes = await pool.query(
      'SELECT count(*) as count FROM appointments WHERE idempotency_key = $1',
      [idempotencyKey]
    );
    expect(parseInt(countRes.rows[0].count, 10)).toBe(1);
  }, 30000);

  it('concurrency test: 50 parallel bookings for the SAME slot -> exactly ONE succeeds', async () => {
    // Unique timestamp-based slot date/time for concurrency race
    const testDate = '2026-12-11';
    const testTime = '11:00';
    const concurrencyCount = 50;

    console.log(
      `Firing ${concurrencyCount} simultaneous parallel booking requests for slot ${testDate} ${testTime}...`
    );

    // Prepare 50 concurrent booking requests
    const promises = Array.from({ length: concurrencyCount }, (_, i) => {
      const patientPhone = `98000000${String(i).padStart(2, '0')}`;
      const idempotencyKey = `concurrency_race_${Date.now()}_patient_${i}`;

      return service.bookAppointment({
        doctorId: 'dr_sharma',
        date: testDate,
        startTime: testTime,
        patientName: `Parallel Patient ${i + 1}`,
        patientPhone,
        idempotencyKey,
      });
    });

    // Execute all 50 in parallel simultaneously
    const results = await Promise.allSettled(promises);

    let successCount = 0;
    let slotAlreadyBookedCount = 0;
    let otherErrors = 0;

    for (const r of results) {
      if (r.status === 'fulfilled') {
        if (r.value.success) {
          successCount++;
        } else if (r.value.error === 'SLOT_ALREADY_BOOKED') {
          slotAlreadyBookedCount++;
        } else {
          otherErrors++;
          console.warn('Unexpected error:', r.value);
        }
      } else {
        otherErrors++;
        console.error('Promise rejected:', r.reason);
      }
    }

    console.log(
      `Concurrency Results: ${successCount} succeeded, ${slotAlreadyBookedCount} rejected with SLOT_ALREADY_BOOKED, ${otherErrors} other`
    );

    // NON-NEGOTIABLE ACCEPTANCE CRITERION:
    // Exactly ONE succeeds, and exactly 49 are rejected with SLOT_ALREADY_BOOKED!
    expect(successCount).toBe(1);
    expect(slotAlreadyBookedCount).toBe(concurrencyCount - 1);
    expect(otherErrors).toBe(0);

    // Verify in database: exactly 1 confirmed appointment exists for dr_sharma on that slot
    const pool = service.getPool();
    const slotStartUtc = kolkataToUtc(testDate, testTime);
    const dbCheck = await pool.query(
      `SELECT count(*) as count 
       FROM appointments 
       WHERE doctor_id = 'dr_sharma' 
         AND slot_start = $1 
         AND status = 'CONFIRMED'`,
      [slotStartUtc.toISOString()]
    );

    expect(parseInt(dbCheck.rows[0].count, 10)).toBe(1);
  }, 45000);

  it('rescheduleAppointment: moves appointment to a new slot and frees old slot', async () => {
    const originalDate = '2026-12-15';
    const originalTime = '17:00';
    const newDate = '2026-12-15';
    const newTime = '17:30';

    // 1. Book original
    const booking = await service.bookAppointment({
      doctorId: 'dr_sharma',
      date: originalDate,
      startTime: originalTime,
      patientName: 'Rohan Mehra',
      patientPhone: '9822233344',
      idempotencyKey: `idem_reschedule_${Date.now()}_${Math.random()}`,
    });

    expect(booking.success).toBe(true);
    const appointmentId = booking.appointment!.id;

    // 2. Reschedule to new slot
    const reschedule = await service.rescheduleAppointment(
      appointmentId,
      newDate,
      newTime,
      `idem_reschedule_moved_${Date.now()}_${Math.random()}`
    );

    expect(reschedule.success).toBe(true);
    expect(reschedule.appointment?.startTime).toBe(newTime);

    // 3. Verify original slot is now FREE and can be booked by someone else!
    const rebookOriginal = await service.bookAppointment({
      doctorId: 'dr_sharma',
      date: originalDate,
      startTime: originalTime,
      patientName: 'New Patient On Freed Slot',
      patientPhone: '9833344455',
      idempotencyKey: `idem_rebook_freed_${Date.now()}_${Math.random()}`,
    });

    expect(rebookOriginal.success).toBe(true);
  }, 30000);

  it('cancelAppointment: cancels appointment and frees slot for new booking', async () => {
    const testDate = '2026-12-16';
    const testTime = '17:00';

    // 1. Book appointment
    const booking = await service.bookAppointment({
      doctorId: 'dr_sharma',
      date: testDate,
      startTime: testTime,
      patientName: 'Kavita Singh',
      patientPhone: '9844455566',
      idempotencyKey: `idem_cancel_${Date.now()}_${Math.random()}`,
    });

    expect(booking.success).toBe(true);
    const appointmentId = booking.appointment!.id;

    // 2. Cancel appointment
    const cancelRes = await service.cancelAppointment(
      appointmentId,
      'Patient had travel emergency'
    );

    expect(cancelRes.success).toBe(true);
    expect(cancelRes.appointment?.status).toBe('CANCELLED');

    // 3. Verify that the slot is now FREE to be booked again
    const secondBooking = await service.bookAppointment({
      doctorId: 'dr_sharma',
      date: testDate,
      startTime: testTime,
      patientName: 'Vikram Seth',
      patientPhone: '9855566677',
      idempotencyKey: `idem_rebook_cancelled_${Date.now()}_${Math.random()}`,
    });

    expect(secondBooking.success).toBe(true);
    expect(secondBooking.appointment?.patientName).toBe('Vikram Seth');
  }, 30000);
});
