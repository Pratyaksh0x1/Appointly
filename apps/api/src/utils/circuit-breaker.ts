/**
 * Circuit Breaker Pattern for External AI Services
 * Prevents cascading latency failures, protects credit quota,
 * and enables graceful immediate fallback to clinic receptionists.
 */

import { CircuitBreakerOpenError } from '../adapters/errors.js';
import { rootLogger } from '../logger/logger.js';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerConfig {
  serviceName: string;
  failureThreshold?: number; // e.g. 3 consecutive failures to trip
  resetTimeoutMs?: number; // e.g. 10,000ms cooldown before entering HALF_OPEN
  halfOpenMaxTrials?: number; // number of trial requests in HALF_OPEN
}

export class CircuitBreaker {
  public readonly serviceName: string;
  private state: CircuitState = 'CLOSED';
  private failureCount: number = 0;
  private successCount: number = 0;
  private lastFailureTime: number = 0;

  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenMaxTrials: number;

  constructor(config: CircuitBreakerConfig) {
    this.serviceName = config.serviceName;
    this.failureThreshold = config.failureThreshold ?? 3;
    this.resetTimeoutMs = config.resetTimeoutMs ?? 10000;
    this.halfOpenMaxTrials = config.halfOpenMaxTrials ?? 1;
  }

  public getState(): CircuitState {
    if (this.state === 'OPEN') {
      const now = Date.now();
      if (now - this.lastFailureTime >= this.resetTimeoutMs) {
        this.state = 'HALF_OPEN';
        this.successCount = 0;
        rootLogger.info(
          `[CircuitBreaker:${this.serviceName}] Transitioned from OPEN to HALF_OPEN (probing upstream)`
        );
      }
    }
    return this.state;
  }

  /**
   * Executes an async operation with circuit protection.
   */
  public async execute<T>(fn: () => Promise<T>): Promise<T> {
    const currentState = this.getState();

    if (currentState === 'OPEN') {
      const remainingCooldown = Math.max(
        0,
        this.resetTimeoutMs - (Date.now() - this.lastFailureTime)
      );
      throw new CircuitBreakerOpenError(this.serviceName, remainingCooldown);
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure(err as Error);
      throw err;
    }
  }

  public recordSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      this.successCount++;
      if (this.successCount >= this.halfOpenMaxTrials) {
        this.reset();
        rootLogger.info(
          `[CircuitBreaker:${this.serviceName}] Service recovered. Transitioned from HALF_OPEN to CLOSED`
        );
      }
    } else {
      this.failureCount = 0;
    }
  }

  public recordFailure(err: Error): void {
    this.lastFailureTime = Date.now();

    if (this.state === 'HALF_OPEN') {
      this.state = 'OPEN';
      rootLogger.warn(
        `[CircuitBreaker:${this.serviceName}] Trial request failed in HALF_OPEN. Tripping back to OPEN`,
        { error: err.message }
      );
      return;
    }

    this.failureCount++;
    rootLogger.warn(
      `[CircuitBreaker:${this.serviceName}] Failure recorded (${this.failureCount}/${this.failureThreshold})`,
      { error: err.message }
    );

    if (this.failureCount >= this.failureThreshold) {
      this.state = 'OPEN';
      rootLogger.error(
        `[CircuitBreaker:${this.serviceName}] Failure threshold reached. Tripping to OPEN for ${this.resetTimeoutMs}ms`,
        { error: err.message }
      );
    }
  }

  public reset(): void {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = 0;
  }
}
