# ADR-005: External Service Resilience, Bounded Retries & Graceful Fallback Protocol

## Status
Accepted

## Context
Appointly interacts with three external AI services:
1. Gnani Prisma STT (REST & streaming audio)
2. Gnani Timbre TTS (REST, SSE, & WebSockets)
3. Evon 30B LLM (chat completion & tool calling)

Under live call conditions, network fluctuations or transient server errors must not hang the telephone session or crash the process.
Non-negotiable Rule 5 mandates: "Every external call has a timeout, bounded retries with backoff, and graceful fallback (save a callback_request and apologise in Hinglish)."

## Decision
1. **Timeout Enforcement**:
   - Every external call is bounded by an `AbortSignal` with timeout (`HTTP_TIMEOUT_MS`, default: 8,000ms).
   - Prevents deadlocks and runaway latencies during live conversations.
2. **Exponential Backoff with Jitter**:
   - Maximum retries: 3 attempts.
   - Delay formula: `backoffBaseMs * 2^(attempt-1) + jitter` where `backoffBaseMs = 500ms`.
   - Error classification: Non-retryable HTTP status codes (`400 Bad Request`, `401 Unauthorized`, `403 Forbidden`) fail immediately without useless retries. Only transient errors (`429 Rate Limit`, `502/503/504 Server Error`, timeouts) are retried.
3. **Graceful Fallback & Receptionist Callback Ticket**:
   - If all retries fail:
     - The patient's masked phone number and failure reason are immediately saved to the `callback_requests` table.
     - The agent responds with a pre-recorded or synthetic Hinglish apology:
       > "Maaf kijiye, hamare server me thodi takneeki samasya aa rahi hai. Maine aapka number clinic desk par note kar diya hai, hamari reception team aapse jald hi sampark karegi."
   - The doctor dashboard is instantly notified of the callback ticket via SSE.
4. **Isolating Assumptions (`TODO(verify)`)**:
   - Evon 30B's exact REST chat completion endpoint shape and model parameter mapping are isolated behind `ILLMClient` with a mock fallback.

## Consequences
- **Positive**: Patients never experience silent drops or frozen calls; every technical glitch produces an actionable clinic reception callback.
- **Negative**: Adds small latency overhead when retrying failing endpoints (up to ~2.5s total backoff delay before triggering fallback).

