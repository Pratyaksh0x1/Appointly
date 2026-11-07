/**
 * Prompt-Injection & Untrusted Input Guardrail
 * Defends against adversarial attempts to manipulate the voice agent,
 * bypass state machine rules, leak system instructions, or inject SQL/malicious tool arguments.
 */

export interface InjectionCheckResult {
  isSuspicious: boolean;
  threatType?: string;
  sanitizedInput: string;
}

const INJECTION_PATTERNS: { type: string; regex: RegExp }[] = [
  {
    type: 'INSTRUCTION_OVERRIDE',
    regex:
      /(ignore\s*(all)?\s*(previous|prior|above)\s*instructions|disregard\s*(all)?\s*(system|rules)|forget\s*your\s*role|you\s*are\s*now\s*a)/i,
  },
  {
    type: 'SYSTEM_PROMPT_LEAK',
    regex:
      /(repeat\s*(the)?\s*(above|system)\s*(prompt|instructions)|show\s*me\s*your\s*(hidden\s*)?instructions|reveal\s*system\s*prompt|print\s*system\s*prompt)/i,
  },
  {
    type: 'SECURITY_CREDENTIAL_PROBE',
    regex:
      /(api\s*key|database\s*password|secret\s*key|connection\s*string|token|env\s*variables|bearer\s*token)/i,
  },
  {
    type: 'JAILBREAK_ROLEPLAY',
    regex:
      /(dan\s*mode|developer\s*mode|unfiltered\s*mode|jailbreak|pretend\s*you\s*have\s*no\s*rules|act\s*as\s*an\s*unrestricted)/i,
  },
  {
    type: 'SQL_INJECTION_PROBE',
    regex:
      /(\b(DROP\s+TABLE|SELECT\s+\*\s+FROM|UNION\s+SELECT|ALTER\s+TABLE|INSERT\s+INTO|DELETE\s+FROM)\b|--|\/\*|\*\/)/i,
  },
];

/**
 * Validates untrusted caller speech.
 * Flags malicious input and sanitizes text by stripping out control characters.
 */
export function checkPromptInjection(rawInput: string): InjectionCheckResult {
  if (!rawInput || typeof rawInput !== 'string') {
    return { isSuspicious: false, sanitizedInput: '' };
  }

  // Strip non-printable and suspicious control characters
  const sanitizedInput = rawInput.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();

  for (const { type, regex } of INJECTION_PATTERNS) {
    if (regex.test(sanitizedInput)) {
      return {
        isSuspicious: true,
        threatType: type,
        sanitizedInput,
      };
    }
  }

  return {
    isSuspicious: false,
    sanitizedInput,
  };
}
