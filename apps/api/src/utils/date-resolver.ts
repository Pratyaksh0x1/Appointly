/**
 * Deterministic Relative Date & Time Resolver
 * Resolves Hinglish, Hindi, and English relative dates (kal, parson, shaam, subah, etc.)
 * deterministically in code using Asia/Kolkata clinic timezone.
 * Non-negotiable: Never let the LLM calculate or invent dates.
 */

import { formatKolkata, kolkataToUtc } from './timezone.js';

export interface ResolvedDateTimePreference {
  dateStr: string; // "YYYY-MM-DD"
  dayOfWeek: string; // "Monday", "Tuesday", etc.
  relativeDayMatch:
    | 'today'
    | 'tomorrow'
    | 'day_after_tomorrow'
    | 'three_days_later'
    | 'weekday'
    | 'iso_date'
    | 'default_tomorrow';
  timePreference?: 'morning' | 'afternoon' | 'evening' | 'night' | 'specific_time';
  preferredTimeStr?: string; // "HH:mm" e.g. "17:00", "10:30"
  timeWindow?: {
    start: string; // "09:00"
    end: string; // "13:00"
  };
  rawMatchedText?: string;
  confidence: number;
}

const HINDI_WEEKDAY_MAP: Record<string, number> = {
  // Sunday = 0
  ravivar: 0,
  ravivaar: 0,
  itwar: 0,
  itvaar: 0,
  sunday: 0,
  sun: 0,

  // Monday = 1
  somwar: 1,
  somvaar: 1,
  monday: 1,
  mon: 1,

  // Tuesday = 2
  mangalwar: 2,
  mangalvaar: 2,
  tuesday: 2,
  tue: 2,

  // Wednesday = 3
  budhwar: 3,
  budhvaar: 3,
  wednesday: 3,
  wed: 3,

  // Thursday = 4
  guruwar: 4,
  guruvaar: 4,
  veerwar: 4,
  veervaar: 4,
  brihaspatiwar: 4,
  brihaspativaar: 4,
  thursday: 4,
  thu: 4,

  // Friday = 5
  shukrawar: 5,
  shukravaar: 5,
  jumma: 5,
  friday: 5,
  fri: 5,

  // Saturday = 6
  shaniwar: 6,
  shanivaar: 6,
  saturday: 6,
  sat: 6,
};

const HINDI_NUMBER_WORDS: Record<string, number> = {
  ek: 1,
  do: 2,
  teen: 3,
  chaar: 4,
  char: 4,
  paanch: 5,
  panch: 5,
  chhe: 6,
  chheh: 6,
  che: 6,
  saat: 7,
  aath: 8,
  ath: 8,
  nau: 9,
  das: 10,
  gyarah: 11,
  baarah: 12,
  barah: 12,
};

/**
 * Resolves a date string in Asia/Kolkata timezone with day offset.
 */
function getDateStringWithOffset(
  referenceDate: Date,
  dayOffset: number
): { dateStr: string; dayOfWeek: string } {
  // Reference date in Kolkata
  const kolkataParts = formatKolkata(referenceDate);
  // Construct UTC midnight in Kolkata
  const utcRef = kolkataToUtc(kolkataParts.dateStr, '12:00');
  const targetDate = new Date(utcRef.getTime() + dayOffset * 24 * 60 * 60 * 1000);
  const targetParts = formatKolkata(targetDate);
  return {
    dateStr: targetParts.dateStr,
    dayOfWeek: targetParts.dayOfWeek,
  };
}

/**
 * Finds the next occurrence of a given weekday in Asia/Kolkata.
 */
function getNextWeekdayDate(
  referenceDate: Date,
  targetDayIndex: number
): { dateStr: string; dayOfWeek: string } {
  const currentKolkata = formatKolkata(referenceDate);
  const currentDayIndex = new Date(currentKolkata.isoUtc).getDay(); // 0 = Sun, 1 = Mon...

  let daysUntil = (targetDayIndex - currentDayIndex + 7) % 7;
  // If today is targetDayIndex, schedule next week if user says weekday
  if (daysUntil === 0) {
    daysUntil = 7;
  }
  return getDateStringWithOffset(referenceDate, daysUntil);
}

/**
 * Parses deterministic date and time preferences from Hinglish text.
 * @param input Caller input transcript
 * @param referenceNow Current system timestamp (defaults to Date.now())
 */
export function resolveDateTimePreference(
  input: string,
  referenceNow: Date = new Date()
): ResolvedDateTimePreference {
  const normalized = input.toLowerCase().trim();

  let resolvedDateStr = '';
  let resolvedDayOfWeek = '';
  let relativeMatch: ResolvedDateTimePreference['relativeDayMatch'] = 'default_tomorrow';
  let confidence = 0.5;

  // 1. Explicit ISO Date (YYYY-MM-DD)
  const isoMatch = normalized.match(/\b(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/);
  if (isoMatch) {
    resolvedDateStr = isoMatch[0];
    const parts = formatKolkata(kolkataToUtc(resolvedDateStr, '12:00'));
    resolvedDayOfWeek = parts.dayOfWeek;
    relativeMatch = 'iso_date';
    confidence = 1.0;
  }

  // 2. Hindi & English Relative Days
  if (!resolvedDateStr) {
    if (/\b(tarson|narson|3 days later)\b/.test(normalized)) {
      const res = getDateStringWithOffset(referenceNow, 3);
      resolvedDateStr = res.dateStr;
      resolvedDayOfWeek = res.dayOfWeek;
      relativeMatch = 'three_days_later';
      confidence = 0.95;
    } else if (/\b(parson|parso|day after tomorrow)\b/.test(normalized)) {
      const res = getDateStringWithOffset(referenceNow, 2);
      resolvedDateStr = res.dateStr;
      resolvedDayOfWeek = res.dayOfWeek;
      relativeMatch = 'day_after_tomorrow';
      confidence = 0.98;
    } else if (/\b(kal|tomorrow|agle din)\b/.test(normalized)) {
      const res = getDateStringWithOffset(referenceNow, 1);
      resolvedDateStr = res.dateStr;
      resolvedDayOfWeek = res.dayOfWeek;
      relativeMatch = 'tomorrow';
      confidence = 0.98;
    } else if (/\b(aaj|today|abhi)\b/.test(normalized)) {
      const res = getDateStringWithOffset(referenceNow, 0);
      resolvedDateStr = res.dateStr;
      resolvedDayOfWeek = res.dayOfWeek;
      relativeMatch = 'today';
      confidence = 0.95;
    }
  }

  // 3. Weekday detection (Somwar, Mangalwar, Monday, etc.)
  if (!resolvedDateStr) {
    for (const [name, dayIdx] of Object.entries(HINDI_WEEKDAY_MAP)) {
      const regex = new RegExp(`\\b${name}\\b`, 'i');
      if (regex.test(normalized)) {
        const res = getNextWeekdayDate(referenceNow, dayIdx);
        resolvedDateStr = res.dateStr;
        resolvedDayOfWeek = res.dayOfWeek;
        relativeMatch = 'weekday';
        confidence = 0.95;
        break;
      }
    }
  }

  // 4. Default: If no date specified, default to Tomorrow (Standard clinic protocol)
  if (!resolvedDateStr) {
    const res = getDateStringWithOffset(referenceNow, 1);
    resolvedDateStr = res.dateStr;
    resolvedDayOfWeek = res.dayOfWeek;
    relativeMatch = 'default_tomorrow';
    confidence = 0.5;
  }

  // ==========================================
  // TIME OF DAY & EXPLICIT CLOCK EXTRACTION
  // ==========================================

  let timePreference: ResolvedDateTimePreference['timePreference'] = undefined;
  let preferredTimeStr: string | undefined = undefined;
  let timeWindow: { start: string; end: string } | undefined = undefined;

  // Check specific clock time: e.g. "5:30 pm", "17:00", "5 baje", "shaam ke 6 baje", "sadhe paanch baje"
  const clockDigitsMatch = normalized.match(
    /\b([01]?\d|2[0-3])(?::([0-5]\d))?\s*(am|pm)?\s*(baje)?\b/i
  );
  let parsedHour: number | null = null;
  let parsedMinute: number = 0;

  // Check word numbers: "paanch baje", "saat baje", etc.
  for (const [word, num] of Object.entries(HINDI_NUMBER_WORDS)) {
    const wordPattern = new RegExp(`\\b(sadhe\\s+)?${word}\\s*baje\\b`, 'i');
    const wordMatch = normalized.match(wordPattern);
    if (wordMatch) {
      parsedHour = num;
      if (wordMatch[1]) {
        parsedMinute = 30; // "sadhe paanch"
      }
      break;
    }
  }

  // Check "dedh baje" (1:30) or "dhai baje" (2:30)
  if (/\bdedh\s*baje\b/i.test(normalized)) {
    parsedHour = 1;
    parsedMinute = 30;
  } else if (/\bdhai\s*baje\b/i.test(normalized)) {
    parsedHour = 2;
    parsedMinute = 30;
  }

  if (clockDigitsMatch && clockDigitsMatch[1] && parsedHour === null) {
    const hour = parseInt(clockDigitsMatch[1], 10);
    const minute = clockDigitsMatch[2] ? parseInt(clockDigitsMatch[2], 10) : 0;
    const meridian = clockDigitsMatch[3]?.toLowerCase();
    const hasBaje = !!clockDigitsMatch[4];

    // Only accept if meridian or 'baje' is present, or if format was explicitly HH:MM
    if (meridian || hasBaje || clockDigitsMatch[2]) {
      parsedHour = hour;
      parsedMinute = minute;

      if (meridian === 'pm' && parsedHour < 12) {
        parsedHour += 12;
      } else if (meridian === 'am' && parsedHour === 12) {
        parsedHour = 0;
      }
    }
  }

  // Disambiguate hour with part-of-day context
  const isEveningContext = /\b(shaam|sham|evening|raat|sanjha|pm)\b/i.test(normalized);
  const isMorningContext = /\b(subah|subha|saverey|morning|pratah|am)\b/i.test(normalized);
  const isAfternoonContext = /\b(dopahar|dopehar|afternoon)\b/i.test(normalized);

  if (parsedHour !== null) {
    if (isEveningContext && parsedHour < 12) {
      parsedHour += 12; // 5 -> 17:00
    } else if (!isEveningContext && !isMorningContext && !isAfternoonContext) {
      // Natural clinic hours heuristic: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
      // 1 to 4 -> afternoon (13 to 16)
      // 5 to 9 -> evening (17 to 21)
      // 10, 11 -> morning (10, 11)
      if (parsedHour >= 1 && parsedHour <= 4) {
        parsedHour += 12;
      } else if (parsedHour >= 5 && parsedHour <= 9) {
        parsedHour += 12;
      }
    }

    const pad = (n: number) => n.toString().padStart(2, '0');
    preferredTimeStr = `${pad(parsedHour)}:${pad(parsedMinute)}`;
    timePreference = 'specific_time';
    confidence = Math.max(confidence, 0.95);
  } else {
    // Broad time windows
    if (isMorningContext) {
      timePreference = 'morning';
      timeWindow = { start: '09:00', end: '13:00' };
    } else if (isAfternoonContext) {
      timePreference = 'afternoon';
      timeWindow = { start: '13:00', end: '17:00' };
    } else if (isEveningContext) {
      timePreference = 'evening';
      timeWindow = { start: '17:00', end: '21:00' };
    } else if (/\b(raat|night)\b/i.test(normalized)) {
      timePreference = 'night';
      timeWindow = { start: '20:00', end: '22:00' };
    }
  }

  return {
    dateStr: resolvedDateStr,
    dayOfWeek: resolvedDayOfWeek,
    relativeDayMatch: relativeMatch,
    timePreference,
    preferredTimeStr,
    timeWindow,
    rawMatchedText: input,
    confidence,
  };
}
