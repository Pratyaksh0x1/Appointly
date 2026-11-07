# Appointly 🏥🎙️

> **Hinglish Live Voice AI Agent for Small Clinics**  
> _Built for the Gnani AI Hackathon • Backed by Neon Serverless PostgreSQL_

![Appointly Logo](apps/dashboard/public/logo.jpg)

Appointly is an empathetic, multilingual voice assistant designed for small clinic reception desks in India. A patient speaks live in Hinglish (Hindi + English code-switching); Appointly confirms doctor availability, books the appointment via strict serializable database transactions on Neon PostgreSQL, confirms the doctor, date, start time, and duration, and instantly displays the booking on a real-time doctor dashboard via Server-Sent Events (SSE).

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
├── docs/adr/                 # Architecture Decision Records (ADR-001 to ADR-005)
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

# Run all 34 Vitest unit tests (including secret redaction & concurrency tests)
npm test

# Run end-to-end integration against Neon PostgreSQL
npm run test-e2e
```

### 4. Start the Development Server

```bash
npm run dev
```

Open **[http://localhost:3000](http://localhost:3000)** in your browser to view the Minimalist Doctor Dashboard with real-time SSE updates and the live voice assistant simulator.

---

## Endpoints Reference

| Endpoint                | Method | Purpose                                                                                                                       |
| :---------------------- | :----- | :---------------------------------------------------------------------------------------------------------------------------- |
| `/healthz`              | GET    | Liveness probe (returns HTTP 200 `{ status: "ok" }`)                                                                          |
| `/readyz`               | GET    | Readiness probe (verifies database connectivity and returns status)                                                           |
| `/health`               | GET    | Detailed health check (database status, doctors loaded, credit budget summary)                                                |
| `/api/doctors`          | GET    | Lists clinic doctors, specialties, fees, and consultation durations                                                           |
| `/api/slots`            | GET    | Retrieves open slots for a doctor on a specific date (`?doctorId=dr_sharma&date=YYYY-MM-DD`)                                  |
| `/api/appointments`     | GET    | Retrieves all confirmed appointments for the doctor dashboard                                                                 |
| `/api/callbacks`        | GET    | Retrieves saved receptionist callback tickets                                                                                 |
| `/api/cost`             | GET    | Live cost meter metrics against the 5,000 credit budget                                                                       |
| `/api/chat`             | POST   | Conversational endpoint (Emergency check $\rightarrow$ Evon LLM $\rightarrow$ Tool calling $\rightarrow$ Neon DB transaction) |
| `/api/dashboard/stream` | GET    | Server-Sent Events (SSE) stream for real-time doctor dashboard updates                                                        |

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
