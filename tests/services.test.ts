import { describe, it, expect, beforeEach, vi } from 'vitest';
import { withRetryAndFallback, ExternalServiceError, FALLBACK_HINGLISH_APOLOGY } from '../src/utils/retry.js';
import { GnaniSTTClient } from '../src/services/stt-client.js';
import { GnaniTTSClient } from '../src/services/tts-client.js';
import { EvonLLMClient } from '../src/services/evon-llm-client.js';
import { globalCostMeter, CreditLimitExceededError } from '../src/cost/cost-meter.js';
import { getDatabaseClient } from '../src/db/index.js';

describe('Phase 2: External API Services, Resilience & Fallback Protocol', () => {
  beforeEach(() => {
    globalCostMeter.resetForTesting();
  });

  describe('withRetryAndFallback', () => {
    it('should succeed on first try if operation succeeds', async () => {
      const op = vi.fn().mockResolvedValue('success_result');
      const result = await withRetryAndFallback(op, {
        callId: 'call_1',
        operationName: 'test_op',
      });

      expect(result).toBe('success_result');
      expect(op).toHaveBeenCalledTimes(1);
    });

    it('should retry on transient failures and succeed if subsequent attempt succeeds', async () => {
      let attempts = 0;
      const op = vi.fn().mockImplementation(async () => {
        attempts++;
        if (attempts < 3) {
          throw new ExternalServiceError('Transient 503 Server Error', 503, true);
        }
        return 'eventual_success';
      });

      const result = await withRetryAndFallback(op, {
        callId: 'call_retry',
        operationName: 'test_retry',
        maxRetries: 3,
        backoffBaseMs: 10, // fast for testing
      });

      expect(result).toBe('eventual_success');
      expect(op).toHaveBeenCalledTimes(3);
    });

    it('should NOT retry on non-retryable 401 Unauthorized errors', async () => {
      const op = vi.fn().mockRejectedValue(new ExternalServiceError('Invalid API Key', 401, false));

      await expect(
        withRetryAndFallback(op, {
          callId: 'call_auth_fail',
          operationName: 'test_auth',
          maxRetries: 3,
          backoffBaseMs: 10,
        })
      ).rejects.toThrow('Invalid API Key');

      expect(op).toHaveBeenCalledTimes(1);
    });

    it('should save a callback_request in DB and return fallback value on complete failure', async () => {
      const db = getDatabaseClient();
      const op = vi.fn().mockRejectedValue(new ExternalServiceError('Fatal connection failure', 500, true));

      const fallbackResult = await withRetryAndFallback(op, {
        callId: 'call_fallback_db',
        patientPhone: '9876543210',
        operationName: 'failing_service',
        maxRetries: 2,
        backoffBaseMs: 10,
        fallbackValue: FALLBACK_HINGLISH_APOLOGY,
      });

      expect(fallbackResult).toBe(FALLBACK_HINGLISH_APOLOGY);
      const callbacks = await db.getCallbackRequests();
      const matching = callbacks.find((c) => c.callId === 'call_fallback_db');
      expect(matching).toBeDefined();
      expect(matching?.patientPhoneMasked).toBe('+91 ******3210');
      expect(matching?.reason).toContain('failing_service');
    });
  });

  describe('GnaniSTTClient', () => {
    it('should transcribe audio in mock mode without consuming live credits', async () => {
      const client = new GnaniSTTClient({ isMockMode: true });
      const dummyAudio = Buffer.alloc(32000); // ~1 sec of 16kHz mono audio

      const res = await client.transcribeAudio(dummyAudio, 'call_stt_test', {
        durationSeconds: 5,
      });

      expect(res.success).toBe(true);
      expect(res.isMock).toBe(true);
      expect(res.transcript).toContain('Dr. Sharma');

      const summary = globalCostMeter.getSummary();
      expect(summary.totalSpent).toBe(0); // Mock mode burns 0 credits
    });

    it('should reject transcription if credit budget is exceeded', async () => {
      const client = new GnaniSTTClient({ isMockMode: true });
      // Burn 50 credits to max out per-call limit
      globalCostMeter.recordSpend('call_exhausted', 'PRISMA_STT', 500, false);

      await expect(
        client.transcribeAudio(Buffer.alloc(32000), 'call_exhausted', { durationSeconds: 10 })
      ).rejects.toThrowError(CreditLimitExceededError);
    });
  });

  describe('GnaniTTSClient', () => {
    it('should synthesize audio in mock mode returning valid 44-byte WAV header', async () => {
      const client = new GnaniTTSClient({ isMockMode: true });
      const text = 'Namaste, aapka appointment confirm ho gaya hai.';

      const res = await client.synthesize(text, 'call_tts_test', {
        voice: 'Shivani',
      });

      expect(res.isMock).toBe(true);
      expect(res.contentType).toBe('audio/wav');
      expect(res.audioBuffer.length).toBeGreaterThan(44);
      expect(res.audioBuffer.toString('utf8', 0, 4)).toBe('RIFF');
      expect(res.audioBuffer.toString('utf8', 8, 12)).toBe('WAVE');
    });
  });

  describe('EvonLLMClient', () => {
    it('should generate validated book_appointment tool call on booking request in mock mode', async () => {
      const client = new EvonLLMClient({ isMockMode: true });
      const messages = [
        { role: 'user' as const, content: 'Mujhe Dr. Sharma se kal subah 9:30 par appointment book karna hai' },
      ];

      const res = await client.generateResponse(messages, [], 'call_llm_test');
      expect(res.isMock).toBe(true);
      expect(res.message.tool_calls).toBeDefined();
      expect(res.message.tool_calls?.[0].function.name).toBe('book_appointment');

      const args = JSON.parse(res.message.tool_calls![0].function.arguments);
      expect(args.doctorId).toBe('dr_sharma');
      expect(args.startTime).toBe('09:30');
    });

    it('should return doctor listing tool call on doctor inquiry in mock mode', async () => {
      const client = new EvonLLMClient({ isMockMode: true });
      const messages = [{ role: 'user' as const, content: 'Aapke paas kaunse specialist doctors available hain?' }];

      const res = await client.generateResponse(messages, [], 'call_llm_docs');
      expect(res.message.tool_calls?.[0].function.name).toBe('get_clinic_doctors');
    });
  });
});
