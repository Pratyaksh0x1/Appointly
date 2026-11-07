# ADR-001: Architecture, Stack & Monolithic Stateless Backend

## Status

Accepted

## Context

Appointly is a Hinglish live voice agent designed for small clinics for the Gnani AI hackathon.
The system needs to:

- Accept real-time audio streams from patients.
- Perform STT via Gnani Prisma v3.0, reasoning via Evon 30B LLM, and speech synthesis via Gnani Timbre v3.0.
- Execute verified tool calls to book clinic appointments with atomic database transactions.
- Broadcast instant updates to a doctor dashboard.
- Operate reliably within a 5,000 credit budget.

## Decision

1. **Language & Runtime**: TypeScript on Node.js (v20+), strict compiler mode. Single language across backend, domain models, and dashboard utilities to prevent schema drift.
2. **Stateless Backend Service**: A single Node.js/TypeScript service that handles HTTP REST, Server-Sent Events (SSE) for the doctor dashboard, and WebSocket streaming for voice audio.
3. **Database Architecture**: PostgreSQL as the primary system of record with a transactional memory client for unit testing and local development without external dependencies.
4. **Tool Isolation**: The LLM NEVER writes directly to the database. It only generates structured tool call parameters (`book_appointment`, `get_available_slots`, etc.) which are strictly validated before executing a database transaction.

## Consequences

- **Positive**: Minimal infrastructure overhead, zero distributed state synchronization bugs, high developer velocity, fast unit test suite.
- **Negative**: Audio streaming and WebSocket connections share the same process event loop; CPU-intensive audio transformations should be avoided or delegated.
