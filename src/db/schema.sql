-- Appointly Clinic Database Schema
-- Strict Relational Integrity & Concurrency Controls

CREATE TABLE IF NOT EXISTS doctors (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    specialty VARCHAR(255) NOT NULL,
    duration_minutes INT NOT NULL DEFAULT 30,
    fee NUMERIC(10,2) NOT NULL DEFAULT 500.00,
    active_days TEXT[] NOT NULL DEFAULT ARRAY['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    available_slots TEXT[] NOT NULL DEFAULT ARRAY['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '17:00', '17:30', '18:00', '18:30'],
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS appointments (
    id VARCHAR(64) PRIMARY KEY,
    doctor_id VARCHAR(64) NOT NULL REFERENCES doctors(id) ON DELETE RESTRICT,
    patient_name VARCHAR(255) NOT NULL,
    patient_phone_masked VARCHAR(64) NOT NULL,
    appointment_date DATE NOT NULL,
    start_time VARCHAR(10) NOT NULL, -- e.g. '09:30'
    end_time VARCHAR(10) NOT NULL,   -- e.g. '10:00'
    duration_minutes INT NOT NULL DEFAULT 30,
    status VARCHAR(32) NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('CONFIRMED', 'CANCELLED', 'COMPLETED')),
    idempotency_key VARCHAR(128) NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- NON-NEGOTIABLE RULE 2: Unique constraint preventing double-booking on same doctor, date & time
    CONSTRAINT uq_doctor_appointment_slot UNIQUE (doctor_id, appointment_date, start_time)
);

CREATE TABLE IF NOT EXISTS callback_requests (
    id VARCHAR(64) PRIMARY KEY,
    call_id VARCHAR(64) NOT NULL,
    patient_phone_masked VARCHAR(64) NOT NULL,
    preferred_slot VARCHAR(64),
    reason TEXT NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RESOLVED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS credit_audit_logs (
    id VARCHAR(64) PRIMARY KEY,
    call_id VARCHAR(64) NOT NULL,
    service VARCHAR(32) NOT NULL,
    units_consumed NUMERIC(10,2) NOT NULL,
    estimated_credits NUMERIC(10,2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed Doctors
INSERT INTO doctors (id, name, specialty, duration_minutes, fee, active_days, available_slots)
VALUES
    ('dr_sharma', 'Dr. Ramesh Sharma', 'General Medicine & Family Physician', 30, 500.00,
     ARRAY['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
     ARRAY['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '17:00', '17:30', '18:00', '18:30']),
    ('dr_priya', 'Dr. Priya Patel', 'Pediatrician (Child Specialist)', 30, 600.00,
     ARRAY['Monday', 'Wednesday', 'Friday', 'Saturday'],
     ARRAY['10:00', '10:30', '11:00', '11:30', '12:00', '17:00', '17:30', '18:00']),
    ('dr_rajesh', 'Dr. Rajesh Kumar', 'Cardiologist (Heart Specialist)', 30, 900.00,
     ARRAY['Tuesday', 'Thursday', 'Saturday'],
     ARRAY['17:00', '17:30', '18:00', '18:30', '19:00', '19:30']),
    ('dr_ananya', 'Dr. Ananya Iyer', 'Dermatologist (Skin & Hair)', 30, 700.00,
     ARRAY['Monday', 'Tuesday', 'Thursday', 'Friday'],
     ARRAY['10:00', '10:30', '11:00', '11:30', '17:30', '18:00', '18:30'])
ON CONFLICT (id) DO NOTHING;
