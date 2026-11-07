# Appointly Service Level Objectives (SLOs) & Production Operational Guide

This document establishes the official Service Level Agreements (SLAs), Service Level Objectives (SLOs), and Service Level Indicators (SLIs) for **Appointly** — the Hinglish AI voice booking system for clinic outpatients, backed by Neon Serverless PostgreSQL and Gnani Voice AI.

---

## 1. High-Level SLO Summary

| Service Dimension       | Service Level Indicator (SLI)                                                    | Target Objective (SLO)          | Measurement Window    | Alert Severity                              |
| :---------------------- | :------------------------------------------------------------------------------- | :------------------------------ | :-------------------- | :------------------------------------------ |
| **System Availability** | Ratio of non-5xx, successfully served telephony turns & REST API requests        | **&ge; 99.90%** (Three Nines)   | Rolling 30-day window | `CRITICAL` (> 5% error rate)                |
| **Turn Latency (P95)**  | Time from caller speech termination (VAD endpoint) to first audio chunk playback | **&le; 2,000 ms** (2.0 seconds) | Rolling 1,000 turns   | `WARNING` (> 2,000 ms)                      |
| **Turn Latency (P50)**  | Median conversational voice turnaround latency                                   | **&le; 1,200 ms** (1.2 seconds) | Rolling 1,000 turns   | `INFO` (> 1,200 ms)                         |
| **Emergency Triage**    | Hardcoded medical emergency keywords escalation success                          | **100.00%** (Zero Tolerance)    | Per incident          | `CRITICAL` (Immediate Webhook & 108 Triage) |
| **Zero Double Booking** | Duplicate booking prevention under high concurrency                              | **100.00%** (Zero Tolerance)    | Continuous            | `CRITICAL` (Database constraint check)      |

---

## 2. SLI Specifications & Measurement

### A. Availability SLI

$$\text{Availability} = \frac{\text{Total Requests} - \text{Server 5xx Errors} - \text{Unrecoverable Drops}}{\text{Total Requests}} \times 100\%$$

- **Good Events**:
  - HTTP status codes 2xx, 3xx, and 4xx (client validation errors, slot full notifications).
  - WebSockets voice turns that deliver agent audio chunks or pre-cached graceful degradation audio.
- **Bad Events**:
  - HTTP 500/503 errors.
  - Abrupt WebSocket disconnections prior to turn completion without fallback audio delivery.

### B. Latency SLI (Per-Stage Breakdown)

Every turn is instrumented with sub-millisecond timestamps tracking each pipeline stage:

1. **$T_1$ (Speech-to-Text)**: End of caller speech to final transcript from Prisma STT (Target: $\le 400\text{ ms}$).
2. **$T_2$ (Orchestrator & LLM)**: Final transcript to state transition / Evon first token emission (Target: $\le 600\text{ ms}$).
3. **$T_3$ (Text-to-Speech)**: First sentence chunk to first audio byte emitted by Timbre TTS (Target: $\le 450\text{ ms}$).
4. **$T\_{\text{Total}}$ (End-to-End Turn)**: Caller silence to speaker audio start:
   $$T_{\text{Total}} = T_1 + T_2 + T_3$$

---

## 3. Honest Note on Free-Tier & Hardware Limitations

Operating modern AI voice telephony on free-tier serverless infrastructure involves specific physical realities. Below is an honest engineering disclosure of known boundaries and our defensive mitigations:

### 1. Neon Serverless PostgreSQL Compute Suspension

- **Behavior**: Neon automatically suspends compute endpoints after 5 minutes of total inactivity to conserve compute resources.
- **Impact**: The initial database query after compute suspension incurs a cold-start resume latency of **500 ms to 1,500 ms**.
- **Architectural Mitigations**:
  - **Connection Pooling**: Appointly connects via Neon's connection pooler (`ep-*-pooler.neon.tech`), which maintains persistent lightweight proxy sockets.
  - **0 ms In-Memory Audio Pre-Caching**: Fixed telephony phrases (e.g., initial greeting, apology fallback) are pre-synthesized into RAM buffers at Node.js startup. When a caller dials in, the welcome greeting plays in **0 ms**, completely masking database resume time in the background.

### 2. Gnani Voice AI Free-Tier Concurrency & Rate Limits

- **Behavior**: Free developer tier accounts enforce per-minute request limits and concurrency boundaries on Prisma STT and Timbre TTS.
- **Impact**: Bursts of concurrent calls may encounter HTTP 429 or increased response queuing.
- **Architectural Mitigations**:
  - **Sentence-Chunked Streaming**: TTS synthesis is pipelined sentence by sentence rather than waiting for the entire paragraph.
  - **700 ms Filler Phrase Protocol**: If a tool execution or external API call takes longer than 700 ms, the agent automatically utters a natural filler phrase (_"Ji, main doctor ka schedule check kar rahi hoon..."_), keeping the conversation engaged.
  - **Circuit Breaker**: Trips after 5 consecutive downstream errors, immediately degrading to local fallback with zero user hang.

### 3. Hosted Evon LLM Latency Fluctuations

- **Behavior**: Evon-30B or OpenAI-compatible endpoints experience load variance during high server traffic.
- **Architectural Mitigations**:
  - **Rule-Based Fast Path**: Deterministic date resolution (`kal`, `parson`, `shaam ko`), name extraction, and doctor lookup are processed purely in TypeScript without needing an LLM inference call for standard booking steps.
  - **Code-Level Emergency Detector**: Bypasses the LLM completely, providing **&lt; 5 ms deterministic emergency escalation**.

---

## 4. Alerting Thresholds & Webhook Protocols

The built-in `AlertEngine` evaluates telemetry metrics on every turn and runs periodic sanity checks:

| Alert ID                   | Condition                           | Trigger Threshold              | Action Taken                                    |
| :------------------------- | :---------------------------------- | :----------------------------- | :---------------------------------------------- |
| `HIGH_ERROR_RATE`          | Call error rate over sliding window | **&gt; 5.0%**                  | Structured `ERROR` log + Webhook dispatch       |
| `HIGH_TURN_LATENCY`        | Voice turn P95 latency              | **&gt; 2,000 ms**              | Structured `WARN` log + Webhook dispatch        |
| `CREDIT_DEPLETION_WARNING` | Gnani AI credit budget consumed     | **&ge; 90.0%** (4,500 / 5,000) | `CRITICAL` alert on dashboard + notification    |
| `EMERGENCY_ESCALATION`     | Acute cardiac/respiratory symptoms  | **Immediate**                  | Broadcasts SSE alert to doctor dashboard & logs |

---

## 5. Observability Endpoints

- **Prometheus Metrics**: `GET /metrics`  
  Returns Prometheus text exposition format (version 0.0.4) for scraping by Prometheus or Grafana Agent.
- **JSON Telemetry for Dashboards**: `GET /api/metrics`  
  Returns real-time KPIs, conversion rates, and stage percentile summaries.
- **Active System Alerts**: `GET /api/alerts`  
  Returns active alerts and historical incidents.
