import { describe, it, expect } from 'vitest';
import {
  generateDoctorSlots,
  filterAvailableSlots,
  intervalsOverlap,
} from '../src/services/slot-generator.js';
import { kolkataToUtc, addMinutes } from '../src/utils/timezone.js';

describe('Pure Slot Generator Service', () => {
  const defaultDoctor = {
    doctorId: 'dr_sharma',
    dateStr: '2026-11-10', // Tuesday
    workingHoursStart: '09:00',
    workingHoursEnd: '11:00',
    activeDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    durationMin: 30,
  };

  const earlyMorningRefNow = kolkataToUtc('2026-11-10', '07:00');

  it('generates expected 30-min slots across working hours', () => {
    const slots = generateDoctorSlots({
      ...defaultDoctor,
      referenceNow: earlyMorningRefNow,
    });

    expect(slots.length).toBe(4);
    expect(slots.map((s) => s.timeKolkata)).toEqual(['09:00', '09:30', '10:00', '10:30']);
    expect(slots.every((s) => s.available)).toBe(true);
    expect(slots[0].displayKolkata).toBe('09:00 AM');
    expect(slots[1].displayKolkata).toBe('09:30 AM');
  });

  it('generates 15-minute slots correctly', () => {
    const slots = generateDoctorSlots({
      ...defaultDoctor,
      durationMin: 15,
      referenceNow: earlyMorningRefNow,
    });

    expect(slots.length).toBe(8);
    expect(slots[0].timeKolkata).toBe('09:00');
    expect(slots[1].timeKolkata).toBe('09:15');
    expect(slots[2].timeKolkata).toBe('09:30');
    expect(slots[7].timeKolkata).toBe('10:45');
  });

  it('returns empty array when doctor is inactive on that day', () => {
    // Dr. Rajesh works Tuesday, Thursday, Saturday
    const slots = generateDoctorSlots({
      doctorId: 'dr_rajesh',
      dateStr: '2026-11-09', // Monday
      workingHoursStart: '16:00',
      workingHoursEnd: '20:00',
      activeDays: ['Tuesday', 'Thursday', 'Saturday'],
      durationMin: 30,
      referenceNow: earlyMorningRefNow,
    });

    expect(slots).toEqual([]);
  });

  it('marks past slots as unavailable with PAST_TIME', () => {
    // Reference time is 09:45 AM IST
    const midMorningRef = kolkataToUtc('2026-11-10', '09:45');

    const slots = generateDoctorSlots({
      ...defaultDoctor,
      referenceNow: midMorningRef,
    });

    expect(slots[0].timeKolkata).toBe('09:00');
    expect(slots[0].available).toBe(false);
    expect(slots[0].reasonIfUnavailable).toBe('PAST_TIME');

    expect(slots[1].timeKolkata).toBe('09:30');
    expect(slots[1].available).toBe(false);
    expect(slots[1].reasonIfUnavailable).toBe('PAST_TIME');

    expect(slots[2].timeKolkata).toBe('10:00');
    expect(slots[2].available).toBe(true);
  });

  it('blocks slots that overlap with confirmed bookings', () => {
    const bookedStart = kolkataToUtc('2026-11-10', '09:30');
    const bookedEnd = addMinutes(bookedStart, 30);

    const slots = generateDoctorSlots({
      ...defaultDoctor,
      existingBookings: [{ slotStart: bookedStart, slotEnd: bookedEnd, status: 'CONFIRMED' }],
      referenceNow: earlyMorningRefNow,
    });

    const slot0930 = slots.find((s) => s.timeKolkata === '09:30');
    expect(slot0930?.available).toBe(false);
    expect(slot0930?.reasonIfUnavailable).toBe('BOOKED');

    const slot0900 = slots.find((s) => s.timeKolkata === '09:00');
    expect(slot0900?.available).toBe(true);

    const slot1000 = slots.find((s) => s.timeKolkata === '10:00');
    expect(slot1000?.available).toBe(true);
  });

  it('blocks slots that have an active, unexpired hold', () => {
    const holdStart = kolkataToUtc('2026-11-10', '10:00');
    const holdEnd = addMinutes(holdStart, 30);
    // Hold expires 2 minutes in future
    const holdExpiresAt = addMinutes(earlyMorningRefNow, 2);

    const slots = generateDoctorSlots({
      ...defaultDoctor,
      activeHolds: [
        {
          slotStart: holdStart,
          slotEnd: holdEnd,
          expiresAt: holdExpiresAt,
          status: 'ACTIVE',
        },
      ],
      referenceNow: earlyMorningRefNow,
    });

    const slot1000 = slots.find((s) => s.timeKolkata === '10:00');
    expect(slot1000?.available).toBe(false);
    expect(slot1000?.reasonIfUnavailable).toBe('HELD');
  });

  it('releases slot if hold has expired', () => {
    const holdStart = kolkataToUtc('2026-11-10', '10:00');
    const holdEnd = addMinutes(holdStart, 30);
    // Hold expired 1 minute in the past
    const expiredAt = new Date(earlyMorningRefNow.getTime() - 60 * 1000);

    const slots = generateDoctorSlots({
      ...defaultDoctor,
      activeHolds: [
        {
          slotStart: holdStart,
          slotEnd: holdEnd,
          expiresAt: expiredAt,
          status: 'ACTIVE',
        },
      ],
      referenceNow: earlyMorningRefNow,
    });

    const slot1000 = slots.find((s) => s.timeKolkata === '10:00');
    expect(slot1000?.available).toBe(true);
    expect(slot1000?.reasonIfUnavailable).toBeUndefined();
  });

  it('filterAvailableSlots returns only available slots', () => {
    const bookedStart = kolkataToUtc('2026-11-10', '09:00');
    const bookedEnd = addMinutes(bookedStart, 30);

    const slots = generateDoctorSlots({
      ...defaultDoctor,
      existingBookings: [{ slotStart: bookedStart, slotEnd: bookedEnd, status: 'CONFIRMED' }],
      referenceNow: earlyMorningRefNow,
    });

    const available = filterAvailableSlots(slots);
    expect(available.length).toBe(3);
    expect(available.map((s) => s.timeKolkata)).toEqual(['09:30', '10:00', '10:30']);
  });

  it('detects interval overlap accurately', () => {
    const t0 = new Date('2026-11-10T09:00:00Z');
    const t1 = new Date('2026-11-10T09:30:00Z');
    const t2 = new Date('2026-11-10T10:00:00Z');

    // Exactly adjacent intervals do NOT overlap
    expect(intervalsOverlap(t0, t1, t1, t2)).toBe(false);
    // Identical intervals overlap
    expect(intervalsOverlap(t0, t1, t0, t1)).toBe(true);
    // Sub-interval overlaps
    const tMid = new Date('2026-11-10T09:15:00Z');
    expect(intervalsOverlap(t0, t1, tMid, t2)).toBe(true);
  });
});
