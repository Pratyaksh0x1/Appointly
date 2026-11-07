# ADR-007: Dynamic Doctor Schedule Configuration & Voice Agent Synchronization

## Status

Accepted

## Context

In Indian outpatient clinics, doctors frequently adjust their consultation hours based on hospital rotations, emergencies, or personal availability (e.g. Dr. Sharma deciding: _"main shaam ke 5 baje se raat ke 10 baje tak baithta hoon"_ = 17:00 to 22:00).

Previously, clinic hours were statically seeded. The clinic doctor must have full dynamic control to decide:

1. When their clinic opens and closes each day (e.g. 17:00 to 22:00).
2. Which weekdays they are available for consultations.
3. Consultation slot duration (15m, 20m, 30m, 45m).
4. Consultation fee.

Crucially, the voice agent (Evon 30B LLM + Gnani Voice AI) and the pure slot generator must strictly synchronize with these active hours so patients are never offered or scheduled into slots outside the doctor's configured hours.

## Decision

### 1. Data Model & Validation

- Added `workingHoursStart` and `workingHoursEnd` (HH:mm) to the `Doctor` schema in PostgreSQL (`doctors` table) and `@appointly/shared`.
- Created `doctorScheduleUpdateSchema` in `packages/shared/src/schemas.ts`:
  - Enforces `HH:mm` format regex.
  - Requires `workingHoursStart < workingHoursEnd`.
  - Requires non-empty `activeDays` array.
  - Validates duration between 10 and 120 minutes.

### 2. HTTP Endpoint & Real-Time Dashboard Synchronization

- Created `PUT /api/doctors/:id/schedule`:
  - Persists schedule updates to Neon PostgreSQL.
  - Invalidates doctor cache in `BookingCoreService`.
  - Broadcasts `doctor_schedule_updated` event across Server-Sent Events (SSE) to connected doctor dashboards.
  - Live Doctor Dashboard (`apps/dashboard/index.html`) includes quick presets:
    - 🌆 Evening OPD (17:00 - 22:00)
    - 🌅 Morning OPD (09:00 - 13:00)
    - ☀️ Full Day OPD (09:00 - 18:00)
    - Live Slot Inspector showing dynamic slots preview.

### 3. Dynamic Slot Generation

- `generateDoctorSlots()` and `getAvailableSlots()` dynamically calculate available intervals strictly between `workingHoursStart` and `workingHoursEnd` on `activeDays`.
- If a doctor changes hours to 17:00 - 22:00, morning slots (e.g. 09:30, 10:00) are automatically excluded.

### 4. Strict Booking Enforcement (Non-Negotiable Rules)

- In `BookingCoreService.bookAppointment()` and `holdSlot()`:
  - If a patient or client attempts to book or hold outside `workingHoursStart` - `workingHoursEnd` or on an inactive day, the transaction rolls back immediately and returns:
    `{ success: false, error: 'OUTSIDE_WORKING_HOURS', message: 'Dr. <name> kewal <start> se <end> tak hi baithte hain.' }`
- The LLM cannot bypass this check; only validated tools execute within DB transactions.

### 5. Voice Agent Dialogue & System Prompt Injection

- `/api/chat` and `EvonLLMClient`:
  - Dynamically injects each doctor's active consultation hours into the system prompt.
  - The voice agent politely explains the doctor's timings in natural Hinglish if a patient requests an unavailable time (e.g. _"Dr. Sharma subah available nahi hain, unka clinic time shaam 5:00 PM se raat 10:00 PM tak hai."_).
  - Emits validated tool calls (`get_available_slots`, `book_appointment`) strictly using the active hours.
  - Agent confirms appointment to patient ONLY after DB transaction commits with doctor name, date, start time, and duration.

## Consequences

- **Positive**: Doctors have live, dynamic autonomy over their consultation schedules without server restarts or code deploys.
- **Positive**: Voice agent and slot generator stay 100% in sync with real-time SSE broadcasts.
- **Positive**: Zero possibility of scheduling an appointment outside doctor hours due to deterministic DB transaction validation.
