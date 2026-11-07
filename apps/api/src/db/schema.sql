-- Appointly Clinic Database Schema
-- Strict Relational Integrity & Concurrency Controls
-- Phase 2 Tables: doctors, appointment_types, patients, appointments, slot_holds, calls, outbox, callback_requests

-- 1. Doctors
CREATE TABLE IF NOT EXISTS doctors (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    specialty VARCHAR(255) NOT NULL,
    working_hours_start VARCHAR(10) NOT NULL DEFAULT '09:00',
    working_hours_end VARCHAR(10) NOT NULL DEFAULT '18:00',
    active_days TEXT[] NOT NULL DEFAULT ARRAY['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    duration_minutes INT NOT NULL DEFAULT 30,
    fee NUMERIC(10,2) NOT NULL DEFAULT 500.00,
    available_slots TEXT[] DEFAULT ARRAY[]::TEXT[],
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Appointment Types (Visit Types)
CREATE TABLE IF NOT EXISTS appointment_types (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    duration_min INT NOT NULL DEFAULT 30,
    fee NUMERIC(10,2) NOT NULL DEFAULT 500.00,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Patients
CREATE TABLE IF NOT EXISTS patients (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(32) NOT NULL,
    phone_masked VARCHAR(32) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Appointments
CREATE TABLE IF NOT EXISTS appointments (
    id VARCHAR(64) PRIMARY KEY,
    doctor_id VARCHAR(64) NOT NULL REFERENCES doctors(id) ON DELETE RESTRICT,
    patient_id VARCHAR(64) REFERENCES patients(id) ON DELETE RESTRICT,
    appointment_type_id VARCHAR(64) REFERENCES appointment_types(id) ON DELETE RESTRICT,
    slot_start TIMESTAMPTZ NOT NULL,
    slot_end TIMESTAMPTZ NOT NULL,
    duration_min INT NOT NULL DEFAULT 30,
    status VARCHAR(32) NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('CONFIRMED', 'CANCELLED', 'COMPLETED')),
    idempotency_key VARCHAR(128) NOT NULL UNIQUE,
    cancellation_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Compatibility columns for legacy queries
    patient_name VARCHAR(255),
    patient_phone_masked VARCHAR(64),
    appointment_date DATE,
    start_time VARCHAR(10),
    end_time VARCHAR(10),
    duration_minutes INT DEFAULT 30
);

-- NON-NEGOTIABLE RULE 2: Unique constraint preventing two active appointments for same doctor & slot_start
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_doctor_slot 
ON appointments (doctor_id, slot_start) 
WHERE status = 'CONFIRMED';

-- 5. Slot Holds (2-minute auto-expiring temporary reservation)
CREATE TABLE IF NOT EXISTS slot_holds (
    id VARCHAR(64) PRIMARY KEY,
    doctor_id VARCHAR(64) NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
    slot_start TIMESTAMPTZ NOT NULL,
    slot_end TIMESTAMPTZ NOT NULL,
    hold_token VARCHAR(128) NOT NULL UNIQUE,
    patient_phone VARCHAR(32) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RELEASED', 'EXPIRED', 'CONVERTED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_slot_holds_lookup 
ON slot_holds (doctor_id, slot_start, expires_at) 
WHERE status = 'ACTIVE';

-- 6. Calls
CREATE TABLE IF NOT EXISTS calls (
    id VARCHAR(64) PRIMARY KEY,
    patient_phone_masked VARCHAR(32),
    status VARCHAR(32) NOT NULL DEFAULT 'IN_PROGRESS' CHECK (status IN ('IN_PROGRESS', 'COMPLETED', 'FAILED', 'ESCALATED')),
    credits_used NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    summary TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMPTZ
);

-- 7. Outbox (Transactional Outbox Pattern)
CREATE TABLE IF NOT EXISTS outbox (
    id VARCHAR(64) PRIMARY KEY,
    event_type VARCHAR(64) NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSED', 'FAILED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending 
ON outbox (status, created_at) 
WHERE status = 'PENDING';

-- 8. Callback Requests
CREATE TABLE IF NOT EXISTS callback_requests (
    id VARCHAR(64) PRIMARY KEY,
    call_id VARCHAR(64),
    patient_phone_masked VARCHAR(64) NOT NULL,
    preferred_slot VARCHAR(64),
    reason TEXT NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RESOLVED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 9. Credit Audit Logs
CREATE TABLE IF NOT EXISTS credit_audit_logs (
    id VARCHAR(64) PRIMARY KEY,
    call_id VARCHAR(64) NOT NULL,
    service VARCHAR(32) NOT NULL,
    units_consumed NUMERIC(10,2) NOT NULL,
    estimated_credits NUMERIC(10,2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
