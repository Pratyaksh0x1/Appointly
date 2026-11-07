# Appointly 🏥🎙️
> **Hinglish Live Voice AI Agent for Small Clinics**  
> *Built for the Gnani AI Hackathon*

![Appointly Logo](public/logo.jpg)

Appointly is an empathetic, multilingual voice agent designed for small clinic reception desks in India. A patient speaks live in Hinglish (Hindi + English code-switching); Appointly confirms doctor availability, books the appointment via strict serializable database transactions, confirms the doctor, date, start time, and duration, and instantly displays the booking on a real-time doctor dashboard.

---

## Non-Negotiable Core Architectural Principles

1. **Transaction-First Booking (Rule 1 & 2)**:
   - The LLM never writes directly to the database; it calls validated tools.
   - Zero double-booking enforced via PostgreSQL unique constraint `UNIQUE(doctor_id, appointment_date, start_time)` and `idempotency_key`.
   - The agent says "booked" **only after** the transaction successfully commits.
2. **Safety & Hardcoded Emergency Triage (Rule 4)**:
   - Code-level deterministic scanner (`checkEmergency`) executes before any LLM processing.
   - Life-threatening symptoms (chest pain, cardiac arrest, breathing failure, stroke, unconsciousness) immediately trigger a hardcoded 108 emergency escalation in Hinglish.
   - Appointly never offers medical diagnosis or medication advice.
3. **5,000 Credit Budget & Cost Metering (Rule 7)**:
   - Tracks credit burn rates across Gnani Prisma STT, Gnani Timbre TTS, and Evon 30B LLM.
   - Enforces per-call (50 credits) and daily (2,000 credits) ceilings to prevent accidental exhaustion.
   - High-fidelity mock mode (`USE_MOCK_SERVICES=true`) preserves 100% of credits during development and testing.
4. **Structured JSON Logs with Zero Raw PII (Rule 6)**:
   - Emits structured JSON logs with `call_id` and `request_id`.
   - Auto-redacts secrets and masks patient phone numbers (`+91 ******3210`) and names.
5. **Fail-Fast Startup & Secret Isolation (Rule 3)**:
   - Zod environment validation at startup.
   - Secrets are never exposed to the frontend dashboard.

---

## Architecture Decision Records (ADRs)

- [ADR-001: Architecture, Stack & Monolithic Stateless Backend](docs/adr/ADR-001-architecture-and-stack.md)
- [ADR-002: Zero Double-Booking via Transaction Isolation & Idempotency Keys](docs/adr/ADR-002-zero-double-booking.md)
- [ADR-003: Safety & Hardcoded Code-Level Emergency Escalation](docs/adr/ADR-003-safety-and-emergency-escalation.md)
- [ADR-004: Cost Metering, Rate Limiting & 5,000 Credit Budget Allocation](docs/adr/ADR-004-cost-metering-and-credit-allocation.md)

---

## Project Structure

```
appointly/
├── public/
│   └── logo.jpg              # Appointly Logo
├── docs/
│   └── adr/                  # Architectural Decision Records
│       ├── ADR-001-architecture-and-stack.md
│       ├── ADR-002-zero-double-booking.md
│       ├── ADR-003-safety-and-emergency-escalation.md
│       └── ADR-004-cost-metering-and-credit-allocation.md
├── src/
│   ├── config/
│   │   └── env.ts            # Fail-fast Zod startup environment validation
│   ├── types/
│   │   └── index.ts          # Core domain models (Doctor, Appointment, CallContext)
│   ├── logger/
│   │   └── logger.ts         # Structured JSON logger with automatic PII masking
│   ├── safety/
│   │   └── emergency.ts      # Hardcoded emergency keyword triage & 108 escalation
│   ├── cost/
│   │   └── cost-meter.ts     # 5,000 credit budget guardrail & spending limiter
│   └── db/
│       ├── schema.sql        # PostgreSQL schema with UNIQUE constraints
│       ├── client.ts         # IDatabaseClient interface
│       ├── memory-db.ts      # Transactional in-memory DB for tests & standalone dev
│       ├── postgres-db.ts    # Real PostgreSQL client with SERIALIZABLE transactions
│       └── index.ts          # DB factory
├── tests/
│   ├── env.test.ts           # Env validation & secret stripping tests
│   ├── emergency.test.ts     # Hindi/English/Hinglish emergency detection tests
│   ├── cost-meter.test.ts    # Per-call, daily limit & mock tests
│   ├── db.test.ts            # Concurrency race condition & double-booking tests
│   └── logger.test.ts        # PII & phone masking tests
├── .env.example              # Documented configuration template
├── tsconfig.json             # Strict TypeScript configuration
└── package.json
```

---

## Quickstart

### 1. Configure Environment
```bash
cp .env.example .env
```

### 2. Run Tests, Lint & Typecheck
```bash
npm run typecheck
npm run lint
npm test
```
All 23 test suites pass out of the box with zero external dependencies using the in-memory transactional mock engine.
