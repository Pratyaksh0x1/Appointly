/**
 * Cost Meter & Credit Budget Limiter
 * Enforces per-call and daily credit caps against the 5,000 API credit budget.
 * Configurable credit rates for Prisma (STT), Timbre (TTS), and Evon 30B (LLM).
 * Strictly non-negotiable: Fail-fast before external invocation.
 */

import { AiServiceType, CreditUsageRecord } from '../types/index.js';
import { rootLogger } from '../logger/logger.js';
import { CreditLimitExceededError } from '../adapters/errors.js';

export { CreditLimitExceededError };

export interface CostMeterRates {
  sttRatePerSec: number; // default: 0.10 credits / second
  ttsRatePerChar: number; // default: 0.005 credits / char (1 credit per 200 chars)
  llmRatePerToken: number; // default: 0.001 credits / token
}

export interface CostMeterConfig {
  totalBudget?: number; // default: 5000
  perCallLimit?: number; // default: 50
  dailyLimit?: number; // default: 2000
  rates?: Partial<CostMeterRates>;
}

export class CostMeter {
  private totalBudget: number;
  private perCallLimit: number;
  private dailyLimit: number;
  private rates: CostMeterRates;

  private totalSpent = 0;
  private dailySpent = 0;
  private lastResetDate: string;
  private callSpendMap: Map<string, number> = new Map();
  private auditRecords: CreditUsageRecord[] = [];

  constructor(config: CostMeterConfig = {}) {
    this.totalBudget = config.totalBudget ?? 5000;
    this.perCallLimit = config.perCallLimit ?? 50;
    this.dailyLimit = config.dailyLimit ?? 2000;
    this.rates = {
      sttRatePerSec: config.rates?.sttRatePerSec ?? 0.1,
      ttsRatePerChar: config.rates?.ttsRatePerChar ?? 0.005,
      llmRatePerToken: config.rates?.llmRatePerToken ?? 0.001,
    };
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
   * Estimates credit consumption based on service type and consumed units.
   */
  public estimateCredits(service: AiServiceType, units: number): number {
    switch (service) {
      case 'PRISMA_STT':
        return Math.max(0.01, Math.round(units * this.rates.sttRatePerSec * 100) / 100);
      case 'TIMBRE_TTS':
        return Math.max(0.01, Math.round(units * this.rates.ttsRatePerChar * 1000) / 1000);
      case 'EVON_LLM':
        return Math.max(0.01, Math.round(units * this.rates.llmRatePerToken * 1000) / 1000);
      default:
        return 0.1;
    }
  }

  /**
   * Pre-flight credit check before executing any external API call.
   */
  public checkCanSpend(callId: string, estimatedCredits: number): void {
    this.checkDailyReset();

    const currentCallSpend = this.callSpendMap.get(callId) || 0;

    if (currentCallSpend + estimatedCredits > this.perCallLimit) {
      throw new CreditLimitExceededError(
        'PER_CALL',
        currentCallSpend + estimatedCredits,
        this.perCallLimit,
        callId
      );
    }

    if (this.dailySpent + estimatedCredits > this.dailyLimit) {
      throw new CreditLimitExceededError(
        'PER_DAY',
        this.dailySpent + estimatedCredits,
        this.dailyLimit,
        callId
      );
    }

    if (this.totalSpent + estimatedCredits > this.totalBudget) {
      throw new CreditLimitExceededError(
        'TOTAL_BUDGET',
        this.totalSpent + estimatedCredits,
        this.totalBudget,
        callId
      );
    }
  }

  /**
   * Records completed spend in memory and emits structured audit log.
   */
  public recordSpend(
    callId: string,
    service: AiServiceType,
    unitsConsumed: number,
    isMock = false
  ): CreditUsageRecord {
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
      rates: { ...this.rates },
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
