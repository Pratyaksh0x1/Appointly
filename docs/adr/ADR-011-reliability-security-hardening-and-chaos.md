# ADR-011: Reliability, Security Hardening, Chaos Resilience & Load Testing

## Status

Accepted

## Context

Phase 8 elevates Appointly from a prototype to a production-grade, highly resilient clinical voice platform. In healthcare clinic operations, systems face adversarial threat vectors, unpredictable network drops, API provider outages, and traffic spikes:

1. **Idempotency Guarantees:**
   - Network retries from web clients or telephony trunks must never re-trigger mutating side-effects or cause double-booking.
2. **Transactional Outbox with Dead-Letter Handling:**
   - Outbox events for reminders, schedule updates, and live dashboard synchronization must be protected against poison-pill events. If an event persistently fails, it must transition to a dead-letter state rather than blocking event relay queues.
3. **Defense-in-Depth Security & Rate Limiting:**
   - Protection against DoS attacks, credit exhaustion, prototype pollution, oversized payloads, and unauthorized cross-origin requests.
   - Strict enterprise security headers (CSP, HSTS, X-Content-Type-Options, etc.).
4. **Least-Privilege Database Access:**
   - Separation of DDL migration permissions from runtime application DML queries.
5. **PII and Data Protection Compliance:**
   - Redaction of patient phone numbers, emails, Aadhaar IDs, and Bearer tokens in structured JSON logs and database call summaries.
   - Automated retention job to purge call records past `TRANSCRIPT_RETENTION_DAYS` (DPDP compliance).
   - Zero persistent storage of raw caller audio.
6. **Graceful Degradation Under AI Provider Failures:**
   - If STT, LLM, or TTS fail or time out, the voice agent must apologize in natural Hinglish with zero latency using pre-cached audio, persist a callback request in the DB, and terminate cleanly without hanging the caller.
   - If the dashboard SSE connection drops, the frontend must automatically engage a 5-second polling fallback.
7. **Empirical Chaos and Load Verification:**
   - Verification through automated chaos testing (provider timeouts, DB recovery, mid-call disconnects) and a 50 concurrent call load test.

---

## Decisions

### 1. HTTP Idempotency Interceptor Middleware

- Mutating endpoints (`POST`, `PUT`, `DELETE`, `PATCH`) support `Idempotency-Key` or `X-Idempotency-Key` headers.
- An in-memory/Redis-compatible `IdempotencyStore` tracks request execution state:
  - `IN_PROGRESS`: Returns HTTP 409 Conflict if a concurrent identical request arrives.
  - `COMPLETED`: Transparently captures the status code, response headers, and serialized body, replaying the cached response with `X-Cache-Lookup: HIT` and `X-Idempotency-Replay: true`.
- Transient 5xx server errors are never cached, allowing clients to safely retry.

### 2. Transactional Outbox with Retry & Dead-Letter Queue

- Schema enhanced with `retry_count`, `max_retries` (default 3), and `last_error`.
- The outbox relay worker polls pending events using `FOR UPDATE SKIP LOCKED`.
- If dispatch fails, `retry_count` is incremented. When `retry_count >= max_retries`, status transitions to `'DEAD_LETTER'`, emitting alert logs and isolating the event without interrupting the relay pipeline.

### 3. Sliding-Window Rate Limiter & Request Sanitization

- `SlidingWindowRateLimiter` enforces rate limits per client IP and per session/doctor Bearer token (default 120 req/minute).
- Exceeding the threshold returns HTTP 429 (`TOO_MANY_REQUESTS`) with standard `X-RateLimit-*` and `Retry-After` headers.
- Request size limiter enforces `MAX_REQUEST_SIZE_BYTES` (1MB default), destroying oversized streams with HTTP 413 (`PAYLOAD_TOO_LARGE`).
- `sanitizeObject` strips `__proto__`, `constructor`, `prototype`, null bytes (`\0`), and ASCII control characters from parsed JSON.

### 4. Enterprise Security Headers & CORS Allowlist

- Helmet-style security headers applied across all responses:
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `X-XSS-Protection: 1; mode=block`
  - `Strict-Transport-Security: max-age=31536000; includeSubDomains`
  - `Content-Security-Policy: default-src 'self' ...`
  - `Permissions-Policy: microphone=(self), camera=(), geolocation=()`
- Dynamic CORS origin validation against configured `CORS_ORIGIN` allowlist with `Vary: Origin`.

### 5. Least-Privilege Database Roles

- Architected dual-role database security model:
  - `appointly_admin` (Migration role): Full DDL (`CREATE`, `ALTER`, `DROP`) used strictly during database migrations.
  - `appointly_app` (Application runtime role): Strict DML (`SELECT`, `INSERT`, `UPDATE`, `DELETE`) with `REVOKE ALL ON SCHEMA public FROM PUBLIC` and no DDL privileges.
- Script provided at `scripts/setup-least-privilege-db-roles.sql` and documented in `docs/db-roles.md`.

### 6. PII Redaction & Transcript Retention

- Automated PII scrubbing:
  - Phone numbers masked to `+91 ******<last4>`.
  - 12-digit Indian Aadhaar numbers masked to `****-****-****`.
  - Email addresses masked to `u***r@domain.com`.
  - Bearer tokens redacted to `Bearer [REDACTED]`.
- Configurable retention background worker (`TRANSCRIPT_RETENTION_DAYS`, default 30 days) executing periodic deletions of call records older than the retention threshold.
- `STORE_RAW_AUDIO=false`: Raw mic audio chunks are processed strictly in RAM buffers and never written to persistent disk storage.

### 7. Graceful Degradation Protocols

- **Voice Agent Degradation:** On unexpected STT, LLM, or TTS failure/timeout, the server streams pre-cached Hinglish apology audio chunk (`FIXED_PHRASES.FALLBACK`) with 0ms latency, emits a `GRACEFUL_DEGRADATION_TRIGGERED` event, persists a `callback_request` in Neon PostgreSQL, and closes the session cleanly after audio delivery.
- **Doctor Dashboard Degradation:** If the SSE connection encounters an error, the dashboard UI immediately engages a 5-second polling fallback, updating its indicator badge to `"Polling Active (Fallback)"`. Upon reconnection, polling is stopped and `"Neon Postgres Live"` is restored.

---

## Consequences

### Positive

- **High Concurrency Reliability:** 50 concurrent calls benchmarked at 7.2 calls/sec, 21.7 turns/sec, with 0 errors and zero double-booking collisions.
- **Fail-Safe Clinical User Experience:** Patient calls never end abruptly with silent dead air when upstream AI providers fail; pre-cached voice fallback and automatic callback persistence guarantee continuity of care.
- **Regulatory DPDP Compliance:** Automated PII masking, transcript retention, and zero raw audio persistence ensure patient confidentiality.
- **Resilient Realtime Architecture:** Outbox dead-letter queues isolate problematic events, and dashboard polling fallback guarantees doctor visibility during transient network disruptions.

### Negative / Trade-offs

- In-memory rate limiting and idempotency stores are node-local. In multi-instance cluster deployments, a distributed Redis/Dragonfly backing store will be required.
