# ADR-002: Zero Double-Booking via Transaction Isolation & Idempotency Keys

## Status
Accepted

## Context
In clinic appointment scheduling, race conditions and duplicate voice requests (e.g. user repeating "book karo", network packet duplicates) can lead to double-booking a doctor's limited time slot.
Non-negotiable Rule 2 mandates: "No double booking: unique constraint + transaction + idempotency key."

## Decision
1. **Relational Database Unique Constraint**:
   - `CONSTRAINT uq_doctor_appointment_slot UNIQUE (doctor_id, appointment_date, start_time)` on table `appointments`.
   - The database engine is the authoritative single source of truth.
2. **Transaction Isolation & Row Locking**:
   - Transactions execute with `SERIALIZABLE` isolation or `SELECT ... FOR UPDATE` locking on the slot.
   - If two concurrent requests attempt to reserve the same slot simultaneously, one succeeds and the other immediately fails with `SLOT_ALREADY_BOOKED`.
3. **Idempotency Keys**:
   - Every booking attempt requires an `idempotencyKey` (e.g., derived from `call_id + doctor_id + date + start_time` or client UUID).
   - If an identical idempotency key is received, the transaction returns the existing appointment with `IDEMPOTENT_REPLAY` without creating duplicate records or erroring out.
4. **Agent Confirmation Rule**:
   - The conversational agent NEVER promises an appointment is booked until the DB transaction has successfully committed.

## Consequences
- **Positive**: Complete guarantee against double booking even under high concurrency or packet re-transmission.
- **Negative**: Rejected concurrent bookings require the dialogue manager to offer the patient the next closest available slot.
