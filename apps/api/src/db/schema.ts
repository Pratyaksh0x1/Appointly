/**
 * Drizzle ORM Schema for Appointly
 * Implements 8 core tables with strict relational integrity,
 * UTC timestamps, and partial unique constraint for double-booking prevention.
 */

import {
  pgTable,
  varchar,
  text,
  integer,
  numeric,
  timestamp,
  jsonb,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// 1. DOCTORS
export const doctors = pgTable('doctors', {
  id: varchar('id', { length: 64 }).primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  specialty: varchar('specialty', { length: 255 }).notNull(),
  workingHoursStart: varchar('working_hours_start', { length: 10 }).notNull().default('09:00'),
  workingHoursEnd: varchar('working_hours_end', { length: 10 }).notNull().default('18:00'),
  activeDays: text('active_days')
    .array()
    .notNull()
    .default(
      sql`ARRAY['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']::text[]`
    ),
  durationMinutes: integer('duration_minutes').notNull().default(30),
  fee: numeric('fee', { precision: 10, scale: 2 }).notNull().default('500.00'),
  availableSlots: text('available_slots')
    .array()
    .default(sql`ARRAY[]::text[]`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// 2. APPOINTMENT TYPES
export const appointmentTypes = pgTable('appointment_types', {
  id: varchar('id', { length: 64 }).primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  durationMin: integer('duration_min').notNull().default(30),
  fee: numeric('fee', { precision: 10, scale: 2 }).notNull().default('500.00'),
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// 3. PATIENTS
export const patients = pgTable('patients', {
  id: varchar('id', { length: 64 }).primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  phone: varchar('phone', { length: 32 }).notNull(),
  phoneMasked: varchar('phone_masked', { length: 32 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// 4. APPOINTMENTS
export const appointments = pgTable(
  'appointments',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    doctorId: varchar('doctor_id', { length: 64 })
      .notNull()
      .references(() => doctors.id, { onDelete: 'restrict' }),
    patientId: varchar('patient_id', { length: 64 })
      .notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    appointmentTypeId: varchar('appointment_type_id', { length: 64 })
      .notNull()
      .references(() => appointmentTypes.id, { onDelete: 'restrict' }),
    slotStart: timestamp('slot_start', { withTimezone: true }).notNull(),
    slotEnd: timestamp('slot_end', { withTimezone: true }).notNull(),
    durationMin: integer('duration_min').notNull().default(30),
    status: varchar('status', { length: 32 }).notNull().default('CONFIRMED'), // 'CONFIRMED', 'CANCELLED', 'COMPLETED'
    idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull().unique(),
    cancellationReason: text('cancellation_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // NON-NEGOTIABLE RULE 2: Unique constraint preventing two active appointments for same doctor & slot_start
    uniqueIndex('uq_active_doctor_slot')
      .on(table.doctorId, table.slotStart)
      .where(sql`status = 'CONFIRMED'`),
  ]
);

// 5. SLOT HOLDS (2-Minute TTL auto-expiring temporary locks)
export const slotHolds = pgTable('slot_holds', {
  id: varchar('id', { length: 64 }).primaryKey(),
  doctorId: varchar('doctor_id', { length: 64 })
    .notNull()
    .references(() => doctors.id, { onDelete: 'cascade' }),
  slotStart: timestamp('slot_start', { withTimezone: true }).notNull(),
  slotEnd: timestamp('slot_end', { withTimezone: true }).notNull(),
  holdToken: varchar('hold_token', { length: 128 }).notNull().unique(),
  patientPhone: varchar('patient_phone', { length: 32 }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  status: varchar('status', { length: 32 }).notNull().default('ACTIVE'), // 'ACTIVE', 'RELEASED', 'EXPIRED', 'CONVERTED'
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// 6. CALLS
export const calls = pgTable('calls', {
  id: varchar('id', { length: 64 }).primaryKey(),
  patientPhoneMasked: varchar('patient_phone_masked', { length: 32 }),
  status: varchar('status', { length: 32 }).notNull().default('IN_PROGRESS'), // 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'ESCALATED'
  creditsUsed: numeric('credits_used', { precision: 10, scale: 2 }).notNull().default('0.00'),
  summary: text('summary'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
});

// 7. OUTBOX (Transactional outbox pattern for reliable async messaging)
export const outbox = pgTable('outbox', {
  id: varchar('id', { length: 64 }).primaryKey(),
  eventType: varchar('event_type', { length: 64 }).notNull(),
  payload: jsonb('payload').notNull(),
  status: varchar('status', { length: 32 }).notNull().default('PENDING'), // 'PENDING', 'PROCESSED', 'FAILED'
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
});

// 8. CALLBACK REQUESTS (Graceful fallback when external services fail)
export const callbackRequests = pgTable('callback_requests', {
  id: varchar('id', { length: 64 }).primaryKey(),
  callId: varchar('call_id', { length: 64 }),
  patientPhoneMasked: varchar('patient_phone_masked', { length: 32 }).notNull(),
  preferredSlot: varchar('preferred_slot', { length: 64 }),
  reason: text('reason').notNull(),
  status: varchar('status', { length: 32 }).notNull().default('PENDING'), // 'PENDING', 'RESOLVED'
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// 9. CREDIT AUDIT LOGS
export const creditAuditLogs = pgTable('credit_audit_logs', {
  id: varchar('id', { length: 64 }).primaryKey(),
  callId: varchar('call_id', { length: 64 }).notNull(),
  service: varchar('service', { length: 32 }).notNull(),
  unitsConsumed: numeric('units_consumed', { precision: 10, scale: 2 }).notNull(),
  estimatedCredits: numeric('estimated_credits', { precision: 10, scale: 2 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Inferred TypeScript Types
export type DoctorRow = typeof doctors.$inferSelect;
export type InsertDoctorRow = typeof doctors.$inferInsert;
export type AppointmentTypeRow = typeof appointmentTypes.$inferSelect;
export type InsertAppointmentTypeRow = typeof appointmentTypes.$inferInsert;
export type PatientRow = typeof patients.$inferSelect;
export type InsertPatientRow = typeof patients.$inferInsert;
export type AppointmentRow = typeof appointments.$inferSelect;
export type InsertAppointmentRow = typeof appointments.$inferInsert;
export type SlotHoldRow = typeof slotHolds.$inferSelect;
export type InsertSlotHoldRow = typeof slotHolds.$inferInsert;
export type CallRow = typeof calls.$inferSelect;
export type InsertCallRow = typeof calls.$inferInsert;
export type OutboxRow = typeof outbox.$inferSelect;
export type InsertOutboxRow = typeof outbox.$inferInsert;
export type CallbackRequestRow = typeof callbackRequests.$inferSelect;
export type InsertCallbackRequestRow = typeof callbackRequests.$inferInsert;
export type CreditAuditLogRow = typeof creditAuditLogs.$inferSelect;
