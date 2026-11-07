/**
 * Resilience, Timeout, Exponential Backoff & Graceful Fallback Engine
 * Enforces Rule 5: Every external call has a timeout, bounded retries with backoff,
 * and graceful fallback (save a callback_request and apologise in Hinglish).
 */

import { rootLogger } from '../logger/logger.js';
import { getDatabaseClient } from '../db/index.js';

export const FALLBACK_HINGLISH_APOLOGY =
  'Maaf kijiye, hamare server me thodi takneeki samasya aa rahi hai. <pauses> ' +
  'Maine aapka number clinic desk par note kar diya hai, hamari reception team aapse jald hi sampark karegi.';

export interface RetryOptions<T> {
  maxRetries?: number;
  timeoutMs?: number;
  backoffBaseMs?: number;
  callId: string;
  patientPhone?: string;
  operationName: string;
  fallbackValue?: T;
  onFallback?: (err: Error) => Promise<T> | T;
}

export class ExternalServiceError extends Error {
  public statusCode?: number;
  public isRetryable: boolean;

  constructor(message: string, statusCode?: number, isRetryable = true) {
    super(message);
    this.name = 'ExternalServiceError';
    this.statusCode = statusCode;
    this.isRetryable = isRetryable;
  }
}

/**
 * Executes an async operation with bounded retries, exponential backoff,
 * timeout enforcement, and database callback creation upon failure.
 */
export async function withRetryAndFallback<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: RetryOptions<T>
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const timeoutMs = options.timeoutMs ?? 8000;
  const backoffBaseMs = options.backoffBaseMs ?? 500;
  const { callId, patientPhone, operationName } = options;

  let lastError: Error = new Error(`Operation ${operationName} failed`);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      rootLogger.debug(`Executing external call: ${operationName}`, {
        callId,
        attempt,
        maxRetries,
        timeoutMs,
      });

      const result = await operation(controller.signal);
      clearTimeout(timer);
      return result;
    } catch (err: unknown) {
      clearTimeout(timer);
      const isAbort = (err as { name?: string }).name === 'AbortError' || controller.signal.aborted;
      const errorObj = isAbort
        ? new ExternalServiceError(`Timeout after ${timeoutMs}ms on ${operationName}`, 408, true)
        : (err instanceof Error ? err : new Error(String(err)));

      lastError = errorObj;

      // Check if error is non-retryable (e.g. 400 Bad Request, 401 Unauthorized, 403 Forbidden)
      const statusCode = (errorObj as { statusCode?: number }).statusCode;
      const isRetryable =
        (errorObj as { isRetryable?: boolean }).isRetryable ??
        (statusCode ? statusCode >= 500 || statusCode === 429 || statusCode === 408 : true);

      rootLogger.warn(`External call failure: ${operationName}`, {
        callId,
        attempt,
        maxRetries,
        isRetryable,
        error: errorObj.message,
      });

      if (!isRetryable || attempt === maxRetries) {
        break;
      }

      // Exponential backoff with jitter: backoffBaseMs * 2^(attempt-1) + random jitter
      const jitter = Math.floor(Math.random() * 100);
      const delay = backoffBaseMs * Math.pow(2, attempt - 1) + jitter;
      await new Promise((res) => setTimeout(res, delay));
    }
  }

  // All retries failed - execute graceful fallback protocol
  rootLogger.error(`All retries exhausted for ${operationName}. Initiating fallback.`, {
    callId,
    patientPhone: patientPhone ? 'PRESENT' : 'NOT_PROVIDED',
    finalError: lastError.message,
  });

  if (patientPhone) {
    try {
      const db = getDatabaseClient();
      await db.saveCallbackRequest(
        callId,
        patientPhone,
        `External failure on ${operationName}: ${lastError.message}`
      );
      rootLogger.info(`Gracefully persisted callback_request to DB for call ${callId}`, { callId });
    } catch (dbErr) {
      rootLogger.error(`Failed to persist callback_request during fallback:`, { callId, error: String(dbErr) });
    }
  }

  if (options.onFallback) {
    return await options.onFallback(lastError);
  }

  if (options.fallbackValue !== undefined) {
    return options.fallbackValue;
  }

  throw lastError;
}
