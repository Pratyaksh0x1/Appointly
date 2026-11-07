/**
 * Structured JSON Logger for Appointly
 * Enforces request_id/call_id and redacts PII and secrets before writing to stdout/stderr.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  callId?: string;
  requestId?: string;
  [key: string]: unknown;
}

const SENSITIVE_KEY_PATTERNS = [
  /key/i,
  /token/i,
  /secret/i,
  /password/i,
  /auth/i,
  /authorization/i,
  /credential/i,
];

/**
 * Mask Indian phone numbers: +91 9876543210 -> +91 ******3210
 */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length >= 10) {
    const last4 = digits.slice(-4);
    return `+91 ******${last4}`;
  }
  return '******';
}

/**
 * Mask patient name: "Ramesh Sharma" -> "R***** S*****"
 */
export function maskName(name: string): string {
  if (!name) return 'Anonymous';
  return name
    .split(' ')
    .map((part) => (part.length > 1 ? `${part[0]}${'*'.repeat(Math.min(part.length - 1, 5))}` : part))
    .join(' ');
}

/**
 * Recursively deep sanitize object, redacting secrets and masking PII
 */
export function sanitizeData(data: unknown): unknown {
  if (data === null || data === undefined) return data;
  if (typeof data === 'string') {
    // Redact raw phone patterns without consuming preceding space
    return data.replace(/(?:\+91[\s-]?)?[6-9]\d{9}\b/g, (match) => maskPhone(match));
  }
  if (typeof data !== 'object') return data;
  if (Array.isArray(data)) return data.map(sanitizeData);

  const cleanObj: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(data as Record<string, unknown>)) {
    // Check if key is a secret
    if (SENSITIVE_KEY_PATTERNS.some((pat) => pat.test(key))) {
      cleanObj[key] = '[REDACTED]';
    } else if (/phone/i.test(key) && typeof val === 'string') {
      cleanObj[key] = maskPhone(val);
    } else if (/patientName|patient_name|userName/i.test(key) && typeof val === 'string') {
      cleanObj[key] = maskName(val);
    } else {
      cleanObj[key] = sanitizeData(val);
    }
  }
  return cleanObj;
}

export class Logger {
  private levelOrder: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
  };

  private currentLevel: LogLevel = 'info';
  private defaultContext: LogContext = {};

  constructor(level: LogLevel = 'info', context: LogContext = {}) {
    this.currentLevel = level;
    this.defaultContext = context;
  }

  public withContext(context: LogContext): Logger {
    return new Logger(this.currentLevel, { ...this.defaultContext, ...context });
  }

  private log(level: LogLevel, message: string, data?: unknown) {
    if (this.levelOrder[level] < this.levelOrder[this.currentLevel]) {
      return;
    }

    const payload = {
      timestamp: new Date().toISOString(),
      level: level.toUpperCase(),
      message,
      callId: this.defaultContext.callId || undefined,
      requestId: this.defaultContext.requestId || undefined,
      context: Object.keys(this.defaultContext).length > 0 ? sanitizeData(this.defaultContext) : undefined,
      data: data ? sanitizeData(data) : undefined,
    };

    const serialized = JSON.stringify(payload);
    if (level === 'error') {
      process.stderr.write(serialized + '\n');
    } else {
      process.stdout.write(serialized + '\n');
    }
  }

  public debug(message: string, data?: unknown) {
    this.log('debug', message, data);
  }

  public info(message: string, data?: unknown) {
    this.log('info', message, data);
  }

  public warn(message: string, data?: unknown) {
    this.log('warn', message, data);
  }

  public error(message: string, data?: unknown) {
    this.log('error', message, data);
  }
}

export const rootLogger = new Logger('info');
