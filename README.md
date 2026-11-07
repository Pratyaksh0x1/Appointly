# Appointly 🏥🎙️

> **Hinglish Live Voice AI Agent for Small Clinics**  
> _Built for the Gnani AI Hackathon • Backed by Neon Serverless PostgreSQL_

![Appointly Logo](apps/dashboard/public/logo.jpg)

Appointly is an empathetic, multilingual voice assistant designed for small clinic reception desks in India. A patient speaks live in Hinglish (Hindi + English code-switching); Appointly confirms doctor availability, books the appointment via strict serializable database transactions on Neon PostgreSQL, confirms the doctor, date, start time, and duration, and instantly displays the booking on a real-time doctor dashboard via Server-Sent Events (SSE).

---

## Phase 9: Observability, Prometheus Metrics, Real-Time Alerts & Eval Harness Highlights

- **Standardized Structured Event Catalog (`AppointlyEvents`)**:
  - Consistent structured events across voice turns, tool invocations, database commits, safety guardrails, and retention jobs.
  - Guaranteed `call_id` / `request_id` correlation with automated PII masking (phones, emails, Aadhaar, credentials).
- **Prometheus Metrics Exposition (`GET /metrics`)**:
  - Standard Prometheus format (v0.0.4) exposing counters (`appointly_calls_total`, `appointly_bookings_total`, `appointly_emergencies_total`, `appointly_credits_burned_total`), gauges, and latency summaries (`appointly_turn_latency_ms{quantile="0.5|0.9|0.95|0.99"}`).
  - Supports `GET /metrics?format=json` or `Accept: application/json` for programmatic telemetry consumption.
- **Doctor Dashboard Observability & SLO Panel**:
  - Direct UI visualization of production health: Availability SLO (99.9% target vs actual) and P95 Turn Latency SLO (< 2,000ms target vs actual).
  - Per-stage latency percentiles table (STT, LLM First Token, TTS First Audio, Turn Total) and booking funnel conversion stats.
- **Real-Time Alert Engine (`AlertEngine`)**:
  - Automated detection of high error rates (> 5%), P95 turn latency breaches (> 2,000ms), and credit depletion (&ge; 90%).
  - Logs structured alert warnings and dispatches asynchronous HTTP POST webhooks (`ALERT_WEBHOOK_URL`).
- **Documented Service Level Objectives ([`docs/slo.md`](docs/slo.md))**:
  - Formal 99.9% Availability and P95 turn latency under 2.0s SLOs.
  - Honest disclosure of Neon Serverless PostgreSQL cold starts (~500ms–1.5s after 5 min idle) and our 0ms pre-cached memory audio mitigation.
- **Comprehensive Conversational Eval Harness (`npm run eval`)**:
  - 57 diverse Hinglish clinical scenarios across 9 categories (Direct Bookings, Slot Preference, Unavailable Slots, Reschedule, Cancel, Ambiguous Times, Medical Emergencies, Prompt Injections, Off-Topic).
  - Strict acceptance guarantees verified in CI: **100% Emergency Triage pass rate** and **Zero Unavailable Slot Bookings**.
  - Markdown report automatically generated at [`docs/eval-report.md`](docs/eval-report.md).

---

## Phase 8: Reliability, Security Hardening & Chaos Testing Highlights

- **Idempotency Keys on All Mutating Endpoints**:
  - Mutating routes (`POST /api/chat`, `PUT /api/appointments/:id/reschedule`, `PUT /api/appointments/:id/cancel`) support `Idempotency-Key` and `X-Idempotency-Key` headers.
  - Replays cached responses with `X-Cache-Lookup: HIT` and `X-Idempotency-Replay: true`, returning HTTP 409 Conflict for in-flight duplicates and bypassing re-execution of side effects.
- **Transactional Outbox with Retry & Dead-Letter Status**:
  - The `outbox` table tracks `retry_count`, `max_retries` (default 3), and `last_error`.
  - Concurrently polled with PostgreSQL `FOR UPDATE SKIP LOCKED`. If an event exceeds maximum retries, it transitions safely to `'DEAD_LETTER'` without blocking the relay queue.
- **Sliding-Window Rate Limiting (Per-IP & Per-Session)**:
  - Enforces configurable rate limits (`RATE_LIMIT_MAX_PER_MINUTE`, default 120 req/min) per client IP and per session/doctor Bearer token.
  - Returns HTTP 429 (`TOO_MANY_REQUESTS`) with standard `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `Retry-After` headers.
- **Request Body Size Limits & Deep Input Sanitization**:
  - Enforces `MAX_REQUEST_SIZE_BYTES` (1MB default), destroying oversized streams with HTTP 413 (`PAYLOAD_TOO_LARGE`).
  - Defense-in-depth sanitization: strips null bytes (`\0`), ASCII control characters, and object prototype properties (`__proto__`, `constructor`, `prototype`).
- **Enterprise Security Headers & Dynamic CORS Allowlist**:
  - Strict enterprise headers: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `X-XSS-Protection: 1; mode=block`, `Strict-Transport-Security: max-age=31536000`, `Content-Security-Policy`, and `Permissions-Policy`.
  - Dynamic allowlist origin checking via `CORS_ORIGIN` with `Vary: Origin`.
- **Least-Privilege Database Roles Architecture**:
  - Dual-role database security separating migration DDL (`appointly_admin`) from application runtime DML (`appointly_app` with `SELECT`, `INSERT`, `UPDATE`, `DELETE` only, no `DROP`/`ALTER`/`TRUNCATE`). Documented in [`docs/db-roles.md`](docs/db-roles.md) and [`scripts/setup-least-privilege-db-roles.sql`](scripts/setup-least-privilege-db-roles.sql).
- **Automated PII & Secret Redaction in Logs & Transcripts**:
  - Automatically masks phone numbers (`+91 ******<last4>`), 12-digit Aadhaar IDs (`****-****-****`), email addresses (`u***r@domain.com`), and Bearer tokens (`Bearer [REDACTED]`).
  - Zero raw PII or credentials printed in application logs or stored call summaries.
- **DPDP-Compliant Transcript Retention Worker**:
  - Configurable retention job (`TRANSCRIPT_RETENTION_DAYS`, default 30 days) automatically purges call records older than the retention threshold.
- **Zero Raw Audio Storage Policy**:
  - Microphone audio chunks are processed strictly in RAM buffers for VAD and STT streaming, then immediately garbage collected. Zero raw audio files (`.wav`, `.pcm`, `.raw`) touch disk (`STORE_RAW_AUDIO=false`).
- **Graceful Degradation Protocols**:
  - _Voice Agent_: If STT, LLM, or TTS fail or time out, the server plays a pre-cached Hinglish apology audio chunk (`FIXED_PHRASES.FALLBACK`), persists a `callback_request` in Neon PostgreSQL, and tears down the call cleanly.
  - _Doctor Dashboard_: If SSE connection drops, the UI automatically engages a 5-second polling fallback with badge indicator `"Polling Active (Fallback)"`, restoring `"Neon Postgres Live"` upon reconnect.
- **Comprehensive STRIDE-Lite Threat Model**:
  - Detailed in [`docs/threat-model.md`](docs/threat-model.md) analyzing Spoofing, Tampering, Repudiation, Information Disclosure, Denial of Service, and Elevation of Privilege with honest mitigations and residual risks.
- **50 Concurrent Calls Load Test & Chaos Test Suite**:
  - Benchmark report in [`docs/load-test.md`](docs/load-test.md): 50 concurrent calls, 150 conversational turns completed in 7.33s with 7.2 calls/sec throughput and **0% error rate**.
  - All automated chaos tests pass in `apps/api/tests/chaos-and-resilience.test.ts`.

---

## Phase 7: Patient Confirmation, Lifecycle & Edge Case Highlights

- **Post-Commit Spoken Readback with Clinic Arrival Instructions**:
  - The voice agent says _"booked"_ strictly **after** database transaction commit (Non-negotiable Rule 1).
  - Spoken confirmation readback in patient's language mix (Hinglish) states Doctor, Date, Time, Duration, and clinic instructions:
    _“Kripya clinic samay se 10 minute pehle pahunchein, aur apna purana prescription ya medical records aur identity proof sath layein.”_
- **Voice Reschedule & Cancel with Caller Verification (Zero PHI Leakage)**:
  - Callers asking to modify or cancel appointments must verify identity via **Patient Name + Last 4 digits of phone number**.
  - **Zero PHI Leakage Guarantee**: Unverified callers never receive doctor name, appointment dates, or times (`VERIFICATION_FAILED_NO_PHI`).
  - Verified callers can reschedule to an open slot or cancel atomically with full slot freeing and outbox broadcast.
- **Outbound Reminders (24h & 2h before) via Transactional Outbox**:
  - Driven by the `outbox` table with PostgreSQL `FOR UPDATE SKIP LOCKED` to prevent duplicate dispatching across concurrent workers.
  - Pluggable provider interface `IReminderProvider` with `SimulatedReminderProvider` generating natural Hinglish IVR speech calls and SMS text scripts.
- **Doctor Call Summaries with Strict Non-Diagnostic Guarantee (Rule 4)**:
  - Extracted verbatim from patient speech turns (e.g. _“pet bahut kharab hai aur ulti jaisa lag raha hai”_), explicitly tagged as non-diagnostic notes.
  - Tagged with structured `CallOutcome` (`BOOKED`, `RESCHEDULED`, `CANCELLED`, `CALLBACK_SAVED`, `EMERGENCY_ESCALATED`, `CALL_DROPPED`, `PATIENT_SILENT_DISCONNECT`).
  - Displayed in the doctor dashboard under **🩺 AI Call Summaries** with live SSE broadcast.
- **5 Telephony Edge Cases Handled**:
  - _Mind-Change Mid-Call_: Automatically releases active slot holds in DB and resets slot selection for the new preference.
  - _Ambiguous Time Preference_: Vague requests (_“shaam ko”_) are resolved to time windows and strictly offer at most 2 concrete slots.
  - _No Slots Available_: Scans the next 2 clinic days for open slots or saves a callback request.
  - _Patient Silence_: Progressive polite prompts on Turn 1 & Turn 2, graceful disconnect on Turn 3.
  - _Dropped Call Cleanup_: Immediately releases holds on disconnect; zero ghost bookings created.

---

## Phase 6: Doctor Dashboard, Auth & Realtime Outbox Highlights

- **Cryptographically Signed HMAC-SHA256 JWT Authentication**:
  - Protected doctor routes guarded by `requireDoctorAuth` middleware.
  - Supports Google Auth (`POST /api/auth/google`) and One-Click Doctor Demo Login (`POST /api/auth/dev-login`) for quick offline testing.
- **Sub-2-Second Live Updates via Dual SSE Outbox Relay**:
  - Real-time updates for new bookings, reschedules, cancellations, doctor schedule changes, and emergency alerts without manual refresh.
- **Doctor Dashboard Capabilities**:
  - Live Today & Upcoming Appointments list with status badges (`CONFIRMED`, `COMPLETED`, `CANCELLED`).
  - Interactive Day OPD Schedule Grid and time slot distribution.
  - Emergency / Escalation alert banner with audible warning and 108 protocol instructions.
  - Reception Callback Requests list with 1-click resolve button.
  - Live AI Call Summaries viewer with verbatim patient concerns.
  - Live Credits Used counter against the 5,000 credit cap.
  - Mobile-responsive design with dark clinical theme and WCAG accessibility standards.

---

- **Authenticated Two-Way WebSocket Pipeline (`/ws/voice`)**:
  - Browser streams 16kHz PCM audio chunks; server streams back sentence-chunked TTS audio frames and event messages (`session_ready`, `transcript`, `state`, `agent_text`, `filler`, `interrupt`, `latency`).
  - Authenticated via cryptographically secure, single-use, 10-minute session tokens (`POST /api/voice/session`) with sliding-window IP rate limiting (20 req/min). Non-negotiable security: Gnani/Evon credentials are never sent to the browser.
- **Local RMS Voice Activity Detection (VAD) & Silence Endpointing**:
  - Frame-by-frame 16-bit PCM RMS energy evaluation with 250 ms minimum speech threshold to ignore throat clears.
  - 700 ms silence endpointing window immediately declares end-of-speech and triggers processing without awaiting cloud provider timeouts.
- **Pre-Generated Zero-Latency Audio Cache**:
  - Fixed Hinglish utterances (Greetings, 700ms Fillers, Emergency 108 Escalations, Fallbacks, Farewells) are pre-synthesized at server startup.
  - Delivers **0 ms TTS latency** and sub-50ms first-turn voice response.
- **Sentence-Chunked Streaming TTS**:
  - LLM and state machine outputs are split on natural punctuation boundaries (`.`, `!`, `?`, `|`, `\n`).
  - Sentence 1 is synthesized and streamed to the client immediately while subsequent sentences are processed concurrently, dramatically cutting Time-to-First-Audio.
- **700 ms Conversational Tool Filler Protocol**:
  - If a database query or external tool execution exceeds 700 ms, the server dispatches a pre-cached filler audio chunk (_"Ji, main check kar rahi hoon, ek second..."_) to keep the caller engaged and mask latency.
- **Bi-directional Barge-In (Interruption Handling)**:
  - If the patient speaks while the agent is talking, VAD detects speech onset, the server cancels active TTS via `AbortController`, and the browser immediately purges its audio queue.
- **Live Voice Tester & Telemetry UI**:
  - Available at **[http://localhost:3000/voice-test.html](http://localhost:3000/voice-test.html)** with interactive mic controls, real-time waveform states, live transcripts, and turn-by-turn latency monitoring (`stt_ms`, `llm_first_token_ms`, `tts_first_audio_ms`, `total_ms`).
- **Comprehensive Benchmark Report**:
  - Detailed in [`docs/latency.md`](docs/latency.md) reporting P50 (85ms mock / 980ms real) and P95 (550ms mock / 1,420ms real) against the 1.5s SLA and detailing the top 3 telephony bottlenecks.

---

## Phase 4: Conversation Brain & Explicit State Machine Highlights

- **Explicit Finite State Machine (`apps/api/src/agent/orchestrator.ts`)**:
  - Rigid states: `GREETING_CONSENT` $\rightarrow$ `UNDERSTAND_INTENT` $\rightarrow$ `COLLECT_DETAILS` $\rightarrow$ `OFFER_SLOTS` $\rightarrow$ `CONFIRM_READBACK` $\rightarrow$ `BOOKED` \| `RESCHEDULE` \| `CANCEL` \| `ESCALATE` \| `FALLBACK`.
  - The LLM selects natural Hinglish wording; the state machine and validated tools strictly control workflow state.
- **Mandatory Read-Back Verification**:
  - The agent explicitly reads back doctor name, date, start time, and visit duration queried directly from Neon PostgreSQL before finalizing any booking.
- **Max 2 Slots Offered Guarantee**:
  - Telephony callers suffer cognitive overload if presented with long lists. The slot generator and orchestrator strictly offer at most 2 options at a time.
- **Doctor Dynamic Scheduling & Voice Agent Sync**:
  - Doctors configure custom OPD consultation hours (e.g. 17:00 to 22:00 / 5 PM to 10 PM) via `PUT /api/doctors/:id/schedule`.
  - The agent instantly absorbs new timings, rejects bookings outside doctor hours, and synchronizes connected doctor screens via SSE.
- **Deterministic Natural Date Resolver (`date-resolver.ts`)**:
  - Code-level resolution for Hindi/Hinglish relative date phrases (_kal_, _parson_, _aaj shaam_, _next Monday_) using `Asia/Kolkata` clinic timezone.
- **Prompt Injection Defense & Medical Guardrails**:
  - Unsanitized patient speech is treated as untrusted input; sanitized through strict regex guards and Zod validators.
  - Zero medical advice: hardcoded regex intercept triggers immediate 108 emergency escalation for life-threatening symptoms (_chest pain_, _saans nahi aa rahi_, _behosh_).

---

## Phase 3: Gnani Adapters, Resilience & Cost Metering Highlights

- **Complete Gnani API & Evon Documentation**:
  - Detailed endpoints, authentication, streaming protocols, audio specs, and credits in [`docs/gnani-notes.md`](docs/gnani-notes.md).
  - Production GPU sizing, vLLM / OpenAI-compatible hosting, and Docker setup for Evon 30B in [`docs/evon-hosting.md`](docs/evon-hosting.md).
- **Provider-Agnostic Model Interfaces**:
  - `SttProvider`: audio buffer / stream $\rightarrow$ partial & final transcripts with confidence scores.
  - `TtsProvider`: text $\rightarrow$ 16kHz PCM WAV audio buffer and async streaming chunks.
  - `LlmProvider`: messages + tools $\rightarrow$ conversational response and validated tool calls.
- **Dual Adapter Architecture (In-Memory Mock + Production Gnani)**:
  - `MockSttAdapter`, `MockTtsAdapter`, `MockLlmAdapter`: Zero-credit in-memory mock adapters active by default for test & local dev.
  - `GnaniSttAdapter`, `GnaniTtsAdapter`, `EvonOpenAiLlmAdapter`: Production adapters connecting to `api.vachana.ai` and OpenAI-compatible Evon endpoints.
- **Circuit Breaker Pattern**:
  - State machine (`CLOSED`, `OPEN`, `HALF_OPEN`) tracking consecutive failures per service.
  - Automatically trips after 3 failures to fast-fail subsequent requests and protect credit budget during outages.
- **Idempotency-Aware Bounded Retries**:
  - **NON-NEGOTIABLE RULE**: Exponential backoff with jitter applied **strictly to idempotent calls only** (STT/TTS/read queries); non-idempotent operations (such as booking commits) execute with **0 retries** to prevent double mutation.
- **Per-Call & Daily Cost Metering**:
  - Tracks and enforces 50 credits/call, 2,000 credits/day, and 5,000 total budget caps. Emits structured JSON audit logs.
- **End-to-End Voice Pipeline Smoke Test**:
  - Run via `npm run smoke:voice`: sends a live Hinglish sentence through STT $\rightarrow$ LLM $\rightarrow$ TTS, and outputs step-by-step latency & credit reports.

---

## Phase 2: Database and Booking Core Highlights

- **8 Relational Tables on PostgreSQL (Drizzle ORM & SQL Migrations)**:
  - `doctors`: Doctor roster, specialty, IST working hours (`09:00`-`18:00`), active days.
  - `appointment_types`: Visit types (`general_consultation` 30m, `follow_up` 15m, `comprehensive_checkup` 45m).
  - `patients`: Patient directory with encrypted/masked phone numbers (`+91 ******3210`).
  - `appointments`: Confirmed appointments with UTC storage, partial unique index `uq_active_doctor_slot`, and idempotency keys.
  - `slot_holds`: 2-minute auto-expiring temporary holds for active callers.
  - `calls`: Telephony call logs with credit tracking and outcomes.
  - `outbox`: Transactional outbox pattern for reliable async messaging.
  - `callback_requests`: Graceful fallback tickets for receptionist follow-up.
- **Zero Double-Booking Guarantee (PostgreSQL Partial Unique Index)**:
  ```sql
  CREATE UNIQUE INDEX uq_active_doctor_slot
  ON appointments (doctor_id, slot_start)
  WHERE status = 'CONFIRMED';
  ```
- **UTC Storage & Asia/Kolkata Display**: Stored in UTC (`TIMESTAMPTZ`) for universal consistency; converted and displayed in `Asia/Kolkata` (IST, UTC+05:30) for Hinglish speech generation and doctor OPD screens.
- **Pure Slot Generator**: Fully deterministic, side-effect-free algorithm computing valid intervals from working hours, visit durations, confirmed appointments, and unexpired holds.
- **5 Core Service Functions**:
  - `checkSlots(doctorId, date, appointmentTypeId)`
  - `holdSlot(input)` (2-minute auto-expiring hold)
  - `bookAppointment(input)` (single transaction, requires idempotency key, releases hold, enforces unique constraint, logs to outbox)
  - `cancelAppointment(appointmentId, reason)` (frees slot for new bookings)
  - `rescheduleAppointment(appointmentId, newDate, newTime)` (atomic move to new slot)
- **High Concurrency Tested**: Verified by a concurrency test firing **50 simultaneous bookings** against Neon for the same slot: **exactly 1 succeeds, exactly 49 are safely rejected with `SLOT_ALREADY_BOOKED`**.

---

## Architecture Overview

For the detailed Mermaid architecture diagram and Master Context data flow, see [ARCHITECTURE.md](ARCHITECTURE.md).

```
Patient Voice ──> Gnani Prisma STT (v3.0) ──> Code-Level Emergency Scanner
                                                      │
              ┌───────────────────────────────────────┴───────────────────────────────────────┐
              ▼ (Emergency)                                                                   ▼ (Routine Query)
      Hardcoded 108 Escalation                                                        Evon 30B LLM (Reasoning)
              │                                                                               │
              ▼                                                                               ▼
     Gnani Timbre TTS (Shivani)                                                       Validated Tool Calls
              │                                                                               │
              ▼                                                                               ▼
       Patient Audio                                                             Neon PostgreSQL (Transaction)
                                                                                              │
                                                                                              ├─> Instant SSE Broadcast ─> Doctor Dashboard
                                                                                              └─> Confirmed Speech Output ─> Patient Audio
```

---

## Monorepo Layout

```
appointly/
├── apps/
│   ├── api/                  # Stateless Voice AI Backend (Node.js/TypeScript)
│   └── dashboard/            # Minimalist Doctor Dashboard (Live SSE, OPD Roster, Simulator)
├── packages/
│   └── shared/               # Shared domain types, Zod validation schemas & clinic constants
├── docs/adr/                 # Architecture Decision Records (ADR-001 to ADR-010)
├── .github/workflows/ci.yml  # GitHub Actions CI (lint, typecheck, test, audit, gitleaks)
├── Makefile                  # Developer workflow automation
├── neon.ts                   # Neon project configuration & branch policy
├── ARCHITECTURE.md           # Master Context architectural specification & data flow
└── README.md
```

---

## Quickstart & Setup Steps

### 1. Fresh Clone & Installation

```bash
git clone https://github.com/Pratyaksh0x1/Appointly.git
cd Appointly
npm install
```

### 2. Configure Environment

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Fill in your configuration or use the provisioned Neon connection:

```ini
PORT=3000
DATABASE_URL="postgresql://neondb_owner:...@ep-little-credit-bdwt1fpl-pooler.c-8.us-east-2.aws.neon.tech/neondb?sslmode=require"
DATABASE_URL_UNPOOLED="postgresql://neondb_owner:...@ep-little-credit-bdwt1fpl.c-8.us-east-2.aws.neon.tech/neondb?sslmode=require"
GNANI_API_KEY=your_gnani_api_key_here
EVON_API_KEY=your_evon_api_key_here
USE_MOCK_SERVICES=true
```

### 3. Run Build, Lint & Tests

```bash
# Typecheck all packages
npm run typecheck

# Code formatting and linting
npm run lint

# Run all 135 Vitest unit, state machine, latency, lifecycle & concurrency tests across 17 test suites
npm test

# Run database migration & seed on Neon
npm run migrate
npx tsx scripts/seed.ts
```

### 4. Start the Development Server

```bash
npm run dev
```

Open **[http://localhost:3000](http://localhost:3000)** in your browser to view the Minimalist Doctor Dashboard with real-time SSE updates and the live voice assistant simulator.

---

## Endpoints Reference

| Endpoint                           | Method    | Purpose                                                                                                                               |
| :--------------------------------- | :-------- | :------------------------------------------------------------------------------------------------------------------------------------ |
| `/healthz`                         | GET       | Liveness probe (returns HTTP 200 `{ status: "ok" }`)                                                                                  |
| `/readyz`                          | GET       | Readiness probe (verifies database connectivity and returns status)                                                                   |
| `/health`                          | GET       | Detailed health check (database status, doctors loaded, credit budget summary)                                                        |
| `/api/auth/google`                 | POST      | Doctor login via Google Identity Services token                                                                                       |
| `/api/auth/dev-login`              | POST      | One-click doctor demo login for offline testing and hackathon judging                                                                 |
| `/api/doctors`                     | GET       | Lists clinic doctors, specialties, fees, and consultation durations                                                                   |
| `/api/doctors/:id/schedule`        | PUT, POST | Updates doctor's OPD timing (e.g. 17:00 to 22:00) and broadcasts live SSE event to doctor dashboards                                  |
| `/api/slots`                       | GET       | Retrieves open slots for a doctor on a specific date (`?doctorId=dr_sharma&date=YYYY-MM-DD`)                                          |
| `/api/appointments`                | GET       | Protected doctor route: retrieves all confirmed appointments with filtering                                                           |
| `/api/appointments/:id/reschedule` | PUT       | Protected doctor route: reschedules an existing appointment                                                                           |
| `/api/appointments/:id/cancel`     | PUT       | Protected doctor route: cancels an appointment and frees the slot                                                                     |
| `/api/appointments/:id/complete`   | PUT       | Protected doctor route: marks consultation completed                                                                                  |
| `/api/callbacks`                   | GET       | Protected doctor route: retrieves saved receptionist callback tickets                                                                 |
| `/api/callbacks/:id/resolve`       | PUT       | Protected doctor route: marks a callback request resolved                                                                             |
| `/api/calls`                       | GET       | Protected doctor route: retrieves doctor call summaries with verbatim non-diagnostic patient concerns                                 |
| `/api/cost`                        | GET       | Live cost meter metrics against the 5,000 credit budget                                                                               |
| `/api/voice/session`               | POST      | Generates short-lived, rate-limited single-use token (`vtok_...`) for secure WebSocket authentication                                 |
| `/api/voice/latency`               | GET       | Retrieves real-time P50 and P95 latency percentiles across STT, LLM TTFT, TTS, and total voice turns                                  |
| `/voice-test.html`                 | GET       | Live Voice Agent testing interface with microphone capture, real-time waveform states, transcript, and latency telemetry debug        |
| `/ws/voice`                        | WebSocket | Authenticated full-duplex voice pipeline (PCM audio in $\rightarrow$ VAD $\rightarrow$ STT $\rightarrow$ Brain $\rightarrow$ TTS out) |
| `/api/chat`                        | POST      | Conversational endpoint (Emergency check $\rightarrow$ Evon LLM $\rightarrow$ Tool calling $\rightarrow$ Neon DB transaction)         |
| `/api/dashboard/stream`            | GET       | Server-Sent Events (SSE) stream for real-time doctor dashboard updates (appointments, alerts, callbacks, summaries)                   |

---

## Non-Negotiable Rules Compliance

1. **Rule 1 (LLM Never Writes to DB)**: LLM only emits validated tool arguments. Database operations execute via strict serializable transactions.
2. **Rule 2 (Zero Double-Booking)**: Enforced via PostgreSQL `CONSTRAINT uq_doctor_appointment_slot UNIQUE (doctor_id, appointment_date, start_time)` and `idempotency_key`. The agent confirms booking only after commit.
3. **Rule 3 (No Secrets in Code/Frontend)**: Fail-fast Zod startup validation; secrets stripped before serving configuration.
4. **Rule 4 (Safety & Emergency Triage)**: Deterministic code-level regex filter intercepts medical emergencies (chest pain, breathing arrest, stroke) and immediately triggers 108 escalation in Hinglish.
5. **Rule 5 (Resilience & Retries)**: 8,000ms timeouts, 3 retries with exponential backoff & jitter, and automatic receptionist callback ticket creation upon failure.
6. **Rule 6 (Pino-Style JSON Logging & Redaction)**: Structured JSON with `call_id` and `request_id`. Automatically masks phone numbers (`+91 ******3210`), patient names, and redacts all secrets.
7. **Rule 7 (5,000 Credit Budget Limiter)**: Enforces 50 credit/call and 2,000 credit/day limits. Mock mode enables testing with 0 credits burned.
8. **Rule 8 (Clean Modules & ADRs)**: Documented in [docs/adr/](docs/adr/).
