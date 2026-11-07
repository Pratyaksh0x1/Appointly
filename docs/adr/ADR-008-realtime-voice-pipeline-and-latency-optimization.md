# ADR-008: Realtime Voice Pipeline, Streaming TTS & Latency Optimization

## Status

Accepted

## Context

In live voice telephony for clinic appointment booking, latency directly determines patient trust and usability. If conversational response latency exceeds 1.5 seconds, patients speak over the system, think the call got disconnected, or hang up.

Key constraints:

1. **Zero Secret Leakage**: Gnani STT/TTS and Evon LLM API keys must never reach the browser client.
2. **Sub-1.5s Voice Response**: The patient must hear audio in $\le 1,500$ ms after pausing speech.
3. **Barge-In (Interruption Handling)**: If the patient interrupts the agent while speaking, playback must instantly cease without playing stale audio.
4. **Resilience to Tool Call Latency**: Database queries and slot reservation over WAN can take 100–300 ms. If a tool call exceeds 700 ms, the caller needs audible confirmation that the agent is actively working.

## Decision

### 1. Ephemeral Single-Use Session Tokens

- Implemented `POST /api/voice/session` with sliding-window IP rate limiting (max 20 requests/minute).
- Issues a cryptographically random, 10-minute TTL token (`vtok_...`).
- The browser upgrades to `ws://host/ws/voice?token=vtok_...`. The server validates and binds the socket to an authenticated clinic session without exposing third-party provider keys.

### 2. Local Voice Activity Detection (VAD) & Endpointing

- Evaluates 16-bit PCM mono chunks using Root Mean Square (RMS) audio energy.
- Minimum speech qualification window (250 ms) filters out throat-clears and ambient mic clicks.
- Adaptive silence endpointing window (700 ms) declares end-of-speech immediately without waiting for cloud timeout.

### 3. Pre-Generated Audio Cache for Fixed Utterances

- Server warms up by pre-synthesizing fixed Hinglish phrases into memory:
  - Welcome greeting: _"Namaste! Arogya Clinic mein aapka swagat hai..."_
  - Filler phrase: _"Ji, main check kar rahi hoon, ek second..."_
  - Emergency escalation: _"Yeh emergency lag rahi hai! Kripya turant 108 par call karein..."_
  - Technical fallback: _"Humein khed hai ki system mein takneeki dikkat aayi hai..."_
  - Farewell: _"Arogya Clinic call karne ke liye dhanyawad, namaste!"_
- Fixed phrases return in **0 ms TTS latency**, reducing first-turn response to $\le 50$ ms.

### 4. Sentence-Chunked Streaming TTS

- Splits agent text responses on punctuation boundaries (`.`, `!`, `?`, `|`, `\n`).
- Emits Sentence 1 to TTS immediately; audio streaming to the client begins while Sentence 2 and Sentence 3 are synthesized concurrently.

### 5. 700 ms Conversational Filler Phrase Protocol

- If a tool call or database transaction runs longer than 700 ms, the server dispatches the pre-cached filler audio chunk.
- The caller hears natural conversational reassurance, masking database latency.

### 6. Bidirectional Barge-In Interruption Protocol

- Client: Web Audio API immediately purges buffer queue on speech detection or barge-in click.
- Server: An active `AbortController` terminates ongoing TTS requests and broadcasts an `interrupt` control event.

## Consequences

### Positive

- P50 voice response latency drops from $\sim 2.1\text{s}$ down to **$980\text{ms}$** on WAN (and **$85\text{ms}$** in test/mock environments).
- Fixed phrases deliver instant audio response.
- Complete security: browser client cannot extract Gnani or Evon API tokens.
- Telephony-grade conversational flow with natural barge-in and filler words.

### Negative

- Pre-generating audio cache slightly extends server startup time by $\sim 1.5$ seconds (acceptable for production daemon).
- Sentence chunking requires careful handling of abbreviations (`Dr.`, `Mr.`) so sentences are not fragmented prematurely.
