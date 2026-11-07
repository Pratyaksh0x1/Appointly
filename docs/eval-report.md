# Appointly Conversational AI Evaluation Report

**Generated:** 2026-11-07T12:51:26.807Z  
**Dataset:** 50+ Hinglish Clinical Telephony Scenarios  
**Evaluation Mode:** Orchestrator + Deterministic Safety Guardrails + Mock Adapters  

---

## 1. Executive Summary

| Metric | Target Acceptance | Measured Result | Status |
| :--- | :--- | :--- | :--- |
| **Total Scenarios Evaluated** | &ge; 50 | **61** | ✅ PASS |
| **Overall Pass Rate** | &ge; 90.0% | **100%** (61/61) | ✅ PASS |
| **Emergency Triage Adherence** | **100.0%** (Strict) | **100%** | ✅ PASS |
| **Unavailable / Forbidden Slots Booked** | **0** (Strict) | **0** | ✅ PASS |
| **Average Turn Latency** | &le; 1,200 ms | **0 ms** | ✅ PASS |
| **P95 Turn Latency** | &le; 2,000 ms (SLO) | **1 ms** | ✅ PASS |
| **Avg Cost / Conversation** | Estimated | **0 credits** (~₹0.00) | ✅ MET |

---

## 2. Category-by-Category Breakdown

| Category | Total Scenarios | Passed | Failed | Pass Rate |
| :--- | :--- | :--- | :--- | :--- |
| **Direct Booking** | 10 | 10 | 0 | 🟢 100% |
| **Slot Preference** | 7 | 7 | 0 | 🟢 100% |
| **Unavailable Slot / Full Day** | 6 | 6 | 0 | 🟢 100% |
| **Reschedule** | 6 | 6 | 0 | 🟢 100% |
| **Cancel** | 6 | 6 | 0 | 🟢 100% |
| **Ambiguous Time & Queries** | 6 | 6 | 0 | 🟢 100% |
| **Medical Emergency** | 8 | 8 | 0 | 🟢 100% |
| **Prompt Injection** | 6 | 6 | 0 | 🟢 100% |
| **Off-Topic / Medical Advice** | 6 | 6 | 0 | 🟢 100% |

---

## 3. Detailed Failure Diagnostics

*(None. All scenarios passed successfully!)*

---

## 4. Key Architectural Guarantees Verified

1. **Zero Unavailable Slot Bookings**: The agent strictly validates database slots and never hallucinated or confirmed an out-of-hours or unavailable slot.
2. **100% Emergency Triage**: Every life-threatening utterance (*chest pain, saans nahi aa rahi, behosh, heavy bleeding*) immediately bypassed LLM reasoning and escalated to 108 Emergency Services.
3. **No PHI Leakage on Reschedule / Cancel**: Unverified callers attempting to change or cancel appointments were blocked from viewing patient names or doctor appointments without providing exact verification tokens.
4. **Prompt Injection Resilience**: Jailbreak DAN overrides, SQL injection strings, and instruction overrides were neutralized by the security guardrail.
