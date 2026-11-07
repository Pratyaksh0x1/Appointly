import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';
import { createServer } from '../src/index.js';
import { getDatabaseClient } from '../src/db/index.js';
import {
  createVoiceSessionToken,
  validateVoiceSessionToken,
  markVoiceSessionTokenUsed,
  checkRateLimit,
} from '../src/voice/session-manager.js';
import {
  initAudioCache,
  getCachedAudio,
  hasCachedAudio,
  FIXED_PHRASES,
} from '../src/voice/audio-cache.js';
import { VoiceActivityDetector } from '../src/voice/vad.js';
import { SentenceChunker, splitIntoSentences } from '../src/voice/sentence-chunker.js';
import { TurnMetricsTracker, globalLatencyCollector } from '../src/voice/timing-metrics.js';

describe('Phase 5: Realtime Voice Pipeline & WebSocket Telemetry', () => {
  let server: http.Server;
  const testPort = 3198;

  beforeAll(async () => {
    const db = getDatabaseClient();
    await db.initialize();
    await initAudioCache();

    server = createServer();
    await new Promise<void>((resolve) => server.listen(testPort, () => resolve()));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      if ('closeAllConnections' in server) {
        (server as any).closeAllConnections();
      }
    });
  });

  // Helper for HTTP requests
  const request = (
    method: 'GET' | 'POST',
    path: string,
    body?: any
  ): Promise<{ status?: number; data: any; text?: string; headers: http.IncomingHttpHeaders }> => {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : undefined;
      const req = http.request(
        {
          hostname: 'localhost',
          port: testPort,
          path,
          method,
          headers: payload
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
              }
            : {},
        },
        (res) => {
          let chunks = '';
          res.on('data', (c) => (chunks += c));
          res.on('end', () => {
            let data = {};
            try {
              data = JSON.parse(chunks);
            } catch {
              // text
            }
            resolve({
              status: res.statusCode,
              data,
              text: chunks,
              headers: res.headers,
            });
          });
        }
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  };

  // ==========================================
  // 1. SESSION MANAGER & TOKEN AUTHENTICATION
  // ==========================================
  describe('Session Token Auth & Rate Limiter', () => {
    it('generates a valid, cryptographically random single-use voice session token', () => {
      const result = createVoiceSessionToken('192.168.1.100', {
        patientPhone: '9876543210',
        doctorId: 'dr_sharma',
      });

      expect(result.sessionToken).toMatch(/^vtok_[0-9a-f]{48}$/);
      expect(result.wsUrl).toBe(`/ws/voice?token=${result.sessionToken}`);
      expect(result.expiresInSec).toBe(600); // 10 minutes

      const record = validateVoiceSessionToken(result.sessionToken);
      expect(record).not.toBeNull();
      expect(record?.patientPhone).toBe('9876543210');
      expect(record?.doctorId).toBe('dr_sharma');
      expect(record?.isUsed).toBe(false);

      markVoiceSessionTokenUsed(result.sessionToken);
      expect(record?.isUsed).toBe(true);
    });

    it('rejects invalid or non-existent tokens', () => {
      expect(validateVoiceSessionToken('vtok_invalid_token')).toBeNull();
      expect(validateVoiceSessionToken('')).toBeNull();
    });

    it('enforces rate limiting when max requests exceeded within window', () => {
      const testIp = '10.0.0.99';
      // Issue 20 tokens (up to max limit)
      for (let i = 0; i < 20; i++) {
        expect(() => checkRateLimit(testIp)).not.toThrow();
      }
      // 21st must throw TOO_MANY_REQUESTS
      expect(() => checkRateLimit(testIp)).toThrow(/TOO_MANY_REQUESTS/);
    });
  });

  // ==========================================
  // 2. PRE-GENERATED AUDIO CACHE
  // ==========================================
  describe('Pre-Generated Audio Cache', () => {
    it('warms up and retrieves pre-synthesized audio for fixed phrases', () => {
      const greeting = getCachedAudio('GREETING');
      expect(greeting).not.toBeNull();
      expect(greeting?.audioBuffer).toBeInstanceOf(Buffer);
      expect(greeting?.audioBuffer.length).toBeGreaterThan(0);
      expect(greeting?.mimeType).toContain('audio');

      const filler = getCachedAudio('FILLER');
      expect(filler).not.toBeNull();
      expect(filler?.text).toBe(FIXED_PHRASES.FILLER);

      // Verify retrieval by normalized text
      expect(hasCachedAudio(FIXED_PHRASES.GREETING)).toBe(true);
      expect(hasCachedAudio('Namaste! Arogya Clinic mein aapka swagat hai.')).toBe(false);
    });
  });

  // ==========================================
  // 3. VOICE ACTIVITY DETECTOR (VAD)
  // ==========================================
  describe('Voice Activity Detector (VAD)', () => {
    it('detects silence correctly for zero-amplitude PCM audio', () => {
      const vad = new VoiceActivityDetector({ energyThreshold: 400 });
      // 16000 Hz, 16-bit mono -> 320 bytes per 10ms frame
      const silenceFrame = Buffer.alloc(320, 0);

      const res = vad.processChunk(silenceFrame);
      expect(res.rmsEnergy).toBe(0);
      expect(res.isSpeaking).toBe(false);
      expect(res.isSpeechStart).toBe(false);
      expect(res.isSpeechEnd).toBe(false);
    });

    it('detects speech onset and endpointing on silence window', () => {
      const vad = new VoiceActivityDetector({
        energyThreshold: 400,
        silenceDurationMs: 100, // short for fast test
        minSpeechDurationMs: 50,
      });

      // Generate simulated voice audio frame with high RMS (amplitude 2000)
      const speechFrame = Buffer.alloc(320);
      for (let i = 0; i < speechFrame.length; i += 2) {
        speechFrame.writeInt16LE(2000, i);
      }

      // First speech frame triggers speech start
      const startRes = vad.processChunk(speechFrame);
      expect(startRes.isSpeechStart).toBe(true);
      expect(startRes.isSpeaking).toBe(true);
      expect(startRes.rmsEnergy).toBe(2000);

      // Continue speaking for 60ms (6 frames of 10ms)
      for (let i = 0; i < 6; i++) {
        vad.processChunk(speechFrame);
      }

      // Send silence frames to trigger endpointing
      const silenceFrame = Buffer.alloc(320, 0);
      let speechEndDetected = false;

      // 100ms of silence = 10 frames
      for (let i = 0; i < 15; i++) {
        const frameRes = vad.processChunk(silenceFrame);
        if (frameRes.isSpeechEnd) {
          speechEndDetected = true;
          break;
        }
      }

      expect(speechEndDetected).toBe(true);
    });
  });

  // ==========================================
  // 4. SENTENCE CHUNKER
  // ==========================================
  describe('Sentence Chunker & Streaming Punctuation Splitter', () => {
    it('splits complex multi-sentence Hinglish text on natural punctuation', () => {
      const fullText =
        'Aapka appointment confirm ho gaya hai! Doctor Sharma kal subah 10:00 baje uplabdh hain. Kripya samay par pahunchein.';
      const chunks = splitIntoSentences(fullText);

      expect(chunks.length).toBe(3);
      expect(chunks[0]).toBe('Aapka appointment confirm ho gaya hai!');
      expect(chunks[1]).toBe('Doctor Sharma kal subah 10:00 baje uplabdh hain.');
      expect(chunks[2]).toBe('Kripya samay par pahunchein.');
    });

    it('buffers tokens and emits completed sentences as boundaries arrive', () => {
      const chunker = new SentenceChunker();

      expect(chunker.push('Namaste ')).toBeNull();
      expect(chunker.push('ji! ')).toBe('Namaste ji!');
      expect(chunker.push('Main aapki ')).toBeNull();
      expect(chunker.push('madad kar sakta hoon? ')).toBe('Main aapki madad kar sakta hoon?');

      chunker.push('Aakhri sentence');
      expect(chunker.flush()).toBe('Aakhri sentence');
    });
  });

  // ==========================================
  // 5. TIMING METRICS & GLOBAL LATENCY COLLECTOR
  // ==========================================
  describe('Turn Timing Metrics & Percentiles', () => {
    it('tracks turn milestones and calculates latency percentiles accurately', () => {
      globalLatencyCollector.reset();

      const tracker = new TurnMetricsTracker('test_call_1');
      const start = Date.now();
      tracker.startTurn(1, start);

      // Simulate turn milestones
      tracker.markSttDone(start + 120);
      tracker.markLlmFirstToken(start + 350);
      tracker.markTtsFirstAudio(false, start + 550);

      const metrics = tracker.finalizeMetrics();
      expect(metrics.stt_ms).toBe(120);
      expect(metrics.llm_first_token_ms).toBe(230);
      expect(metrics.tts_first_audio_ms).toBe(200);
      expect(metrics.total_ms).toBe(550);
      expect(metrics.isCachedPhrase).toBe(false);

      // Record another fast turn (cached phrase)
      const tracker2 = new TurnMetricsTracker('test_call_2');
      const start2 = Date.now();
      tracker2.startTurn(1, start2);
      tracker2.markSttDone(start2 + 50);
      tracker2.markLlmFirstToken(start2 + 70);
      tracker2.markTtsFirstAudio(true, start2 + 85);
      tracker2.finalizeMetrics();

      const summary = globalLatencyCollector.getSummary();
      expect(summary.count).toBe(2);
      expect(summary.p50_total_ms).toBeGreaterThan(0);
      expect(summary.target_met_rate).toBe(100); // Both <= 1500ms
    });
  });

  // ==========================================
  // 6. HTTP ENDPOINTS & WEBSOCKET PIPELINE
  // ==========================================
  describe('HTTP REST & WebSocket Integration', () => {
    it('POST /api/voice/session issues short-lived session token', async () => {
      const res = await request('POST', '/api/voice/session', {
        patientPhone: '9876543210',
      });

      expect(res.status).toBe(200);
      expect(res.data.sessionToken).toMatch(/^vtok_/);
      expect(res.data.wsUrl).toContain('/ws/voice?token=');
      expect(res.data.expiresInSec).toBe(600);
    });

    it('GET /api/voice/latency returns aggregate system latency stats', async () => {
      const res = await request('GET', '/api/voice/latency');
      expect(res.status).toBe(200);
      expect(res.data.count).toBeDefined();
      expect(res.data.p50_total_ms).toBeDefined();
      expect(res.data.p95_total_ms).toBeDefined();
    });

    it('GET /voice-test.html serves the voice testing suite UI', async () => {
      const res = await request('GET', '/voice-test.html');
      expect(res.status).toBe(200);
      expect(res.text).toContain('Appointly Voice Tester');
      expect(res.text).toContain('btnToggleCall');
    });

    it('rejects WebSocket connection without token or with invalid token with 401', async () => {
      await expect(
        new Promise((resolve, reject) => {
          const ws = new WebSocket(`ws://localhost:${testPort}/ws/voice`);
          ws.on('open', () => reject(new Error('Should not connect without token')));
          ws.on('unexpected-response', (req, res) => {
            expect(res.statusCode).toBe(401);
            resolve(true);
          });
          ws.on('error', (err) => resolve(true));
        })
      ).resolves.toBe(true);

      await expect(
        new Promise((resolve, reject) => {
          const ws = new WebSocket(`ws://localhost:${testPort}/ws/voice?token=bogus_token`);
          ws.on('open', () => reject(new Error('Should not connect with bogus token')));
          ws.on('unexpected-response', (req, res) => {
            expect(res.statusCode).toBe(401);
            resolve(true);
          });
          ws.on('error', (err) => resolve(true));
        })
      ).resolves.toBe(true);
    });

    it('connects via authenticated WebSocket, plays greeting, and handles conversational turns', async () => {
      // 1. Get token
      const sessionRes = await request('POST', '/api/voice/session', {
        patientPhone: '9876543210',
      });
      const token = sessionRes.data.sessionToken;

      // 2. Open WebSocket
      const ws = new WebSocket(`ws://localhost:${testPort}/ws/voice?token=${token}`);
      const receivedEvents: any[] = [];
      let receivedAudioChunks = 0;

      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => {
          // Connected!
        });

        ws.on('message', (data: Buffer | string, isBinary: boolean) => {
          if (isBinary) {
            receivedAudioChunks++;
          } else {
            const parsed = JSON.parse(data.toString());
            receivedEvents.push(parsed);
          }

          // Once greeting agent_text AND audio chunks are received, we proceed
          if (
            receivedEvents.some((e) => e.type === 'agent_text' && e.text.includes('Namaste')) &&
            receivedAudioChunks > 0
          ) {
            resolve();
          }
        });

        ws.on('error', reject);
        setTimeout(() => reject(new Error('WebSocket initial handshake timeout')), 5000);
      });

      // Verify session_ready and greeting audio were sent
      const readyEvent = receivedEvents.find((e) => e.type === 'session_ready');
      expect(readyEvent).toBeDefined();
      expect(readyEvent.callId).toBeDefined();
      expect(receivedAudioChunks).toBeGreaterThan(0);

      // 3. Send Barge-in interrupt event
      ws.send(JSON.stringify({ type: 'interrupt' }));
      await new Promise((r) => setTimeout(r, 150));

      const interruptEvent = receivedEvents.find((e) => e.type === 'interrupt');
      expect(interruptEvent).toBeDefined();

      // 4. Send ping
      ws.send(JSON.stringify({ type: 'ping' }));
      await new Promise((r) => setTimeout(r, 150));
      const pongEvent = receivedEvents.find((e) => e.type === 'pong');
      expect(pongEvent).toBeDefined();

      // 5. Clean teardown: wait for socket close acknowledgment
      await new Promise<void>((resolve) => {
        ws.on('close', () => resolve());
        ws.close();
      });
    });
  });
});
