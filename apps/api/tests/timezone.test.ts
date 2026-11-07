import { describe, it, expect } from 'vitest';
import {
  kolkataToUtc,
  formatKolkata,
  getDayOfWeekInKolkata,
  addMinutes,
  isPastSlot,
} from '../src/utils/timezone.js';

describe('Timezone Utilities (UTC <-> Asia/Kolkata)', () => {
  it('converts Asia/Kolkata date and time to accurate UTC ISO string', () => {
    // 09:30 IST is 04:00 UTC (IST is UTC + 5:30)
    const utc = kolkataToUtc('2026-11-10', '09:30');
    expect(utc.toISOString()).toBe('2026-11-10T04:00:00.000Z');

    // 17:00 IST is 11:30 UTC
    const eveningUtc = kolkataToUtc('2026-11-10', '17:00');
    expect(eveningUtc.toISOString()).toBe('2026-11-10T11:30:00.000Z');

    // 02:00 IST is 20:30 UTC of previous day
    const earlyMorningUtc = kolkataToUtc('2026-11-10', '02:00');
    expect(earlyMorningUtc.toISOString()).toBe('2026-11-09T20:30:00.000Z');
  });

  it('formats UTC Date back into Asia/Kolkata values', () => {
    const utcDate = new Date('2026-11-10T04:00:00.000Z');
    const formatted = formatKolkata(utcDate);

    expect(formatted.dateStr).toBe('2026-11-10');
    expect(formatted.timeStr).toBe('09:30');
    expect(formatted.displayTime).toBe('09:30 AM');
    expect(formatted.fullDisplay).toContain('10 Nov 2026, 09:30 AM IST');
    expect(formatted.dayOfWeek).toBe('Tuesday');
  });

  it('correctly calculates day of week in Asia/Kolkata', () => {
    // 2026-11-10 is a Tuesday
    expect(getDayOfWeekInKolkata('2026-11-10')).toBe('Tuesday');
    // 2026-11-15 is a Sunday
    expect(getDayOfWeekInKolkata('2026-11-15')).toBe('Sunday');
  });

  it('adds minutes correctly across hour and date boundaries', () => {
    const start = new Date('2026-11-10T04:00:00.000Z');
    const end = addMinutes(start, 30);
    expect(end.toISOString()).toBe('2026-11-10T04:30:00.000Z');

    const endLong = addMinutes(start, 120);
    expect(endLong.toISOString()).toBe('2026-11-10T06:00:00.000Z');
  });

  it('correctly detects past slots against reference now', () => {
    const refNow = new Date('2026-11-10T05:00:00.000Z');
    const pastSlot = new Date('2026-11-10T04:30:00.000Z');
    const futureSlot = new Date('2026-11-10T05:30:00.000Z');

    expect(isPastSlot(pastSlot, refNow)).toBe(true);
    expect(isPastSlot(futureSlot, refNow)).toBe(false);
  });
});
