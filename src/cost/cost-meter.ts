/**
 * Cost Meter & Credit Budget Limiter
 * Enforces per-call and daily credit caps against the 5,000 API credit budget.
 * Tracks usage across Gnani Prisma (STT), Gnani Timbre (TTS), and Evon 30B (LLM).
 */

import { AiServiceType, CreditUsageRecord } from '../types/index.js';
import { rootLogger } from '../logger/logger.js';

export class CreditLimitExceededError extends Error {
  public reason: 'PER_CALL_EXCEEDED' | 'DAILY_EXCEEDED' | 'TOTAL_BUDGET_EXCEEDED';

  constructor(reason: 'PER_CALL_EXCEEDED' | 'DAILY_EXCEEDED' | 'TOTAL_BUDGET_EXCEEDED', message: string) {
    super(message);
    this.name = 'CreditLimitExceededError';
    this.reason = reason;
  }
}

export interface CostMeterConfig {
  totalBudget: number; // e.g. 5000
  perCallLimit: number; // e.g. 50
  dailyLimit: number; // e.g. 2000
}

export class CostMeter {
  private totalBudget: number;
  private perCallLimit: number;
  private dailyLimit: number;

  private totalSpent = 0;
  private dailySpent = 0;
  private lastResetDate: string;
  private callSpendMap: Map<string, number> = new Map();
  private auditRecords: CreditUsageRecord[] = [];

  constructor(config: CostMeterConfig = { totalBudget: 5000, perCallLimit: 50, dailyLimit: 2000 }) {
    this.totalBudget = config.totalBudget;
    this.perCallLimit = config.perCallLimit;
    this.dailyLimit = config.dailyLimit;
    this.lastResetDate = new Date().toISOString().slice(0, 10);
  }

  private checkDailyReset() {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.lastResetDate) {
      this.dailySpent = 0;
      this.lastResetDate = today;
    }
  }

  /**
   * Estimate credit burn rate:
   * - PRISMA_STT: 0.1 credit per second (1 credit / 10s)
   * - TIMBRE_TTS: 0.005 credit per character (0.5 credit / 100 chars)
   * - EVON_LLM: 0.001 credit per token (1 credit / 1k tokens)
   */
  public estimateCredits(service: AiServiceType, units: number): number {
    switch (service) {
      case 'PRISMA_STT':
        return Math.max(0.05, Math.round(units * 0.1 * 100) / 100);
      case 'TIMBRE_TTS':
        return Math.max(0.05, Math.round(units * 0.005 * 100) / 100);
      case 'EVON_LLM':
        return Math.max(0.05, Math.round(units * 0.001 * 100) / 100);
      default:
        return 0.1;
    }
  }

  /**
   * Pre-flight credit check before triggering any external API call
   */
  public checkCanSpend(callId: string, estimatedCredits: number): void {
    this.checkDailyReset();

    const currentCallSpend = this.callSpendMap.get(callId) || 0;

    if (currentCallSpend + estimatedCredits > this.perCallLimit) {
      throw new CreditLimitExceededError(
        'PER_CALL_EXCEEDED',
        `Per-call credit limit of ${this.perCallLimit} exceeded. Current: ${currentCallSpend.toFixed(2)}, Requested: ${estimatedCredits.toFixed(2)}`
      );
    }

    if (this.dailySpent + estimatedCredits > this.dailyLimit) {
      throw new CreditLimitExceededError(
        'DAILY_EXCEEDED',
        `Daily credit limit of ${this.dailyLimit} exceeded. Today's usage: ${this.dailySpent.toFixed(2)}, Requested: ${estimatedCredits.toFixed(2)}`
      );
    }

    if (this.totalSpent + estimatedCredits > this.totalBudget) {
      throw new CreditLimitExceededError(
        'TOTAL_BUDGET_EXCEEDED',
        `Total credit budget of ${this.totalBudget} exhausted! Spent: ${this.totalSpent.toFixed(2)}, Requested: ${estimatedCredits.toFixed(2)}`
      );
    }
  }

  /**
   * Records completed spend in memory and audit log
   */
  public recordSpend(callId: string, service: AiServiceType, unitsConsumed: number, isMock = false): CreditUsageRecord {
    const credits = isMock ? 0 : this.estimateCredits(service, unitsConsumed);

    this.checkDailyReset();
    this.totalSpent += credits;
    this.dailySpent += credits;

    const currentCallSpend = this.callSpendMap.get(callId) || 0;
    this.callSpendMap.set(callId, currentCallSpend + credits);

    const record: CreditUsageRecord = {
      id: `usage_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      callId,
      service,
      unitsConsumed,
      estimatedCredits: credits,
      timestamp: new Date(),
    };

    this.auditRecords.push(record);

    rootLogger.info('Cost Meter recorded credit usage', {
      callId,
      service,
      unitsConsumed,
      creditsBurned: credits,
      callTotal: (currentCallSpend + credits).toFixed(2),
      remainingBudget: (this.totalBudget - this.totalSpent).toFixed(2),
      isMock,
    });

    return record;
  }

  public getSummary() {
    this.checkDailyReset();
    return {
      totalBudget: this.totalBudget,
      totalSpent: Math.round(this.totalSpent * 100) / 100,
      remainingCredits: Math.max(0, Math.round((this.totalBudget - this.totalSpent) * 100) / 100),
      dailyLimit: this.dailyLimit,
      dailySpent: Math.round(this.dailySpent * 100) / 100,
      perCallLimit: this.perCallLimit,
      totalTransactions: this.auditRecords.length,
    };
  }

  public resetForTesting(): void {
    this.totalSpent = 0;
    this.dailySpent = 0;
    this.callSpendMap.clear();
    this.auditRecords = [];
  }
}

export const globalCostMeter = new CostMeter();
