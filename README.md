# Appointly 🏥🎙️
### AI-Powered Voice Receptionist & Smart Appointment Management for Clinics

<p align="center">
An empathetic, multilingual Voice AI assistant that helps small clinics automate appointment booking, patient communication, and doctor scheduling through natural Hinglish conversations.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white" />
  <img src="https://img.shields.io/badge/Node.js-339933?style=flat&logo=nodedotjs&logoColor=white" />
  <img src="https://img.shields.io/badge/PostgreSQL-4169E1?style=flat&logo=postgresql&logoColor=white" />
  <img src="https://img.shields.io/badge/Neon-00E599?style=flat&logo=neon&logoColor=black" />
  <img src="https://img.shields.io/badge/Docker-2496ED?style=flat&logo=docker&logoColor=white" />
  <img src="https://img.shields.io/badge/License-MIT-green.svg" />
</p>
---

## 📌 Overview

**Appointly** is an AI-powered voice receptionist designed specifically for small and independent clinics in India.

Traditional appointment booking often requires patients to call clinics, wait for receptionists, understand doctor availability, and manually coordinate their appointments.

Appointly simplifies this entire process using a real-time conversational AI agent.

Patients can speak naturally in Hindi, English, or Hinglish (Hindi-English code-switching). The AI assistant understands their requirements, checks doctor availability, offers suitable appointment slots, and securely books appointments.

Once an appointment is confirmed, the doctor dashboard receives an instant update without requiring a page refresh.

Unlike a simple chatbot, Appointly combines conversational AI with deterministic scheduling logic, transactional database operations, real-time communication, and safety guardrails.

**Built for the Gnani AI Hackathon.**

## ✨ Key Features

### 🎙️ 1. Real-Time Hinglish Voice AI

- Natural voice conversations in Hindi, English, and Hinglish.
- Live speech-to-text using Gnani Prisma STT.
- Natural speech generation using Gnani Timbre TTS.
- Conversational reasoning powered by Evon 30B.
- Real-time, bidirectional audio streaming over WebSockets.
- Sentence-level audio streaming for faster responses.
- Voice Activity Detection (VAD) for detecting speech and silence.
- Barge-in support: patients can interrupt the AI while it is speaking.
- Pre-generated audio responses for greetings, fillers, emergency escalations, and fallback messages.

### 📅 2. Intelligent Appointment Booking

Patients can book appointments through natural conversations.

Example:

> Patient: Mujhe kal shaam ko doctor se appointment chahiye.
>
> Appointly: Ji bilkul! Kal shaam ke liye available slots check karti hoon. Aap 5:30 PM ya 6:00 PM mein se kaunsa prefer karenge?
>
> Patient: 6 baje.
>
> Appointly: Aapki appointment 6:00 PM ke liye confirm ho gayi hai.

Features include:

- Real-time doctor availability checking.
- Automatic appointment slot generation.
- Doctor-specific consultation durations.
- Dynamic OPD scheduling.
- Temporary appointment slot holds.
- Automatic slot release when calls disconnect.
- Confirmation readback before completing bookings.
- Maximum two appointment options offered at a time.
- Automatic receptionist callback requests when booking cannot be completed.

### 🔄 3. Appointment Lifecycle Management

Appointly supports the complete appointment lifecycle:

- Book new appointments.
- Reschedule existing appointments.
- Cancel appointments.
- Mark consultations as completed.
- Verify patient identity before sensitive appointment operations.
- Release cancelled appointment slots automatically.
- Prevent unauthorized access to patient appointment information.

### 👨‍⚕️ 4. Real-Time Doctor Dashboard

Doctors can manage their clinic appointments through a centralized dashboard.

Dashboard capabilities include:

- Today's appointments.
- Upcoming appointments.
- Interactive OPD schedule grid.
- Appointment status tracking.
- Dynamic doctor working hours.
- Real-time booking notifications.
- Emergency and escalation alerts.
- Receptionist callback request management.
- AI-generated call summaries.
- Live API credit consumption.
- System health and latency monitoring.

**Real-time synchronization:** The dashboard uses Server-Sent Events (SSE) to receive booking updates, cancellations, rescheduling events, and alerts without manual refreshing.

If the SSE connection fails, the dashboard automatically switches to a polling fallback.

### 🚨 5. Emergency Detection & Medical Safety

Patient safety is a core design principle.

Appointly uses deterministic, code-level emergency detection instead of relying exclusively on LLM-generated responses.

The system detects critical symptoms such as:

- Chest pain.
- Difficulty breathing.
- Unconsciousness.
- Other configured emergency indicators.

When a potential emergency is detected:

1. The emergency scanner intercepts the conversation.
2. The normal booking workflow is bypassed.
3. The system triggers the configured emergency escalation response.
4. The patient receives an appropriate emergency instruction, including India's 108 emergency service guidance.
5. An emergency event is recorded and communicated to the doctor dashboard.

**Important:** Appointly is an appointment-management assistant, not a diagnostic system. It does not provide medical diagnoses or replace professional medical care.

### 🔐 6. Authentication & Security

- HMAC-SHA256 signed JWT authentication.
- Google OAuth authentication for doctors.
- Protected doctor dashboard APIs.
- Short-lived, single-use WebSocket authentication tokens.
- Server-side API credential management.
- Dynamic CORS origin allowlisting.
- Request validation using Zod.
- Input sanitization.
- HTTP security headers.
- Per-IP and per-session rate limiting.
- Request body size restrictions.
- Automated masking of sensitive information in logs.
- Separate database roles for migrations and application runtime.

### ⚡ 7. Reliability & Fault Tolerance

Appointly is designed to handle failures without silently creating incorrect appointments.

- Idempotency keys for mutating API requests.
- PostgreSQL transactional booking operations.
- Transactional outbox pattern.
- Automatic retry and dead-letter handling.
- Circuit breakers for external AI services.
- Graceful fallback when STT, LLM, or TTS providers fail.
- Automatic callback request creation when the AI workflow cannot finish.
- Automatic cleanup of abandoned appointment slot holds.
- SSE reconnection with polling fallback.

### 📊 8. Observability & Performance Monitoring

Appointly includes a built-in observability system.

- Prometheus-compatible `/metrics` endpoint.
- Structured JSON event logging.
- Request and call correlation IDs.
- P50, P90, P95, and P99 latency monitoring.
- STT, LLM, and TTS latency tracking.
- Booking conversion statistics.
- API credit consumption monitoring.
- Automated alerts for high error rates.
- Latency threshold alerts.
- Credit budget depletion alerts.
- Doctor dashboard system health panel.

### 🧪 9. Conversational Evaluation & Testing

Appointly includes a conversational evaluation harness covering scenarios such as:

- Direct appointment booking.
- Preferred appointment slots.
- Unavailable appointment slots.
- Rescheduling.
- Cancellation.
- Ambiguous time expressions.
- Medical emergencies.
- Prompt injection attempts.
- Off-topic conversations.

It also includes unit tests, integration tests, concurrency tests, lifecycle tests, and resilience tests.

---

## 🏗️ System Architecture

Appointly follows a modular monorepo architecture with separate API, dashboard, and shared packages.

### High-Level Architecture

```mermaid
flowchart TD
    A["Patient"] --> B["Live Voice Interface"]
    B --> C["WebSocket Audio Streaming"]
    C --> D["Voice Activity Detection"]
    D --> E["Gnani Prisma STT"]
    E --> F["Emergency Detection"]

    F -->|Emergency| G["Emergency Escalation"]
    F -->|Normal Request| H["Evon 30B LLM"]

    H --> I["Conversation State Machine"]
    I --> J["Validated Tool Calls"]
    J --> K["Appointment Services"]

    K --> L[("Neon PostgreSQL")]
    L --> M["Transactional Outbox"]
    M --> N["SSE Event Relay"]
    N --> O["Doctor Dashboard"]

    K --> P["Gnani Timbre TTS"]
    G --> P
    P --> Q["Patient Audio Response"]
```

### Voice Processing Pipeline

The voice pipeline follows these steps:

1. **Audio Capture:** The browser captures microphone audio and streams 16 kHz PCM audio chunks.
2. **Voice Activity Detection:** Local RMS-based VAD detects speech and silence.
3. **Speech Recognition:** Gnani Prisma STT converts speech into text.
4. **Emergency Screening:** A deterministic emergency scanner checks for critical symptoms.
5. **Conversation Reasoning:** Evon 30B processes the patient's intent and determines the next conversational action.
6. **Tool Execution:** Validated tool calls interact with the appointment management services.
7. **Database Transaction:** The booking service checks availability and commits the appointment.
8. **Speech Generation:** Gnani Timbre TTS converts the response into natural speech.
9. **Audio Streaming:** The generated response is streamed back to the patient.
10. **Dashboard Synchronization:** The transactional outbox publishes events to the doctor's dashboard through SSE.

### Conversation State Machine

The conversation is controlled through an explicit finite state machine.

```mermaid
stateDiagram-v2
    [*] --> GREETING_CONSENT
    GREETING_CONSENT --> UNDERSTAND_INTENT
    UNDERSTAND_INTENT --> COLLECT_DETAILS
    COLLECT_DETAILS --> OFFER_SLOTS
    OFFER_SLOTS --> CONFIRM_READBACK
    CONFIRM_READBACK --> BOOKED
    UNDERSTAND_INTENT --> RESCHEDULE
    UNDERSTAND_INTENT --> CANCEL
    UNDERSTAND_INTENT --> ESCALATE
    UNDERSTAND_INTENT --> FALLBACK
    BOOKED --> [*]
    RESCHEDULE --> [*]
    CANCEL --> [*]
    ESCALATE --> [*]
    FALLBACK --> [*]
```

The LLM is responsible for natural conversational responses, while the application state machine and validated backend tools control actual operations.

---

## 🛠️ Technology Stack

| Layer | Technologies |
|---|---|
| Backend | Node.js, TypeScript |
| Voice Recognition (STT) | Gnani Prisma |
| Voice Generation (TTS) | Gnani Timbre |
| Conversational Intelligence | Evon 30B |
| Real-Time Communication | WebSockets, SSE |
| Database | PostgreSQL, Neon Serverless |
| ORM | Drizzle ORM |
| Validation | Zod |
| Authentication | JWT, HMAC-SHA256, Google OAuth |
| Monitoring | Prometheus, Structured Logging |
| Testing | Vitest |
| Containerization | Docker, Docker Compose |
| CI/CD | GitHub Actions |

---

## 📂 Project Structure

```text
Appointly/
│
├── apps/
│   ├── api/
│   │   ├── src/
│   │   │   ├── agent/
│   │   │   │   └── orchestrator.ts
│   │   │   ├── auth/
│   │   │   ├── database/
│   │   │   ├── providers/
│   │   │   ├── services/
│   │   │   ├── routes/
│   │   │   ├── observability/
│   │   │   └── index.ts
│   │   └── tests/
│   │
│   └── dashboard/
│       └── Doctor Dashboard
│
├── packages/
│   └── shared/
│       └── Shared types, validation schemas
│
├── docs/
│   ├── adr/
│   ├── eval-report.md
│   ├── latency.md
│   ├── load-test.md
│   ├── slo.md
│   ├── threat-model.md
│   ├── gnani-notes.md
│   └── demo-script.md
│
├── scripts/
│   ├── migrate.ts
│   ├── seed.ts
│   ├── eval-harness.ts
│   ├── preflight-check.ts
│   └── smoke-voice-pipeline.ts
│
├── public/
│
├── .github/
│   └── workflows/
│
├── .env.example
├── ARCHITECTURE.md
├── Dockerfile
├── docker-compose.yml
├── Makefile
├── package.json
└── README.md
```

---

## 🚀 Getting Started

Follow these instructions to run Appointly locally.

### Prerequisites

Make sure you have the following installed:

- Node.js and npm.
- Git.
- PostgreSQL or a Neon PostgreSQL database (for persistent database mode).
- Docker and Docker Compose (optional).
- Gnani API credentials (for real STT and TTS).
- Evon 30B running through an OpenAI-compatible local endpoint or configured provider.
- Google OAuth Client ID (for Google doctor authentication).

### 1. Clone the Repository

```bash
git clone https://github.com/Pratyaksh0x1/Appointly.git

cd Appointly
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment Variables

Create a `.env` file from the example configuration.

```bash
cp .env.example .env
```

Configure the following variables:

```env
# Server
PORT=3000
NODE_ENV=development
LOG_LEVEL=info

# Database
DATABASE_URL=postgres://postgres:postgres@localhost:5432/appointly

# Use in-memory database for local testing
USE_IN_MEMORY_DB=true

# Gnani STT & TTS
GNANI_API_KEY=your_gnani_api_key

GNANI_STT_URL=https://api.vachana.ai/stt/v3
GNANI_STT_MODEL=prisma-v3.0
GNANI_STT_LANGUAGE=indic-auto

GNANI_TTS_URL=https://api.vachana.ai/api/v1/tts/inference
GNANI_TTS_MODEL=timbre-v3.0
GNANI_TTS_VOICE=Shivani
GNANI_TTS_LANGUAGE=hi-IN

# Evon LLM
EVON_BASE_URL=http://localhost:11434/v1
EVON_MODEL=evon-30b
EVON_API_KEY=

# Google OAuth
GOOGLE_CLIENT_ID=your_google_client_id

# Mock Services
USE_MOCK_SERVICES=true

# Credit Management
TOTAL_CREDIT_BUDGET=5000
PER_CALL_CREDIT_LIMIT=50
DAILY_CREDIT_LIMIT=2000

# Retry Configuration
HTTP_TIMEOUT_MS=8000
MAX_RETRIES=3
BACKOFF_BASE_MS=500
```

Refer to `.env.example` for the complete configuration, including WebSocket endpoints, additional provider settings, and other runtime options.

**Important:** The example above is for local development. For persistent database usage, configure a valid PostgreSQL/Neon connection and disable the in-memory database mode. Configure real provider credentials when switching off mock services.

Never commit your `.env` file or expose API keys in the frontend.

### 4. Run Database Migrations

For persistent PostgreSQL mode:

```bash
npm run migrate
```

Seed the initial clinic and doctor data:

```bash
npm run seed
```

### 5. Start the Development Server

```bash
npm run dev
```

The application runs at:

```text
http://localhost:3000
```

Open the URL in your browser to access the doctor dashboard.

The voice testing interface is available at:

```text
http://localhost:3000/voice-test.html
```

### 6. Run with Docker

You can also run the application using Docker Compose:

```bash
docker compose up --build
```

To stop the containers:

```bash
docker compose down
```

---

## 🧪 Testing & Development

Appointly provides several commands for development and quality assurance.

| Command | Description |
|---|---|
| `npm run dev` | Start development server |
| `npm run build` | Build application workspaces |
| `npm run start` | Start production server |
| `npm run typecheck` | Run TypeScript checks |
| `npm run lint` | Run type checks and formatting validation |
| `npm run format` | Format project files |
| `npm run format:check` | Check formatting |
| `npm test` | Run automated tests |
| `npm run test:watch` | Run tests in watch mode |
| `npm run eval` | Run conversational evaluation harness |
| `npm run smoke:voice` | Test the voice processing pipeline |
| `npm run preflight` | Run preflight verification |
| `npm run audit` | Audit dependencies |
| `npm run chat:cli` | Start CLI-based conversational testing |

### Test Scenarios

The evaluation harness covers nine major categories:

1. Direct appointment bookings.
2. Preferred time-slot selection.
3. Unavailable appointment slots.
4. Appointment rescheduling.
5. Appointment cancellation.
6. Ambiguous time interpretation.
7. Medical emergency handling.
8. Prompt injection protection.
9. Off-topic conversation handling.

Additional automated tests cover concurrency, authentication, appointment lifecycle, voice processing, and system resilience.

---

## 🔌 API Reference

Appointly exposes REST APIs, WebSocket communication, and Server-Sent Events.

### Health & Monitoring

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/healthz` | Liveness check |
| GET | `/readyz` | Readiness check |
| GET | `/health` | Detailed application health |
| GET | `/metrics` | Prometheus metrics |
| GET | `/api/metrics` | JSON telemetry |
| GET | `/api/alerts` | System alerts |

### Authentication

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/config/auth` | Public authentication configuration |
| POST | `/api/auth/google` | Google authentication |
| POST | `/api/auth/dev-login` | Development demo login |

### Clinic & Doctor Management

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/clinic/profile` | Retrieve clinic information |
| POST | `/api/clinic/onboarding` | Configure initial clinic setup |
| PUT | `/api/clinic/settings` | Update clinic configuration |
| GET | `/api/doctors` | Retrieve doctor roster |
| PUT/POST | `/api/doctors/:id/schedule` | Update doctor schedule |

### Appointment Management

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/slots` | Retrieve available slots |
| GET | `/api/appointments` | Retrieve appointments |
| PUT | `/api/appointments/:id/reschedule` | Reschedule appointment |
| PUT | `/api/appointments/:id/cancel` | Cancel appointment |
| PUT | `/api/appointments/:id/complete` | Complete appointment |

### Voice & Conversation

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/voice/session` | Generate secure voice session token |
| POST | `/api/chat` | Process conversational requests |
| GET | `/api/voice/latency` | Retrieve voice latency metrics |
| GET | `/voice-test.html` | Voice testing interface |
| WebSocket | `/ws/voice` | Bidirectional audio streaming |
| GET | `/api/dashboard/stream` | Real-time dashboard SSE stream |

### Callback & Call Management

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/callbacks` | Retrieve callback requests |
| PUT | `/api/callbacks/:id/resolve` | Resolve callback request |
| GET | `/api/calls` | Retrieve AI call summaries |
| GET | `/api/cost` | Retrieve credit consumption |

---

## 🗄️ Database Design

Appointly uses PostgreSQL with Drizzle ORM and SQL migrations.

The database is organized around eight core relational tables.

| Table | Responsibility |
|---|---|
| `doctors` | Doctor profiles, specialties, OPD hours |
| `appointment_types` | Consultation types and durations |
| `patients` | Patient information |
| `appointments` | Confirmed appointments |
| `slot_holds` | Temporary appointment reservations |
| `calls` | Voice call records and outcomes |
| `outbox` | Reliable asynchronous event delivery |
| `callback_requests` | Receptionist follow-up requests |

### Preventing Double Bookings

One of Appointly's most important design decisions is preventing two patients from booking the same doctor and time slot.

The system uses PostgreSQL constraints, transactional booking logic, and idempotency keys.

An active-slot uniqueness constraint ensures that only one confirmed appointment can occupy a doctor’s slot.

```sql
CREATE UNIQUE INDEX uq_active_doctor_slot
ON appointments (doctor_id, slot_start)
WHERE status = 'CONFIRMED';
```

The booking workflow also uses temporary slot holds and atomic transactions.

This ensures that concurrent requests cannot silently create duplicate confirmed bookings.

### Transactional Outbox Pattern

Appointly uses a transactional outbox to ensure that database changes and event publishing remain reliable.

1. Appointment changes are committed to PostgreSQL.
2. The corresponding event is stored in the outbox.
3. A background relay processes pending events.
4. The event is broadcast to connected dashboards.
5. Failed events are retried and eventually moved to dead-letter status when retry limits are exceeded.

---

## 🔒 Security & Privacy

Appointly incorporates multiple security measures:

- Sensitive API credentials remain server-side.
- Doctor APIs require authentication.
- WebSocket connections use short-lived, single-use tokens.
- Input is validated and sanitized.
- Mutating requests support idempotency protection.
- Request rate limits help prevent abuse.
- Logs automatically redact sensitive information.
- Raw microphone audio is processed in memory rather than persisted as audio files by default.
- Transcript retention is configurable.
- Database runtime roles follow the principle of least privilege.
- Appointment rescheduling and cancellation require caller verification.

The project also documents its security threat model and database role architecture.

---

## 📈 Performance & Reliability

Appointly incorporates performance targets and resilience mechanisms into its architecture.

| Metric / Mechanism | Target or Design |
|---|---|
| Dashboard availability SLO | 99.9% target |
| Voice turn latency | P95 under 2 seconds target |
| Temporary slot hold | 2 minutes |
| Default API rate limit | 120 requests/minute |
| Voice session token | Single-use, 10 minutes |
| Transcript retention | 30 days by default |
| Maximum credit budget | 5,000 credits |
| Per-call credit limit | 50 credits |
| Daily credit limit | 2,000 credits |

These are project-defined targets and configuration defaults, not a guarantee of production service availability or performance.

For detailed measurements, see the benchmark and SLO documentation.

---

## 📚 Documentation

Additional technical documentation is available in the `docs/` directory.

| Document | Description |
|---|---|
| `ARCHITECTURE.md` | System architecture and data flow |
| `docs/adr/` | Architecture Decision Records |
| `docs/latency.md` | Voice pipeline latency benchmarks |
| `docs/load-test.md` | Concurrent load and resilience tests |
| `docs/slo.md` | Service Level Objectives |
| `docs/threat-model.md` | Security threat analysis |
| `docs/db-roles.md` | Database role architecture |
| `docs/gnani-notes.md` | Gnani API integration notes |
| `docs/evon-hosting.md` | Evon model hosting guidance |
| `docs/eval-report.md` | Conversational evaluation results |
| `docs/demo-script.md` | Hackathon demonstration guide |

---

## 🔮 Future Scope

Potential directions for extending Appointly include:

- Multi-clinic and multi-location support.
- Additional Indian regional languages.
- WhatsApp appointment booking and reminders.
- Integration with real telephony providers.
- Automated prescription and medical-record workflows.
- Advanced clinic analytics and reporting.
- Calendar synchronization.
- More configurable patient verification methods.
- Expanded accessibility features.

---

## 🤝 Contributing

Contributions, feature suggestions, and bug reports are welcome.

1. Fork this repository.
2. Create a new feature branch.

```bash
git checkout -b feature/your-feature-name
```

3. Make your changes.
4. Run the tests and type checks.

```bash
npm run typecheck
npm test
```

5. Commit your changes.

```bash
git commit -m "feat: add your feature"
```

6. Push your branch.

```bash
git push origin feature/your-feature-name
```

7. Open a Pull Request.

---

## 🏆 Project Information

**Project:** Appointly

**Category:** Healthcare Technology / Conversational AI / Voice AI

**Focus:** AI-powered appointment management for small clinics.

**Hackathon:** Gnani AI Hackathon

**Database:** Neon Serverless PostgreSQL

**License:** MIT

---

## 📄 License

This project is licensed under the MIT License. See the `LICENSE` file for details.

---

<p align="center">
  <b>Appointly — Making healthcare appointments as simple as having a conversation. 🏥</b>
  <br/>
  Built with ❤️ for smarter, more accessible healthcare.
</p>
