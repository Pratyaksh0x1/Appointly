/**
 * Hardcoded Emergency Triage & Escalation Engine
 * Non-negotiable safety guardrail: Runs at code-level before any LLM processing.
 * Never provides medical advice or diagnosis. Immediately escalates to emergency services.
 */

import { EmergencyCheckResult } from '../types/index.js';

export const EMERGENCY_ESCALATION_HINGLISH =
  'Yeh ek medical emergency lag rahi hai! <pauses> Kripya turant nazdeeki hospital ke emergency ward jayein ' +
  'ya turant ambulance ke liye 108 dial karein. Appointly kewal routine clinic appointments book karne ke liye hai, ' +
  'emergency medical care ya diagnosis ke liye nahi. Kripya bina deri kiye emergency help lein.';

// Multi-lingual & Hinglish emergency pattern triggers
const EMERGENCY_PATTERNS: { category: string; regex: RegExp }[] = [
  {
    category: 'CHEST_PAIN_CARDIAC',
    regex: /(chest\s*pain|heart\s*attack|dil\s*ka\s*daura|seene\s*m[eai]n?\s*dard|chhati\s*m[eai]n?\s*dard|cardiac\s*arrest)/i,
  },
  {
    category: 'BREATHING_DIFFICULTY',
    regex: /(saans\s*(lene\s*m[eai]n?\s*takleef|phool\s*rahi|ruk\s*rahi)|can['’]?t\s*breathe|shortness\s*of\s*breath|suffocat(ing|ion)|asphyxia?)/i,
  },
  {
    category: 'UNCONSCIOUSNESS_COLLAPSE',
    regex: /(unconscious|behosh|faint(ed|ing)?|collapsed|chakkar\s*kha\s*kar\s*gir|coma)/i,
  },
  {
    category: 'SEVERE_BLEEDING_TRAUMA',
    regex: /(severe\s*bleeding|bahut\s*khoon\s*beh|bleeding\s*heavily|head\s*injury|accident|artery)/i,
  },
  {
    category: 'STROKE_NEUROLOGICAL',
    regex: /(stroke|paralysis|face\s*droop|speech\s*slurred|adhrang|aadha\s*shareer\s*sunn)/i,
  },
  {
    category: 'SEIZURE_CONVULSIONS',
    regex: /(seizure|fits|daura\s*pad\s*gaya|mirgi|convulsion)/i,
  },
  {
    category: 'POISONING_OVERDOSE',
    regex: /(poison|zehar|overdose|chemical\s*ingest)/i,
  },
];

/**
 * Evaluates patient input against hardcoded emergency criteria.
 * This runs synchronously at the backend code-level, cannot be overridden by the LLM.
 */
export function checkEmergency(userInput: string): EmergencyCheckResult {
  if (!userInput || typeof userInput !== 'string') {
    return {
      isEmergency: false,
      matchedKeywords: [],
      escalationMessage: '',
    };
  }

  const normalized = userInput.trim();
  const matchedKeywords: string[] = [];

  for (const { category, regex } of EMERGENCY_PATTERNS) {
    const match = normalized.match(regex);
    if (match) {
      matchedKeywords.push(`${category}:${match[0]}`);
    }
  }

  if (matchedKeywords.length > 0) {
    return {
      isEmergency: true,
      matchedKeywords,
      escalationMessage: EMERGENCY_ESCALATION_HINGLISH,
    };
  }

  return {
    isEmergency: false,
    matchedKeywords: [],
    escalationMessage: '',
  };
}
