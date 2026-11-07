/**
 * Appointly Pure Slot Generator
 * Non-negotiable requirement: Pure function, zero side-effects, fully testable.
 * Computes available doctor slots according to working hours, visit duration,
 * confirmed bookings, and active/unexpired holds.
 */

import { GeneratedSlot } from '@appointly/shared';
import {
  kolkataToUtc,
  formatKolkata,
  getDayOfWeekInKolkata,
  addMinutes,
  isPastSlot,
} from '../utils/timezone.js';

export interface BookingInterval {
  slotStart: Date;
  slotEnd: Date;
  status: string; // 'CONFIRMED', 'CANCELLED', 'COMPLETED'
}

export interface HoldInterval {
  slotStart: Date;
  slotEnd: Date;
  expiresAt: Date;
  status: string; // 'ACTIVE', 'RELEASED', 'EXPIRED', 'CONVERTED'
}

export interface GenerateSlotsOptions {
  doctorId: string;
  dateStr: string; // YYYY-MM-DD in Asia/Kolkata
  workingHoursStart: string; // e.g. "09:00"
  workingHoursEnd: string; // e.g. "18:00"
  activeDays: string[]; // e.g. ['Monday', 'Tuesday', ...]
  durationMin: number; // e.g. 15, 30, 45
  existingBookings?: BookingInterval[];
  activeHolds?: HoldInterval[];
  referenceNow?: Date; // UTC reference for past time and hold expiration checks
}

/**
 * Checks if two time intervals [startA, endA) and [startB, endB) overlap.
 */
export function intervalsOverlap(startA: Date, endA: Date, startB: Date, endB: Date): boolean {
  return startA.getTime() < endB.getTime() && endA.getTime() > startB.getTime();
}

/**
 * Pure generator that calculates all slots and their availability for a doctor on a given day.
 */
export function generateDoctorSlots(options: GenerateSlotsOptions): GeneratedSlot[] {
  const {
    dateStr,
    workingHoursStart,
    workingHoursEnd,
    activeDays,
    durationMin,
    existingBookings = [],
    activeHolds = [],
    referenceNow = new Date(),
  } = options;

  if (durationMin <= 0) {
    throw new Error(`Invalid durationMin: ${durationMin}. Must be greater than 0.`);
  }

  // 1. Verify doctor operates on this weekday (in Asia/Kolkata)
  const dayOfWeek = getDayOfWeekInKolkata(dateStr);
  const isWorkingDay = activeDays.some(
    (day) => day.trim().toLowerCase() === dayOfWeek.trim().toLowerCase()
  );

  if (!isWorkingDay) {
    return [];
  }

  // 2. Parse working hours boundaries in Kolkata time
  const [startHourStr, startMinStr] = workingHoursStart.split(':');
  const [endHourStr, endMinStr] = workingHoursEnd.split(':');
  const startTotalMinutes = parseInt(startHourStr, 10) * 60 + parseInt(startMinStr, 10);
  const endTotalMinutes = parseInt(endHourStr, 10) * 60 + parseInt(endMinStr, 10);

  if (startTotalMinutes >= endTotalMinutes) {
    throw new Error(
      `Invalid working hours: start (${workingHoursStart}) must precede end (${workingHoursEnd})`
    );
  }

  const slots: GeneratedSlot[] = [];

  // Step across working hours by slot duration
  for (
    let currentMin = startTotalMinutes;
    currentMin + durationMin <= endTotalMinutes;
    currentMin += durationMin
  ) {
    const slotHour = Math.floor(currentMin / 60)
      .toString()
      .padStart(2, '0');
    const slotMinute = (currentMin % 60).toString().padStart(2, '0');
    const timeKolkata = `${slotHour}:${slotMinute}`;

    const slotStartUtc = kolkataToUtc(dateStr, timeKolkata);
    const slotEndUtc = addMinutes(slotStartUtc, durationMin);

    const formatted = formatKolkata(slotStartUtc);

    let available = true;
    let reasonIfUnavailable: GeneratedSlot['reasonIfUnavailable'] = undefined;

    // Check A: Past slot relative to reference now
    if (isPastSlot(slotStartUtc, referenceNow)) {
      available = false;
      reasonIfUnavailable = 'PAST_TIME';
    }

    // Check B: Confirmed booking overlap
    if (available) {
      const hasBookingCollision = existingBookings.some((b) => {
        if (b.status !== 'CONFIRMED') return false;
        return intervalsOverlap(slotStartUtc, slotEndUtc, b.slotStart, b.slotEnd);
      });

      if (hasBookingCollision) {
        available = false;
        reasonIfUnavailable = 'BOOKED';
      }
    }

    // Check C: Active unexpired hold overlap
    if (available) {
      const hasHoldCollision = activeHolds.some((h) => {
        // Only active holds that have NOT expired
        if (h.status !== 'ACTIVE') return false;
        const isNotExpired = h.expiresAt.getTime() > referenceNow.getTime();
        if (!isNotExpired) return false;
        return intervalsOverlap(slotStartUtc, slotEndUtc, h.slotStart, h.slotEnd);
      });

      if (hasHoldCollision) {
        available = false;
        reasonIfUnavailable = 'HELD';
      }
    }

    slots.push({
      slotStartUtc,
      slotEndUtc,
      timeKolkata,
      displayKolkata: formatted.displayTime,
      dateKolkata: dateStr,
      durationMin,
      available,
      reasonIfUnavailable,
    });
  }

  return slots;
}

/**
 * Filter only available slots from generated slots.
 */
export function filterAvailableSlots(slots: GeneratedSlot[]): GeneratedSlot[] {
  return slots.filter((s) => s.available);
}
