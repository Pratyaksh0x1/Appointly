# ADR-010: Patient Confirmation Lifecycle, Caller Verification, Outbound Reminders & Edge Case Handling

## Status

Accepted

## Context

Phase 7 completes the patient-facing appointment lifecycle and guarantees resilience under real-world clinical telephony conditions:

1. **Post-Commit Spoken Confirmation**:
   - The agent must never say "booked" before the database transaction commits (Non-negotiable Rule 1).
   - Once committed, the agent must clearly speak doctor name, date, time, duration, and clinic arrival instructions (arrive 10 minutes early, bring prior prescriptions/medical records and identity proof) in the caller's language mix (Hinglish).
2. **Caller Verification & Zero PHI Leakage**:
   - Rescheduling and cancellation over voice require verifying caller identity (patient name + last 4 digits of phone number).
   - In accordance with DPDP and medical privacy principles, unverified callers must never receive any Protected Health Information (PHI) — doctor names, dates, times, or existing appointments must remain strictly confidential until verification passes.
3. **Outbound Reminder Dispatch via Transactional Outbox**:
   - Appointment reminders must be scheduled for 24 hours and 2 hours before the consultation.
   - Background polling must use PostgreSQL `FOR UPDATE SKIP LOCKED` on the outbox table to prevent double-dispatching across concurrent workers.
   - Reminders must support both IVR voice call script generation and SMS notifications behind a provider interface (`IReminderProvider`).
4. **Doctor Call Summaries with Strict Non-Diagnostic Guarantee**:
   - Every call must produce a doctor summary containing patient name, concern in their verbatim words, preferred time, and call outcome.
   - Strict adherence to Non-negotiable Rule 4: The system must never assert speculative clinical diagnoses; patient concerns are extracted verbatim without diagnosis.
5. **Real-World Conversational Edge Cases**:
   - Patient changes mind mid-call (switching doctor or date).
   - Ambiguous or vague time preference ("shaam ko", "dopahar me").
   - No slots available on the requested date.
   - Patient silence / microphone inactivity.
   - Call dropped before confirmation readback.

---

## Decisions

### 1. Spoken Post-Commit Readback with Clinic Arrival Instructions

After the booking or reschedule database transaction commits, the orchestrator constructs a standardized Hinglish readback:

```
"Aapki appointment Dr. [Doctor] ke saath [Date] ko [Time] baje confirm ho gayi hai.
Consultation duration [Duration] minute rahegi.
Kripya clinic samay se 10 minute pehle pahunchein, aur apna purana prescription
ya medical records aur identity proof sath layein.
Arogya Clinic call karne ke liye dhanyawad!"
```

### 2. Caller Verification Protocol & Zero PHI Leakage Guarantee

When a caller initiates `RESCHEDULE` or `CANCEL`:

1. The orchestrator checks if the caller is already verified in this session (`session.isVerified`).
2. If unverified, the agent requests verification credentials:
   `"Suraksha ke liye, kripya apna poora naam aur registered mobile number ke aakhri 4 digits batayein."`
3. Under no circumstances are doctor names, dates, or booking statuses revealed to an unverified caller.
4. Database lookup queries `appointments` for active bookings (`status IN ('CONFIRMED', 'RESCHEDULED')`) matching `patient_name` and the last 4 digits of `patient_phone_masked`.
5. If no match is found, an explicit `VERIFICATION_FAILED_NO_PHI` error is recorded, and the agent politely invites the caller to recheck their details or request a clinic callback without disclosing any database contents.

### 3. Transactional Outbox Reminders with `FOR UPDATE SKIP LOCKED`

When an appointment is confirmed:

1. `scheduleAppointmentReminders()` creates two pending reminder records in the `outbox` table:
   - `reminderType = '24h'`: scheduled for `appointment_time - 24 hours`.
   - `reminderType = '2h'`: scheduled for `appointment_time - 2 hours`.
2. A background worker (`runReminderCycle()`) polls the outbox:
   ```sql
   SELECT * FROM outbox
   WHERE event_type = 'appointment_reminder'
     AND status = 'PENDING'
     AND ((payload->>'scheduledFor')::timestamptz <= NOW() OR (payload->>'scheduledFor') IS NULL)
   ORDER BY created_at ASC
   LIMIT 10
   FOR UPDATE SKIP LOCKED
   ```
3. `FOR UPDATE SKIP LOCKED` guarantees that concurrent API instances or background workers never process the same reminder simultaneously.
4. `SimulatedReminderProvider` implements `IReminderProvider`, generating natural Hinglish IVR speech and SMS scripts:
   - Voice script: `"Namaste [Patient] ji! Arogya Care Clinic se reminder hai ki kal [Date] ko [Time] baje Dr. [Doctor] ke sath aapka clinic appointment scheduled hai..."`
   - SMS script: `"Arogya Clinic Reminder: Namaste [Patient]! Kal [Date] ko [Time] baje Dr. [Doctor] ke sath aapka appointment confirm hai. Please 10 min pehle reach karein..."`
5. Once dispatched, the outbox record is marked `PROCESSED` with `scriptGenerated` and a `reminder_dispatched` event is broadcast via SSE.

### 4. Non-Diagnostic Doctor Call Summaries (Rule 4)

Implemented in `apps/api/src/services/call-summary-service.ts`:

- Patient concerns are extracted directly from user dialogue turns verbatim.
- Summaries append `(Patient verbatim words; non-diagnostic note)` to prevent clinical speculation.
- Each call is assigned a definitive `CallOutcome`:
  `BOOKED`, `RESCHEDULED`, `CANCELLED`, `CALLBACK_SAVED`, `EMERGENCY_ESCALATED`, `CALL_DROPPED`, `PATIENT_SILENT_DISCONNECT`, `INQUIRY_ONLY`.
- Summaries are persisted in the `calls` table and broadcast to the doctor dashboard via SSE (`call_summary_created`).

### 5. Five Telephony Edge Cases

1. **Patient Changes Mind Mid-Call**:
   - If caller changes doctor or date while a slot is held, the active hold is immediately released via `release_hold` server tool, clearing `session.holdId` and re-querying open slots for the new selection.
2. **Ambiguous Time Preference ("shaam ko")**:
   - `resolveDateTime()` maps fuzzy periods to concrete windows (`evening` -> `17:00` - `21:00`).
   - The slot generator filters available slots within this window and strictly returns at most 2 options to prevent patient cognitive overload over voice.
3. **No Slots Available**:
   - If the requested date has no slots, the agent scans the subsequent 2 clinic days and suggests the earliest available slots.
   - If the patient declines suggested dates or requests a callback, a `callback_requests` record is created, and clinic staff are notified.
4. **Patient Silence / Audio Dropout**:
   - Progressive prompt strategy:
     - Turn 1: `"Aapki aawaz nahi aa rahi hai, kya aap mujhe sun pa rahe hain?"`
     - Turn 2: `"Kripya batayein, kya aap abhi line par hain?"`
     - Turn 3: Graceful disconnect with polite sign-off.
5. **Call Dropped Before Confirmation**:
   - On WebSocket close or call teardown, `handleCallDropped()` executes immediately.
   - If a slot hold was active (`session.holdId`), it is released in the database, preventing ghost holds.
   - Zero ghost bookings: No appointment is ever created without explicit patient confirmation and DB commit.
   - A `CALL_DROPPED` summary is logged on the `calls` table for doctor auditing.

---

## Consequences

- **Security & Privacy**: Zero PHI is leaked to unverified voice callers, satisfying Indian DPDP regulations.
- **Reliability**: Ghost bookings and abandoned holds are completely eliminated on network disconnects.
- **Observability**: Doctors have full visibility into live calls, patient concerns, and scheduled reminders directly on the dashboard.
- **Extensibility**: Real telephony (Twilio, Exotel, Gupshup) can be plugged into `IReminderProvider` without altering domain logic.
