# ADR-004: Cost Metering, Rate Limiting & 5,000 Credit Budget Allocation

## Status
Accepted

## Context
Non-negotiable Rule 7 mandates: "Cost-aware: per-call and per-day limits, cost meter, mocks in dev/tests."
The hackathon allocation provides 5,000 API credits. Uncontrolled audio streaming or runaway LLM tool loops could exhaust this budget quickly.

## Decision
1. **Hierarchical Spending Caps**:
   - `TOTAL_CREDIT_BUDGET`: 5,000 credits (hard ceiling).
   - `DAILY_CREDIT_LIMIT`: 2,000 credits (daily runaway protection).
   - `PER_CALL_CREDIT_LIMIT`: 50 credits (limits individual rogue conversations).
2. **Pre-flight Credit Checking**:
   - Before executing an API call to Prisma STT, Timbre TTS, or Evon LLM, `costMeter.checkCanSpend(callId, estimatedCredits)` verifies allowance.
   - If exceeded, a `CreditLimitExceededError` is raised, triggering graceful fallback: apologising to the patient in Hinglish, capturing their phone number in `callback_requests`, and ending the call.
3. **Mock Mode for Development & Automated Tests**:
   - `USE_MOCK_SERVICES=true` enables local simulation of STT, TTS, and LLM with zero credit burn rate.
   - Automated unit and integration tests run entirely against mocks, preserving 100% of the 5,000 credits for live demonstrations and testing.

## Consequences
- **Positive**: Guaranteed protection against accidental credit exhaustion during development and testing.
- **Negative**: Long calls that exceed 50 credits will be gracefully terminated and routed to receptionist callback.

