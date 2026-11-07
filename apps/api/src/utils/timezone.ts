/**
 * Appointly Timezone Utilities
 * Standardizes time storage in UTC and presentation in Asia/Kolkata (IST: UTC+05:30).
 * IST does not observe Daylight Saving Time.
 */

export const KOLKATA_TIMEZONE = 'Asia/Kolkata';
export const IST_OFFSET_MINUTES = 330; // 5 hours 30 minutes

export interface KolkataFormattedTime {
  dateStr: string; // "YYYY-MM-DD" in Asia/Kolkata
  timeStr: string; // "HH:mm" in 24-hour format in Asia/Kolkata
  displayTime: string; // e.g. "09:30 AM"
  fullDisplay: string; // e.g. "10 Nov 2026, 09:30 AM IST"
  dayOfWeek: string; // e.g. "Monday", "Tuesday", etc.
  isoUtc: string; // ISO 8601 UTC string
}

/**
 * Converts a date (YYYY-MM-DD) and 24-hr time (HH:mm) in Asia/Kolkata to a UTC Date object.
 * Example: ("2026-11-10", "09:30") -> 2026-11-10T04:00:00.000Z
 */
export function kolkataToUtc(dateStr: string, timeStr: string): Date {
  const [yearStr, monthStr, dayStr] = dateStr.trim().split('-');
  const [hourStr, minStr] = timeStr.trim().split(':');

  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);
  const day = parseInt(dayStr, 10);
  const hour = parseInt(hourStr, 10);
  const min = parseInt(minStr, 10);

  if (
    isNaN(year) ||
    isNaN(month) ||
    isNaN(day) ||
    isNaN(hour) ||
    isNaN(min) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    min < 0 ||
    min > 59
  ) {
    throw new Error(`Invalid date/time for Kolkata: "${dateStr} ${timeStr}"`);
  }

  // IST is fixed at UTC + 05:30. Construct standard ISO string with offset:
  const pad = (n: number) => n.toString().padStart(2, '0');
  const isoWithOffset = `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(min)}:00+05:30`;
  const d = new Date(isoWithOffset);

  if (isNaN(d.getTime())) {
    throw new Error(`Failed to parse datetime "${isoWithOffset}"`);
  }

  return d;
}

/**
 * Formats a UTC Date into Asia/Kolkata date, time, and readable labels.
 */
export function formatKolkata(dateInput: Date | string | number): KolkataFormattedTime {
  if (!dateInput) {
    throw new Error(`Invalid Date passed to formatKolkata: ${dateInput}`);
  }
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);

  if (isNaN(d.getTime())) {
    throw new Error(`Invalid Date passed to formatKolkata: ${dateInput}`);
  }

  // Format parts using Intl.DateTimeFormat in Asia/Kolkata
  const formatter = new Intl.DateTimeFormat('en-IN', {
    timeZone: KOLKATA_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'long',
  });

  const parts = formatter.formatToParts(d);
  let year = '';
  let month = '';
  let day = '';
  let hour = '';
  let minute = '';
  let weekday = '';

  for (const p of parts) {
    if (p.type === 'year') year = p.value;
    else if (p.type === 'month') month = p.value;
    else if (p.type === 'day') day = p.value;
    else if (p.type === 'hour') hour = p.value === '24' ? '00' : p.value;
    else if (p.type === 'minute') minute = p.value;
    else if (p.type === 'weekday') weekday = p.value;
  }

  const dateStr = `${year}-${month}-${day}`;
  const timeStr = `${hour}:${minute}`;

  // 12-hour display formatting (e.g. 09:30 AM)
  const hourNum = parseInt(hour, 10);
  const ampm = hourNum >= 12 ? 'PM' : 'AM';
  const displayHour = hourNum % 12 === 0 ? 12 : hourNum % 12;
  const displayTime = `${displayHour.toString().padStart(2, '0')}:${minute} ${ampm}`;

  // Month short name
  const monthNames = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const monthIdx = parseInt(month, 10) - 1;
  const monthName = monthNames[monthIdx] || month;
  const fullDisplay = `${day} ${monthName} ${year}, ${displayTime} IST`;

  return {
    dateStr,
    timeStr,
    displayTime,
    fullDisplay,
    dayOfWeek: weekday,
    isoUtc: d.toISOString(),
  };
}

/**
 * Returns the weekday in Asia/Kolkata for a given UTC date or YYYY-MM-DD string.
 */
export function getDayOfWeekInKolkata(dateInput: Date | string): string {
  if (typeof dateInput === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
    return formatKolkata(kolkataToUtc(dateInput, '12:00')).dayOfWeek;
  }
  return formatKolkata(dateInput).dayOfWeek;
}

/**
 * Adds minutes to a Date, returning a new Date object.
 */
export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

/**
 * Determines whether a slot start time has already passed relative to a reference UTC now.
 */
export function isPastSlot(slotStartUtc: Date, referenceNow: Date = new Date()): boolean {
  return slotStartUtc.getTime() <= referenceNow.getTime();
}
