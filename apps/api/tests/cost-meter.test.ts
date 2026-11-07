import { describe, it, expect, beforeEach } from 'vitest';
import { CostMeter, CreditLimitExceededError } from '../src/cost/cost-meter.js';

describe('Cost Meter & Credit Limiter', () => {
  let meter: CostMeter;

  beforeEach(() => {
    meter = new CostMeter({
      totalBudget: 5000,
      perCallLimit: 50,
      dailyLimit: 2000,
    });
  });

  it('should estimate credit usage accurately', () => {
    // STT: 10 seconds -> 1 credit
    expect(meter.estimateCredits('PRISMA_STT', 10)).toBe(1.0);
    // TTS: 200 chars -> 1 credit
    expect(meter.estimateCredits('TIMBRE_TTS', 200)).toBe(1.0);
    // LLM: 1000 tokens -> 1 credit
    expect(meter.estimateCredits('EVON_LLM', 1000)).toBe(1.0);
  });

  it('should record spend and track budget correctly', () => {
    const callId = 'call_test_1';
    meter.recordSpend(callId, 'PRISMA_STT', 20); // 2.0 credits
    meter.recordSpend(callId, 'TIMBRE_TTS', 400); // 2.0 credits

    const summary = meter.getSummary();
    expect(summary.totalSpent).toBe(4.0);
    expect(summary.remainingCredits).toBe(4996.0);
  });

  it('should enforce per-call credit limit', () => {
    const callId = 'call_test_runaway';
    // Consume 49 credits
    meter.recordSpend(callId, 'PRISMA_STT', 490); // 49 credits

    // Attempting to spend 2 more credits should exceed 50 per-call limit
    expect(() => meter.checkCanSpend(callId, 2.0)).toThrowError(CreditLimitExceededError);
  });

  it('should bypass credit burn when in mock mode', () => {
    const callId = 'call_mock';
    meter.recordSpend(callId, 'PRISMA_STT', 1000, true); // isMock = true

    const summary = meter.getSummary();
    expect(summary.totalSpent).toBe(0);
    expect(summary.remainingCredits).toBe(5000);
  });
});
