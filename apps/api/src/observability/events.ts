/**
 * Appointly Structured Event Catalog & Observability Event Names
 * Standardizes event names across the API, Voice Pipeline, Orchestrator, and Database.
 */

export const AppointlyEvents = {
  // Call Lifecycle
  CALL_STARTED: 'call.started',
  CALL_CONNECTED: 'call.connected',
  CALL_DISCONNECTED: 'call.disconnected',
  CALL_DROPPED: 'call.dropped',
  CALL_ENDED: 'call.ended',

  // Conversational Turns & Stages
  TURN_STARTED: 'turn.started',
  TURN_COMPLETED: 'turn.completed',
  STT_COMPLETED: 'turn.stt.completed',
  LLM_INFERENCE_STARTED: 'turn.llm.started',
  LLM_FIRST_TOKEN: 'turn.llm.first_token',
  LLM_COMPLETED: 'turn.llm.completed',
  TTS_SYNTHESIS_STARTED: 'turn.tts.started',
  TTS_FIRST_AUDIO: 'turn.tts.first_audio',
  TTS_COMPLETED: 'turn.tts.completed',

  // Booking & Appointment Domain Events
  SLOTS_CHECKED: 'slots.checked',
  SLOT_HELD: 'slot.held',
  SLOT_HOLD_RELEASED: 'slot.hold.released',
  BOOKING_INITIATED: 'booking.initiated',
  BOOKING_COMPLETED: 'booking.completed',
  BOOKING_FAILED: 'booking.failed',
  RESCHEDULE_INITIATED: 'reschedule.initiated',
  RESCHEDULE_COMPLETED: 'reschedule.completed',
  RESCHEDULE_FAILED: 'reschedule.failed',
  CANCEL_INITIATED: 'cancel.initiated',
  CANCEL_COMPLETED: 'cancel.completed',
  CANCEL_FAILED: 'cancel.failed',

  // Guardrails & Safety
  EMERGENCY_DETECTED: 'safety.emergency.detected',
  PROMPT_INJECTION_FLAGGED: 'safety.prompt_injection.flagged',
  UNAUTHORIZED_ACCESS_ATTEMPT: 'security.unauthorized_access',
  RATE_LIMIT_EXCEEDED: 'security.rate_limit_exceeded',
  PAYLOAD_TOO_LARGE: 'security.payload_too_large',

  // System & Financial
  COST_RECORDED: 'cost.recorded',
  CREDIT_CAP_REACHED: 'cost.credit_cap_reached',
  OUTBOX_EVENT_EMITTED: 'outbox.event.emitted',
  OUTBOX_EVENT_PROCESSED: 'outbox.event.processed',
  OUTBOX_EVENT_DEAD_LETTER: 'outbox.event.dead_letter',
  TRANSCRIPT_RETENTION_PURGED: 'retention.transcripts_purged',

  // Alerts & SLO
  ALERT_TRIGGERED: 'alert.triggered',
  ALERT_RESOLVED: 'alert.resolved',
  SLO_BREACHED: 'slo.breached',

  // Evaluation
  EVAL_RUN_STARTED: 'eval.run.started',
  EVAL_RUN_COMPLETED: 'eval.run.completed',
} as const;

export type AppointlyEventName = (typeof AppointlyEvents)[keyof typeof AppointlyEvents];
