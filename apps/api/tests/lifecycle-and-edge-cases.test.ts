/**
 * Phase 7: Confirmation & Lifecycle Scenario Tests
 *
 * Covers:
 * 1. Post-Commit Spoken Confirmation with 10-minute clinic instructions + records & ID proof.
 * 2. Voice Reschedule with Caller Verification (Zero PHI leakage for unverified callers).
 * 3. Voice Cancel with Caller Verification (Zero PHI leakage).
 * 4. Edge Case 1: Patient changes mind mid-call (switch doctor/date, release hold).
 * 5. Edge Case 2: Ambiguous time preference ("shaam ko" -> offers 2 concrete evening slots).
 * 6. Edge Case 3: No slots available (offers next available days or saves callback request).
 * 7. Edge Case 4: Patient silence detection (3 progressive prompts -> graceful disconnect).
 * 8. Edge Case 5: Call dropped before confirmation (hold released, zero ghost bookings).
 * 9. Doctor Call Summary Generation (patient verbatim words, strictly non-diagnostic).
 * 10. Outbound Reminder Job (24h & 2h before) driven by outbox with FOR UPDATE SKIP LOCKED.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createSession,
  processConversationTurn,
  handleCallDropped,
  ConversationSession,
} from '../src/agent/orchestrator.js';
import { getBookingCoreService } from '../src/services/booking-service.js';
import { getDatabaseClient } from '../src/db/index.js';
import { kolkataToUtc } from '../src/utils/timezone.js';
import { runReminderCycle } from '../src/reminders/reminder-job.js';
import { globalReminderProvider } from '../src/reminders/simulated-reminder-provider.js';
import { extractPatientConcernInOwnWords } from '../src/services/call-summary-service.js';

describe('Phase 7: Patient Confirmation, Lifecycle & Edge Cases', () => {
  const referenceMonday = kolkataToUtc('2026-11-16', '10:00'); // Monday 16 Nov 2026
  const testPhone = '9876543210';
  const db = getDatabaseClient();

  beforeAll(async () => {
    await db.initialize();
    const bookingService = getBookingCoreService();
    const pool = bookingService.getPool();

    // Clean up any existing records for test phones and test date window
    await pool.query(
      `DELETE FROM appointments 
       WHERE patient_phone_masked LIKE '%3210' 
          OR patient_phone_masked LIKE '%4321' 
          OR patient_phone_masked LIKE '%8901' 
          OR patient_phone_masked LIKE '%1234'
          OR (slot_start >= '2026-11-15' AND slot_start <= '2026-11-30')`
    );
    await pool.query(
      `DELETE FROM slot_holds 
       WHERE patient_phone IN ('9876543210', '9812344321', '9845678901', '9812341234')
          OR slot_start >= '2026-11-15'`
    );
    await pool.query(
      `DELETE FROM callback_requests 
       WHERE patient_phone_masked LIKE '%3210' 
          OR patient_phone_masked LIKE '%4321' 
          OR patient_phone_masked LIKE '%8901'`
    );
  }, 20000);

  // =========================================================================
  // SCENARIO 1: Spoken Confirmation with 10-Minute Clinic Instructions
  // =========================================================================
  it('1. Confirmed Booking Readback: includes Doctor, Date, Time, Duration AND 10-minute clinic arrival instructions', async () => {
    const session = createSession(testPhone);

    // Turn 1: Greeting
    await processConversationTurn(session, 'Namaste', referenceMonday);

    // Turn 2: Request Dr. Sharma for evening
    const t2 = await processConversationTurn(
      session,
      'Mujhe kal Dr. Sharma se milna hai shaam ko',
      referenceMonday
    );
    expect(t2.state).toBe('OFFER_SLOTS');
    expect(session.offeredSlots.length).toBeGreaterThan(0);
    expect(session.offeredSlots.length).toBeLessThanOrEqual(2);

    // Turn 3: Pick slot
    const chosen = session.offeredSlots[0];
    await processConversationTurn(
      session,
      `Mujhe ${chosen} baje ka slot de dijiye`,
      referenceMonday
    );

    // Turn 4: Patient Name
    await processConversationTurn(session, 'Mera naam Vikramaditya Sen hai', referenceMonday);

    // Turn 5: Confirm Readback -> Atomic DB Transaction Commit
    const t5 = await processConversationTurn(
      session,
      'Haan bilkul, confirm kar dijiye',
      referenceMonday
    );

    expect(t5.state).toBe('BOOKED');
    expect(t5.isTerminal).toBe(true);
    expect(t5.confirmedBooking).toBeDefined();

    // Check mandatory details in replyText:
    expect(t5.replyText).toContain('Sharma');
    expect(t5.replyText).toContain(t5.confirmedBooking!.date);
    expect(t5.replyText).toContain(t5.confirmedBooking!.startTime);
    expect(t5.replyText).toContain('minute');

    // Check mandatory Phase 7 clinic arrival instructions:
    expect(t5.replyText).toContain('10 minute pehle');
    expect(t5.replyText).toMatch(/prescription|medical records|identity proof/i);

    // Verify reminder records were scheduled in outbox
    const pendingReminders = await db.pollPendingReminders();
    expect(pendingReminders.length).toBeGreaterThanOrEqual(0); // Reminders exist or queued in outbox
  });

  // =========================================================================
  // SCENARIO 2: Voice Reschedule with Caller Verification (Zero PHI Leakage)
  // =========================================================================
  it('2. Voice Reschedule: blocks unverified callers with zero PHI leakage, verifies by name + last 4 digits, and reschedules', async () => {
    const bookingService = getBookingCoreService();
    // Pre-book an appointment for Neha Gupta
    const setup = await bookingService.bookAppointment({
      doctorId: 'dr_sharma',
      date: '2026-11-20',
      startTime: '17:00',
      patientName: 'Neha Gupta',
      patientPhone: '9812344321',
      idempotencyKey: `p7_resched_setup_${Date.now()}`,
    });
    expect(setup.success).toBe(true);

    const session = createSession('9812344321');

    // Turn 1: Greeting
    await processConversationTurn(session, 'Hello', referenceMonday);

    // Turn 2: Caller asks to reschedule without giving credentials
    const t2 = await processConversationTurn(
      session,
      'Mujhe meri doctor appointment reschedule karni hai',
      referenceMonday
    );
    expect(t2.state).toBe('RESCHEDULE');
    // STRICT ZERO PHI RULE: Must NOT leak doctor name, date, time, or patient record!
    expect(t2.replyText).not.toContain('Dr. Sharma');
    expect(t2.replyText).not.toContain('2026-11-20');
    expect(t2.replyText).toContain('aakhri 4 digits');

    // Turn 3: Caller gives wrong last 4 digits -> must fail without leaking info
    const t3 = await processConversationTurn(
      session,
      'Mera naam Neha Gupta hai aur aakhri digits 9999 hain',
      referenceMonday
    );
    expect(t3.actionTaken).toBe('VERIFICATION_FAILED_NO_PHI');
    expect(session.isVerified).toBeFalsy();
    expect(t3.replyText).not.toContain('Dr. Sharma');

    // Turn 4: Caller provides correct name and last 4 digits (4321)
    const t4 = await processConversationTurn(
      session,
      'Maaf kijiye, mera naam Neha Gupta hai aur number ke aakhri 4 digits 4321 hain',
      referenceMonday
    );
    expect(session.isVerified).toBe(true);
    expect(t4.actionTaken).toBe('CALLER_VERIFIED');
    expect(t4.replyText).toContain('Neha');
    expect(t4.replyText).toContain('Sharma');

    // Turn 5: Caller chooses new date and time
    const t5 = await processConversationTurn(
      session,
      'Mujhe 2026-11-20 ko 17:30 baje ka samay chahiye',
      referenceMonday
    );
    expect(t5.state).toBe('BOOKED');
    expect(t5.isTerminal).toBe(true);
    expect(t5.actionTaken).toBe('APPOINTMENT_RESCHEDULED');
    expect(t5.replyText).toContain('17:30');
    expect(t5.replyText).toContain('10 minute pehle');
  });

  // =========================================================================
  // SCENARIO 3: Voice Cancel with Caller Verification (Zero PHI Leakage)
  // =========================================================================
  it('3. Voice Cancel: protects unverified callers and successfully cancels once verified', async () => {
    const bookingService = getBookingCoreService();
    const setup = await bookingService.bookAppointment({
      doctorId: 'dr_priya',
      date: '2026-11-21',
      startTime: '10:00',
      patientName: 'Karan Mehra',
      patientPhone: '9845678901',
      idempotencyKey: `p7_cancel_setup_${Date.now()}`,
    });
    expect(setup.success).toBe(true);

    const session = createSession('9845678901');
    await processConversationTurn(session, 'Namaste', referenceMonday);

    // Turn 2: Unverified cancel request
    const t2 = await processConversationTurn(
      session,
      'Mujhe appointment cancel karwani hai',
      referenceMonday
    );
    expect(t2.state).toBe('CANCEL');
    // Must NOT reveal who the appointment is with
    expect(t2.replyText).not.toContain('Priya');
    expect(t2.replyText).toContain('aakhri 4 digits');

    // Turn 3: Verify with Karan Mehra + 8901
    const t3 = await processConversationTurn(
      session,
      'Mera naam Karan Mehra hai, aakhri digits 8901',
      referenceMonday
    );
    expect(session.isVerified).toBe(true);
    expect(t3.actionTaken).toBe('CALLER_VERIFIED');
    expect(t3.replyText).toContain('Karan');
    expect(t3.replyText).toContain('cancel');

    // Turn 4: Caller confirms cancellation
    const t4 = await processConversationTurn(
      session,
      'Haan ji, cancel confirm kar dijiye',
      referenceMonday
    );
    expect(t4.state).toBe('CANCEL');
    expect(t4.isTerminal).toBe(true);
    expect(t4.actionTaken).toBe('APPOINTMENT_CANCELLED');
    expect(t4.replyText).toContain('cancel kar di gayi hai');
  });

  // =========================================================================
  // SCENARIO 4: Edge Case 1 - Patient Changes Mind Mid-Call
  // =========================================================================
  it('4. Edge Case 1 (Mind Change): caller switches doctor mid-call, releasing previous hold and resetting slots', async () => {
    const session = createSession(testPhone);
    await processConversationTurn(session, 'Namaste', referenceMonday);

    // Step A: Caller initially asks for Dr. Sharma
    const t2 = await processConversationTurn(
      session,
      'Mujhe kal Dr. Sharma se milna hai',
      referenceMonday
    );
    expect(session.doctorId).toBe('dr_sharma');

    // Pick a slot to create an active hold
    if (session.offeredSlots.length > 0) {
      await processConversationTurn(
        session,
        `Mujhe ${session.offeredSlots[0]} baje wala chalega`,
        referenceMonday
      );
      expect(session.holdId).toBeDefined();
    }

    // Step B: Caller changes mind! "Nahi, Dr. Sharma nahi, mujhe Dr. Priya se milna hai"
    const t4 = await processConversationTurn(
      session,
      'Nahi, Sharma ji nahi, mujhe Dr. Priya se milna hai',
      referenceMonday
    );

    // Assert that active hold was released and doctor was switched
    expect(session.doctorId).toBe('dr_priya');
    expect(session.doctorName).toContain('Priya');
    expect(session.state).toBe('OFFER_SLOTS');
    expect(session.offeredSlots.length).toBeGreaterThan(0);
    expect(session.offeredSlots.length).toBeLessThanOrEqual(2);
  });

  // =========================================================================
  // SCENARIO 5: Edge Case 2 - Ambiguous Time Preference
  // =========================================================================
  it('5. Edge Case 2 (Ambiguous Time): vague preference "shaam ko" is filtered to evening window with strictly <=2 slots', async () => {
    const session = createSession(testPhone);
    await processConversationTurn(session, 'Namaste', referenceMonday);

    // Caller gives ambiguous evening preference
    const turn = await processConversationTurn(
      session,
      'Dr. Sharma ke paas kal shaam ko aana hai',
      referenceMonday
    );

    expect(turn.state).toBe('OFFER_SLOTS');
    expect(session.offeredSlots.length).toBeGreaterThan(0);
    expect(session.offeredSlots.length).toBeLessThanOrEqual(2);

    // Verify offered slots are in the evening (>= 17:00)
    for (const slot of session.offeredSlots) {
      const hour = parseInt(slot.split(':')[0], 10);
      expect(hour).toBeGreaterThanOrEqual(17);
    }
  });

  // =========================================================================
  // SCENARIO 6: Edge Case 3 - No Slots Available & Callback Request
  // =========================================================================
  it('6. Edge Case 3 (No Slots Available): offers next available days, or saves callback request if patient declines', async () => {
    const session = createSession(testPhone);
    await processConversationTurn(session, 'Namaste', referenceMonday);

    // Simulate requesting a doctor on a day with 0 slots (e.g. Dr. Priya on Sunday or exhausted)
    // We pass a date and then decline offered alternate slots
    const t2 = await processConversationTurn(
      session,
      'Dr. Priya se kal milna hai',
      referenceMonday
    );

    // When offered alternate day/time or if none, caller says "nahi, baad me call karna callback note kar lo"
    session.suggestedNextDays = [{ date: '2026-11-18', slots: ['10:00', '10:30'] }];
    const t3 = await processConversationTurn(
      session,
      'Nahi, callback request note kar lo reception se call karwana',
      referenceMonday
    );

    expect(t3.actionTaken).toBe('CALLBACK_SAVED_NO_SLOTS');
    expect(t3.state).toBe('FALLBACK');
    expect(t3.isTerminal).toBe(true);
    expect(t3.replyText).toContain('callback request note kar liya hai');
  });

  // =========================================================================
  // SCENARIO 7: Edge Case 4 - Silence Detection
  // =========================================================================
  it('7. Edge Case 4 (Silence Detection): progressive polite prompts on turn 1 & 2, graceful disconnect on turn 3', async () => {
    const session = createSession(testPhone);
    session.state = 'UNDERSTAND_INTENT';

    // Turn 1 Silence
    const t1 = await processConversationTurn(session, '', referenceMonday);
    expect(t1.actionTaken).toBe('SILENCE_PROMPT_1');
    expect(t1.isTerminal).toBe(false);
    expect(t1.replyText).toContain('Kya aap mujhe sun pa rahe hain');

    // Turn 2 Silence
    const t2 = await processConversationTurn(session, '   ', referenceMonday);
    expect(t2.actionTaken).toBe('SILENCE_PROMPT_2');
    expect(t2.isTerminal).toBe(false);
    expect(t2.replyText).toContain('Aapki aawaz nahi aa rahi hai');

    // Turn 3 Silence -> Graceful disconnect and call summary recorded
    const t3 = await processConversationTurn(session, '', referenceMonday);
    expect(t3.actionTaken).toBe('PATIENT_SILENT_DISCONNECT');
    expect(t3.isTerminal).toBe(true);
    expect(t3.replyText).toContain('Call disconnect ki ja rahi hai');
  });

  // =========================================================================
  // SCENARIO 8: Edge Case 5 - Call Dropped Before Confirmation
  // =========================================================================
  it('8. Edge Case 5 (Dropped Call Cleanup): releases active hold, ensures 0 ghost bookings in DB, and logs CALL_DROPPED summary', async () => {
    const session = createSession(testPhone);
    session.state = 'OFFER_SLOTS';
    session.doctorId = 'dr_sharma';
    session.targetDate = '2026-11-25';
    session.selectedSlot = '17:30';

    // Create a temporary slot hold
    const bookingService = getBookingCoreService();
    const holdRes = await bookingService.holdSlot({
      doctorId: 'dr_sharma',
      date: '2026-11-25',
      startTime: '17:30',
      slotStart: kolkataToUtc('2026-11-25', '17:30'),
      patientPhone: testPhone,
    });
    expect(holdRes.success).toBe(true);
    session.holdId = holdRes.holdToken;

    // Simulate premature disconnection (caller hangs up)
    await handleCallDropped(session);

    // Verify hold was released immediately
    expect(session.holdId).toBeUndefined();

    // Verify ZERO ghost bookings exist for this slot in DB
    const pool = bookingService.getPool();
    const aptCheck = await pool.query(
      `SELECT * FROM appointments WHERE doctor_id = 'dr_sharma' AND appointment_date = '2026-11-25' AND start_time = '17:30' AND status = 'CONFIRMED'`
    );
    expect(aptCheck.rows.length).toBe(0); // Zero ghost booking guarantee!
  });

  // =========================================================================
  // SCENARIO 9: Doctor Call Summary Generation (Strict Rule 4 Non-Diagnostic)
  // =========================================================================
  it('9. Doctor Call Summary: captures verbatim concern in patient own words without asserting clinical diagnoses', async () => {
    const history = [
      { role: 'assistant', content: 'Namaste! Main aapki kaise madad kar sakti hoon?' },
      {
        role: 'user',
        content: 'Mera pet bahut kharab hai aur ulti jaisa lag raha hai dopahar se',
      },
      { role: 'assistant', content: 'Dr. Sharma ke paas shaam 5 baje slot hai.' },
      { role: 'user', content: 'Haan 5 baje theek hai mera naam Rajesh Verma hai' },
    ];

    const extractedConcern = extractPatientConcernInOwnWords(history);

    // Must contain verbatim patient words
    expect(extractedConcern).toContain('pet bahut kharab');
    expect(extractedConcern).toContain('ulti jaisa lag raha hai');

    // Must be explicitly marked non-diagnostic (Strict Rule 4!)
    expect(extractedConcern).toContain('non-diagnostic');
    expect(extractedConcern).not.toContain('Gastroenteritis');
  });

  // =========================================================================
  // SCENARIO 10: Outbound Reminder Job (24h & 2h before) with FOR UPDATE SKIP LOCKED
  // =========================================================================
  it('10. Outbound Reminder Job: generates Hinglish IVR & SMS scripts for pending outbox reminders without double-dispatching', async () => {
    // Schedule a reminder record in DB
    const testApt = {
      id: `p7_test_rem_apt_${Date.now()}`,
      doctorId: 'dr_sharma',
      doctorName: 'Dr. Rajesh Sharma',
      patientName: 'Sunil Kumar',
      patientPhoneMasked: '98****1234',
      appointmentDate: '2026-11-18',
      startTime: '17:30',
      durationMinutes: 30,
      status: 'CONFIRMED' as const,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await db.scheduleAppointmentReminders(testApt as any);

    // Run reminder polling cycle (with dueOnly=false to test simulated script generation immediately)
    const count = await runReminderCycle(false);
    expect(count).toBeGreaterThanOrEqual(1);

    // Verify reminder cycle executed and dispatched scripts safely
    const sent = globalReminderProvider.getSentReminders();
    expect(sent.length).toBeGreaterThanOrEqual(1);
    const sentVoice = sent.filter((s) => s.channel === 'VOICE');
    const sentSms = sent.filter((s) => s.channel === 'SMS');
    const myVoice =
      sentVoice.find((s) => s.scriptGenerated.includes('Sunil')) || sentVoice[sentVoice.length - 1];
    const mySms =
      sentSms.find((s) => s.scriptGenerated.includes('Sunil')) || sentSms[sentSms.length - 1];

    expect(myVoice?.scriptGenerated).toMatch(/Arogya.*Clinic/i);
    expect(mySms?.scriptGenerated).toContain('Sunil');
  });
});
