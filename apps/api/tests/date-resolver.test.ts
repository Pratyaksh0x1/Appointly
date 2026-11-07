import { describe, it, expect } from 'vitest';
import { resolveDateTimePreference } from '../src/utils/date-resolver.js';
import { kolkataToUtc } from '../src/utils/timezone.js';

describe('Deterministic Relative Date & Time Resolver', () => {
  // Fixed reference time: Tuesday, 10 Nov 2026, 14:00 IST
  const referenceTuesday = kolkataToUtc('2026-11-10', '14:00');

  it('resolves "kal" (tomorrow) deterministically to next day', () => {
    const res = resolveDateTimePreference('Mujhe kal Dr. Sharma se milna hai', referenceTuesday);
    expect(res.dateStr).toBe('2026-11-11');
    expect(res.dayOfWeek).toBe('Wednesday');
    expect(res.relativeDayMatch).toBe('tomorrow');
  });

  it('resolves "parson" (day after tomorrow) deterministically', () => {
    const res = resolveDateTimePreference(
      'Parson ki koi appointment milegi kya?',
      referenceTuesday
    );
    expect(res.dateStr).toBe('2026-11-12');
    expect(res.dayOfWeek).toBe('Thursday');
    expect(res.relativeDayMatch).toBe('day_after_tomorrow');
  });

  it('resolves "tarson" (3 days later) deterministically', () => {
    const res = resolveDateTimePreference('Tarson aa sakte hain', referenceTuesday);
    expect(res.dateStr).toBe('2026-11-13');
    expect(res.dayOfWeek).toBe('Friday');
    expect(res.relativeDayMatch).toBe('three_days_later');
  });

  it('resolves "aaj" (today) deterministically', () => {
    const res = resolveDateTimePreference('Kya aaj shaam ka slot mil sakta hai?', referenceTuesday);
    expect(res.dateStr).toBe('2026-11-10');
    expect(res.dayOfWeek).toBe('Tuesday');
    expect(res.relativeDayMatch).toBe('today');
    expect(res.timePreference).toBe('evening');
  });

  it('resolves Hindi weekday "Somwar" (next Monday)', () => {
    const res = resolveDateTimePreference('Aane wale somwar ko book kar do', referenceTuesday);
    expect(res.dateStr).toBe('2026-11-16');
    expect(res.dayOfWeek).toBe('Monday');
    expect(res.relativeDayMatch).toBe('weekday');
  });

  it('resolves Hindi weekday "Shukrawar" (Friday)', () => {
    const res = resolveDateTimePreference(
      'Mujhe shukrawar ko checkup karana hai',
      referenceTuesday
    );
    expect(res.dateStr).toBe('2026-11-13');
    expect(res.dayOfWeek).toBe('Friday');
    expect(res.relativeDayMatch).toBe('weekday');
  });

  it('resolves explicit clock times like "5 baje" in evening context', () => {
    const res = resolveDateTimePreference('Kal shaam ko 5 baje ka time chahiye', referenceTuesday);
    expect(res.dateStr).toBe('2026-11-11');
    expect(res.preferredTimeStr).toBe('17:00');
    expect(res.timePreference).toBe('specific_time');
  });

  it('resolves Hindi number words like "sadhe paanch baje" (5:30 PM)', () => {
    const res = resolveDateTimePreference('Kal sadhe paanch baje chalega', referenceTuesday);
    expect(res.dateStr).toBe('2026-11-11');
    expect(res.preferredTimeStr).toBe('17:30');
    expect(res.timePreference).toBe('specific_time');
  });

  it('resolves morning context "subah 10 baje"', () => {
    const res = resolveDateTimePreference('Subah 10 baje appointment chahiye', referenceTuesday);
    expect(res.preferredTimeStr).toBe('10:00');
    expect(res.timePreference).toBe('specific_time');
  });

  it('resolves explicit ISO dates "2026-12-05"', () => {
    const res = resolveDateTimePreference('Date 2026-12-05 ko book karo', referenceTuesday);
    expect(res.dateStr).toBe('2026-12-05');
    expect(res.relativeDayMatch).toBe('iso_date');
  });
});
