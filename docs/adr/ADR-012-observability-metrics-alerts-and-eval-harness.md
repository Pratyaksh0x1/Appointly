# ADR-012: Observability Architecture, Prometheus Metrics, Real-Time Alerting, and Conversational Eval Harness

## Status

Accepted

## Date

2026-11-07

## Context

Operating real-time voice telephony applications requires observability beyond traditional web APIs. Because conversational voice agents pipeline audio ingestion, Voice Activity Detection (VAD), Speech-to-Text (STT), Large Language Model (LLM) reasoning, and Text-to-Speech (TTS) streaming across network boundaries, a latency hiccup in any individual stage causes dead air or caller frustration.

Furthermore, running on serverless cloud infrastructure (such as Neon PostgreSQL and cloud-hosted Gnani Voice AI) introduces operational boundaries:

1. Neon Serverless compute suspends after 5 minutes of inactivity, resulting in a 500ms–1.5s cold-start on the first turn.
2. Free-tier AI provider rate limits can bottleneck concurrent turns.
3. Life-critical requirements (medical emergencies) must adhere to a 100% zero-regression escalation rule.
4. Clinic integrity demands zero double-bookings and zero bookings of unavailable/out-of-hours slots.

## Decision

### 1. Unified Structured Event Taxonomy

We standardized all logging across the repository using `AppointlyEvents` (`apps/api/src/observability/events.ts`). Every log entry includes either a `call_id` or `request_id`, standard event names (e.g., `call.started`, `turn.stt.completed`, `booking.completed`, `safety.emergency.detected`), and automated PII redaction (phones, emails, Aadhaar numbers, and authorization headers).

### 2. Low-Overhead In-Memory Metrics Collector & Prometheus Exposition

We implemented `MetricsCollector` (`apps/api/src/observability/metrics.ts`):

- **Ring-Buffer Stage Tracking**: Measures $T_{\text{STT}}$, $T_{\text{LLM First Token}}$, $T_{\text{TTS First Audio}}$, and $T_{\text{Turn Total}}$.
- **Percentiles**: Dynamically calculates Min, P50, P90, P95, Max, and Average over rolling sample windows without relying on heavyweight external agents.
- **Prometheus Standard**: Exposes Prometheus Text Exposition Format (version 0.0.4) on `GET /metrics` for ingestion by Prometheus, Datadog, or Grafana Agent.
- **JSON Telemetry**: Exposes `GET /api/metrics` supplying real-time conversion rates, call breakdowns, and stage latencies to the Doctor Dashboard.

### 3. Real-Time Alert Engine (`AlertEngine`)

We implemented `AlertEngine` (`apps/api/src/observability/alerts.ts`):

- **Error Rate Alert (`HIGH_ERROR_RATE`)**: Triggers when call failures exceed 5.0% over recent calls.
- **Latency SLO Breach Alert (`HIGH_TURN_LATENCY`)**: Triggers when P95 turn latency exceeds 2,000 ms.
- **Credit Depletion Warning (`CREDIT_DEPLETION_WARNING`)**: Triggers when budget consumption reaches 90% (4,500 / 5,000 credits).
- **Non-Blocking Webhook Dispatch**: Asynchronously dispatches alert notifications via HTTP POST to `ALERT_WEBHOOK_URL` if configured, with error containment to prevent impacting caller audio.

### 4. Explicit SLOs with Honest Free-Tier Disclosure (`docs/slo.md`)

We committed to:

- **Availability SLO**: 99.9% availability for telephony turns and REST routes.
- **Turn Latency SLO**: P95 turn latency under 2.0 seconds.
- **Honest Free-Tier Mitigation**: Neon compute suspension (500ms–1.5s cold starts) is mitigated by pre-caching welcome and apology audio buffers in Node.js RAM at startup. The caller hears immediate voice audio in 0ms while the database resumes in the background.

### 5. Automated Conversational Eval Harness (`npm run eval`)

We created `scripts/fixtures/eval-scenarios.json` and runner `scripts/eval-harness.ts`:

- **57 Diverse Hinglish Clinical Scenarios**: Covers direct bookings, slot preferences, unavailable/out-of-hours requests, secure reschedule/cancellations, ambiguous dates, medical emergencies, prompt injections, and off-topic queries.
- **Strict Non-Negotiable Acceptance**:
  - Medical emergency scenarios must achieve **100% pass rate**.
  - Zero unavailable or forbidden slots can ever be confirmed or committed.
  - Overall suite pass rate must exceed **90%**.
- **CI Integration**: Executed automatically on every pull request and push to `main` via `.github/workflows/ci.yml`.

## Consequences

### Positive

- Production-grade observability without requiring external agent daemons.
- Prometheus compatibility out of the box with standard scraping agents.
- The Doctor Dashboard displays live SLO badges, latency tables, and active alerts.
- Regressions in emergency escalation or slot validation are caught in CI before reaching deployment.

### Negative / Trade-offs

- In-memory metrics reset on server restart (appropriate for single-instance stateless services; external Prometheus scraping provides long-term persistence).
