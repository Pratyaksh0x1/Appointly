/**
 * Appointly Adapter Typed Domain Errors
 * Structured hierarchy for explicit error classification, retryability, and graceful degradation.
 */

export class AppointlyAdapterError extends Error {
  public readonly isRetryable: boolean;
  public readonly service: string;
  public readonly statusCode?: number;

  constructor(
    message: string,
    options: {
      service: string;
      isRetryable?: boolean;
      statusCode?: number;
      cause?: unknown;
    }
  ) {
    super(message);
    this.name = this.constructor.name;
    this.service = options.service;
    this.isRetryable = options.isRetryable ?? false;
    this.statusCode = options.statusCode;
    if (options.cause) {
      this.cause = options.cause;
    }
  }
}

export class GnaniTimeoutError extends AppointlyAdapterError {
  constructor(service: string, timeoutMs: number, callId?: string) {
    super(
      `[${service}] Request timed out after ${timeoutMs}ms${callId ? ` for call ${callId}` : ''}`,
      { service, isRetryable: true }
    );
  }
}

export class GnaniAuthError extends AppointlyAdapterError {
  constructor(service: string, message: string = 'Authentication failed. Check API key.') {
    super(`[${service}] ${message}`, { service, isRetryable: false, statusCode: 401 });
  }
}

export class GnaniRateLimitError extends AppointlyAdapterError {
  public readonly retryAfterSeconds?: number;

  constructor(service: string, retryAfterSeconds?: number) {
    super(`[${service}] Rate limit exceeded. Too many requests.`, {
      service,
      isRetryable: true,
      statusCode: 429,
    });
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class GnaniServerError extends AppointlyAdapterError {
  constructor(service: string, statusCode: number, message: string) {
    super(`[${service}] Upstream server error (${statusCode}): ${message}`, {
      service,
      isRetryable: statusCode >= 500 && statusCode < 600,
      statusCode,
    });
  }
}

export class CircuitBreakerOpenError extends AppointlyAdapterError {
  public readonly resetTimeMs: number;

  constructor(service: string, resetTimeMs: number) {
    super(
      `[${service}] Circuit breaker is OPEN. Upstream service is failing; failing fast for ${resetTimeMs}ms.`,
      { service, isRetryable: false }
    );
    this.resetTimeMs = resetTimeMs;
  }
}

export class CreditLimitExceededError extends AppointlyAdapterError {
  public readonly limitType: 'PER_CALL' | 'PER_DAY' | 'TOTAL_BUDGET';
  public readonly current: number;
  public readonly max: number;

  constructor(
    limitType: 'PER_CALL' | 'PER_DAY' | 'TOTAL_BUDGET',
    current: number,
    max: number,
    callId?: string
  ) {
    super(
      `Credit limit exceeded [${limitType}]: current usage ${current.toFixed(2)} exceeds cap ${max.toFixed(2)}${callId ? ` for call ${callId}` : ''}`,
      { service: 'CostMeter', isRetryable: false }
    );
    this.limitType = limitType;
    this.current = current;
    this.max = max;
  }
}

export class InvalidToolCallError extends AppointlyAdapterError {
  constructor(toolName: string, validationError: string) {
    super(`Invalid tool call [${toolName}]: ${validationError}`, {
      service: 'EvonLLM',
      isRetryable: false,
    });
  }
}
