import { describe, it, expect, beforeEach, vi } from 'vitest';
import dotenv from 'dotenv';
import {
  MockSttAdapter,
  MockTtsAdapter,
  MockLlmAdapter,
  GnaniSttAdapter,
  GnaniTtsAdapter,
  EvonOpenAiLlmAdapter,
  executeWithRetryAndTimeout,
  GnaniTimeoutError,
  CircuitBreakerOpenError,
  CreditLimitExceededError,
} from '../src/adapters/index.js';
import { CircuitBreaker } from '../src/utils/circuit-breaker.js';
import { CostMeter } from '../src/cost/cost-meter.js';
import { rootLogger } from '../src/logger/logger.js';

dotenv.config();

describe('Phase 3: Gnani & Evon Adapters Contract Tests', () => {
  let mockStt: MockSttAdapter;
  let mockTts: MockTtsAdapter;
  let mockLlm: MockLlmAdapter;
  let testCostMeter: CostMeter;

  beforeEach(() => {
    mockStt = new MockSttAdapter('Mujhe kal Dr. Sharma ka appointment chahiye fever ke liye.');
    mockTts = new MockTtsAdapter();
    mockLlm = new MockLlmAdapter();
    testCostMeter = new CostMeter({ totalBudget: 5000, perCallLimit: 50, dailyLimit: 2000 });
  });

  // ==========================================
  // 1. MOCK ADAPTER CONTRACTS
  // ==========================================

  describe('Mock Providers Contract (Default in Test/Dev)', () => {
    it('Mock STT: transcribes synthetic audio buffer into Hinglish clinic transcript', async () => {
      const dummyAudio = Buffer.alloc(32000); // 1 second of audio at 16kHz 16-bit
      const result = await mockStt.transcribe(dummyAudio, {
        callId: 'test_call_stt',
        languageCode: 'hi-IN',
      });

      expect(result.transcript).toContain('Dr. Sharma');
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
      expect(result.isFinal).toBe(true);
      expect(result.durationSeconds).toBe(1);
    });

    it('Mock STT Streaming: streams partial and final transcripts', async () => {
      const stream = mockStt.createStream({ languageCode: 'hi-IN' });
      const emitted: string[] = [];

      stream.onTranscript((res) => {
        emitted.push(res.transcript);
      });

      stream.sendAudioChunk(Buffer.alloc(1024));
      stream.endAudio();

      expect(emitted.length).toBeGreaterThanOrEqual(2);
      expect(emitted[emitted.length - 1]).toContain('Dr. Sharma');
    });

    it('Mock TTS: synthesizes text into valid WAV buffer with proper header', async () => {
      const text = 'Aapka appointment kal subah 10 baje confirm ho gaya hai.';
      const result = await mockTts.synthesize(text, {
        callId: 'test_call_tts',
        voice: 'Shivani',
      });

      expect(result.mimeType).toBe('audio/wav');
      expect(result.sampleRate).toBe(16000);
      expect(result.characterCount).toBe(text.length);
      expect(result.audioBuffer.length).toBeGreaterThan(44);

      // Verify RIFF and WAVE header tags in buffer
      expect(result.audioBuffer.subarray(0, 4).toString()).toBe('RIFF');
      expect(result.audioBuffer.subarray(8, 12).toString()).toBe('WAVE');
    });

    it('Mock TTS Streaming: streams audio chunks asynchronously', async () => {
      const text = 'Namaste, main Arogya Care Clinic se bol rahi hoon.';
      const chunks: Uint8Array[] = [];

      for await (const chunk of mockTts.createStream(text)) {
        chunks.push(chunk);
      }

      expect(chunks.length).toBeGreaterThan(0);
      const totalBytes = chunks.reduce((acc, c) => acc + c.length, 0);
      expect(totalBytes).toBeGreaterThan(44);
    });

    it('Mock LLM: returns conversational message and structured tool call when appointment requested', async () => {
      const messages = [
        {
          role: 'user' as const,
          content: 'Mujhe kal subah Dr. Sharma ke paas appointment chahiye fever ke liye.',
        },
      ];

      const response = await mockLlm.chat(messages, {
        callId: 'test_call_llm',
      });

      expect(response.content).toBeDefined();
      expect(response.toolCalls).toBeDefined();
      expect(response.toolCalls!.length).toBe(1);

      const toolCall = response.toolCalls![0];
      expect(toolCall.function.name).toBe('check_slots');

      const args = JSON.parse(toolCall.function.arguments);
      expect(args.doctorId).toBe('dr_sharma');
      expect(args.date).toBe('2026-11-10');
    });

    it('Mock LLM Streaming: streams token chunks and final tool call', async () => {
      const messages = [
        {
          role: 'user' as const,
          content: 'Mujhe fever hai, Dr. Sharma se milna hai.',
        },
      ];

      const streamChunks = [];
      for await (const chunk of mockLlm.streamChat(messages)) {
        streamChunks.push(chunk);
      }

      expect(streamChunks.length).toBeGreaterThan(0);
      expect(streamChunks.some((c) => c.toolCallChunk?.function?.name === 'check_slots')).toBe(
        true
      );
    });
  });

  // ==========================================
  // 2. RESILIENCE, RETRIES & TIMEOUTS
  // ==========================================

  describe('Resilience: Retries, Timeouts & Idempotency Rules', () => {
    it('retries with exponential backoff on transient failure FOR IDEMPOTENT CALLS ONLY', async () => {
      let callCount = 0;
      const failingAction = async () => {
        callCount++;
        if (callCount < 3) {
          throw new Error('Transient 503 network glitch');
        }
        return 'success_after_retry';
      };

      const result = await executeWithRetryAndTimeout(failingAction, {
        serviceName: 'TestService',
        isIdempotent: true, // Idempotent -> retries permitted
        maxRetries: 3,
        baseBackoffMs: 20,
        timeoutMs: 3000,
      });

      expect(result).toBe('success_after_retry');
      expect(callCount).toBe(3);
    });

    it('STRICT NON-NEGOTIABLE RULE: does NOT retry non-idempotent calls', async () => {
      let callCount = 0;
      const failingAction = async () => {
        callCount++;
        throw new Error('Network timeout during payment/booking write');
      };

      await expect(
        executeWithRetryAndTimeout(failingAction, {
          serviceName: 'NonIdempotentWriteService',
          isIdempotent: false, // Non-idempotent -> ZERO retries allowed!
          maxRetries: 3,
          baseBackoffMs: 20,
          timeoutMs: 3000,
        })
      ).rejects.toThrow();

      // Exactly ONE attempt made!
      expect(callCount).toBe(1);
    });

    it('throws GnaniTimeoutError when operation exceeds timeout threshold', async () => {
      const slowAction = async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return 'too_late';
      };

      await expect(
        executeWithRetryAndTimeout(slowAction, {
          serviceName: 'SlowGnaniService',
          isIdempotent: false,
          timeoutMs: 50, // 50ms timeout
        })
      ).rejects.toThrow(GnaniTimeoutError);
    });
  });

  // ==========================================
  // 3. CIRCUIT BREAKER
  // ==========================================

  describe('Circuit Breaker Pattern', () => {
    it('trips to OPEN after consecutive failures and fast-fails subsequent calls', async () => {
      const breaker = new CircuitBreaker({
        serviceName: 'TestCircuit',
        failureThreshold: 2,
        resetTimeoutMs: 100, // 100ms reset window
      });

      expect(breaker.getState()).toBe('CLOSED');

      // Failure 1
      await expect(
        breaker.execute(async () => {
          throw new Error('Outage 1');
        })
      ).rejects.toThrow('Outage 1');
      expect(breaker.getState()).toBe('CLOSED');

      // Failure 2 -> Threshold reached -> trips to OPEN
      await expect(
        breaker.execute(async () => {
          throw new Error('Outage 2');
        })
      ).rejects.toThrow('Outage 2');
      expect(breaker.getState()).toBe('OPEN');

      // Subsequent call immediately fast-fails with CircuitBreakerOpenError without invoking action!
      let invoked = false;
      await expect(
        breaker.execute(async () => {
          invoked = true;
          return 'should_not_run';
        })
      ).rejects.toThrow(CircuitBreakerOpenError);
      expect(invoked).toBe(false);

      // Wait for cooldown to expire -> enters HALF_OPEN
      await new Promise((resolve) => setTimeout(resolve, 110));
      expect(breaker.getState()).toBe('HALF_OPEN');

      // Successful probe in HALF_OPEN recovers the circuit to CLOSED
      const probeResult = await breaker.execute(async () => 'recovered');
      expect(probeResult).toBe('recovered');
      expect(breaker.getState()).toBe('CLOSED');
    });
  });

  // ==========================================
  // 4. COST METER & CREDIT LIMITS
  // ==========================================

  describe('Cost Meter & Credit Allocation', () => {
    it('calculates credit estimates for STT, TTS, and LLM correctly', () => {
      // 10s of STT = 1.0 credit (0.1 credit/sec)
      expect(testCostMeter.estimateCredits('PRISMA_STT', 10)).toBe(1.0);

      // 200 chars of TTS = 1.0 credit (0.005 credit/char)
      expect(testCostMeter.estimateCredits('TIMBRE_TTS', 200)).toBe(1.0);

      // 1000 tokens of LLM = 1.0 credit (0.001 credit/token)
      expect(testCostMeter.estimateCredits('EVON_LLM', 1000)).toBe(1.0);
    });

    it('enforces per-call cap (50 credits) and throws CreditLimitExceededError', () => {
      // Call with 45 credits allowed
      expect(() => testCostMeter.checkCanSpend('call_1', 45)).not.toThrow();
      testCostMeter.recordSpend('call_1', 'PRISMA_STT', 450); // 45 credits

      // Attempting to spend 10 more on SAME call pushes total to 55 > 50 -> throws!
      expect(() => testCostMeter.checkCanSpend('call_1', 10)).toThrow(CreditLimitExceededError);
    });

    it('enforces daily cap (2,000 credits)', () => {
      const tightMeter = new CostMeter({
        totalBudget: 5000,
        perCallLimit: 50,
        dailyLimit: 100, // Small 100 credit limit for test
      });

      tightMeter.recordSpend('call_a', 'PRISMA_STT', 900); // 90 credits
      expect(() => tightMeter.checkCanSpend('call_b', 20)).toThrow(CreditLimitExceededError);
    });
  });

  // ==========================================
  // 5. SECURITY: SECRETS NEVER LOGGED
  // ==========================================

  describe('Security & Secret Redaction in Adapters', () => {
    it('never prints API keys or secrets in logs when adapters log events', () => {
      const logs: string[] = [];
      const originalWrite = process.stdout.write;
      // Capture log output
      (process.stdout.write as unknown) = (chunk: string) => {
        logs.push(chunk.toString());
        return true;
      };

      try {
        const dummySecret = 'gnani_secret_key_9988776655';
        rootLogger.info('Testing adapter logging with token', {
          token: dummySecret,
          apiKey: dummySecret,
          phone: '+91 9876543210',
        });

        const output = logs.join('');
        expect(output).not.toContain(dummySecret);
        expect(output).toContain('[REDACTED]');
        expect(output).not.toContain('9876543210'); // Phone masked
      } finally {
        process.stdout.write = originalWrite;
      }
    });
  });

  // ==========================================
  // 6. REAL GNANI ADAPTERS (OPT-IN VIA ENV FLAG)
  // ==========================================

  describe('Production Gnani Adapters (Opt-in via TEST_REAL_GNANI=true)', () => {
    const isRealTestingEnabled = process.env.TEST_REAL_GNANI === 'true';

    it.runIf(isRealTestingEnabled)(
      'Real Gnani STT: sends live audio and transcribes via api.vachana.ai',
      async () => {
        const apiKey = process.env.GNANI_API_KEY!;
        expect(apiKey).toBeDefined();

        const realStt = new GnaniSttAdapter(apiKey);
        const dummyWav = Buffer.alloc(16000 * 2); // 1 sec of 16kHz audio
        const result = await realStt.transcribe(dummyWav, {
          callId: 'smoke_real_stt',
          model: 'prisma-v3.0',
        });

        expect(result.language).toBeDefined();
        expect(result.durationSeconds).toBeGreaterThan(0);
      },
      25000
    );

    it.runIf(isRealTestingEnabled)(
      'Real Gnani TTS: synthesizes live Hindi-English text via api.vachana.ai',
      async () => {
        const apiKey = process.env.GNANI_API_KEY!;
        expect(apiKey).toBeDefined();

        const realTts = new GnaniTtsAdapter(apiKey);
        const result = await realTts.synthesize(
          'Namaste, main Arogya Care Clinic se bol rahi hoon.',
          {
            callId: 'smoke_real_tts',
            voice: 'Shivani',
          }
        );

        expect(result.audioBuffer.length).toBeGreaterThan(44);
        expect(result.mimeType).toBe('audio/wav');
      },
      25000
    );

    it.runIf(isRealTestingEnabled)(
      'Real Evon LLM: runs chat completion with tool calling',
      async () => {
        const apiKey = process.env.EVON_API_KEY || process.env.GNANI_API_KEY!;
        const baseUrl = process.env.EVON_BASE_URL || 'https://api.vachana.ai/v1';

        const realLlm = new EvonOpenAiLlmAdapter(apiKey, baseUrl, 'evon-30b');
        const response = await realLlm.chat(
          [{ role: 'user', content: 'Mujhe doctor ka appointment chahiye' }],
          { callId: 'smoke_real_llm' }
        );

        expect(response.content.length).toBeGreaterThan(0);
      },
      25000
    );
  });
});
