# ADR-003: Safety & Hardcoded Code-Level Emergency Escalation

## Status

Accepted

## Context

Non-negotiable Rule 4 mandates: "No medical diagnosis or advice. Emergency keywords trigger a hardcoded escalation (code-level, not only prompt-level)."
LLMs can hallucinate medical advice or fail to detect urgency when instructed solely via system prompts.

## Decision

1. **Code-Level Emergency Interceptor**:
   - Every patient utterance passes through a deterministic regex-based emergency scanner (`checkEmergency`) before reaching the LLM.
   - Covers critical life-threatening conditions (chest pain, severe breathing issues, acute bleeding, stroke signs, seizures, loss of consciousness) across English, Hindi, and Hinglish.
2. **Immediate Hardcoded Bypass**:
   - If an emergency trigger matches, the conversation state is immediately switched to `EMERGENCY`.
   - The system returns `EMERGENCY_ESCALATION_HINGLISH` directly:
     > "Yeh ek medical emergency lag rahi hai! Kripya turant nazdeeki hospital ke emergency ward jayein ya turant ambulance ke liye 108 dial karein..."
   - No LLM generation occurs, eliminating latency, token cost, and hallucination risk.
3. **Medical Advice Prohibition**:
   - System prompts and tool specifications forbid diagnosing ailments or prescribing medications.

## Consequences

- **Positive**: Zero risk of delayed emergency guidance or incorrect medical reassurance from LLM hallucinations.
- **Negative**: Highly conservative keyword matching may trigger on benign contexts (e.g., "mere dost ko pichle saal heart attack hua tha"); however, in clinical safety, a false positive emergency warning is far safer than a false negative.
