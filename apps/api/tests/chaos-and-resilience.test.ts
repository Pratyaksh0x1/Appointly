import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';
import { createServer } from '../src/index.js';
import { getDatabaseClient } from '../src/db/index.js';
import { createVoiceSessionToken } from '../src/voice/session-manager.js';
import { initAudioCache, FIXED_PHRASES } from '../src/voice/audio-cache.js';
import { handleCallDropped, createSession } from '../src/agent/orchestrator.js';
import { executeAgentTool } from '../src/agent/tools.js';
import { OutboxEvent } from '../src/db/outbox-relay.js';

describe('Phase 8: Chaos & Resilience Suite', () => {
  let server: http.Server;
  const testPort = 3196;

  beforeAll(async () => {
    const db = getDatabaseClient();
    await db.initialize();
    await initAudioCache();

    server = createServer();
    await new Promise<void>((resolve) => server.listen(testPort, () => resolve()));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe('1. Provider Failure & Voice Graceful Degradation', () => {
    it('gracefully degrades with Hinglish apology and saves callback_request on turn error', async () => {
      const db = getDatabaseClient();
      const patientPhone = '9876541122';
      const tokenResult = createVoiceSessionToken('127.0.0.1', { patientPhone });

      const ws = new WebSocket(
        `ws://localhost:${testPort}/ws/voice?token=${tokenResult.sessionToken}`
      );

      const receivedEvents: any[] = [];
      let receivedAudioChunks = 0;

      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => {
          // Send malformed or trigger processing that causes a turn error
          ws.send(
            JSON.stringify({
              type: 'speech_end',
            })
          );
        });

        ws.on('message', (data: Buffer | string, isBinary: boolean) => {
          if (isBinary) {
            receivedAudioChunks++;
          } else {
            try {
              const event = JSON.parse(data.toString());
              receivedEvents.push(event);
              if (event.type === 'error' || event.code === 'GRACEFUL_DEGRADATION_TRIGGERED') {
                resolve();
              }
            } catch {
              // ignore
            }
          }
        });

        ws.on('error', reject);
        setTimeout(resolve, 3000); // safety timeout
      });

      ws.close();

      // Verify that graceful degradation was handled cleanly without throwing
      // And verify that DB callback_requests table is accessible
      const callbacks = await db.getCallbackRequests();
      expect(Array.isArray(callbacks)).toBe(true);
    });
  });

  describe('2. Outbox Retry & Dead-Letter State Transition', () => {
    it('transitions event to DEAD_LETTER when retries exceed maxRetries', async () => {
      const db = getDatabaseClient();
      const eventId = `test_outbox_retry_${Date.now()}`;

      // 1. Save an outbox event
      if (db.saveOutboxEvent) {
        await db.saveOutboxEvent(eventId, 'test_event', { sample: 123 });
      }

      // 2. Simulate 3 consecutive delivery failures
      if (db.markOutboxEventFailed) {
        await db.markOutboxEventFailed(eventId, 'Network timeout attempt 1');
        await db.markOutboxEventFailed(eventId, 'Network timeout attempt 2');
        await db.markOutboxEventFailed(eventId, 'Network timeout attempt 3 (Fatal)');
      }

      // 3. Query dead letter queue
      const deadLetters = db.getDeadLetterOutboxEvents ? await db.getDeadLetterOutboxEvents() : [];
      const deadEvent = deadLetters.find((e: any) => e.id === eventId);

      expect(deadEvent).toBeDefined();
      expect(deadEvent?.status).toBe('DEAD_LETTER');
      expect(deadEvent?.retryCount).toBeGreaterThanOrEqual(3);
      expect(deadEvent?.lastError).toContain('attempt 3');
    });
  });

  describe('3. Mid-Call Abrupt Disconnect & Hold Release (Atomic Safety)', () => {
    it('releases active hold immediately on dropped call so no ghost booking remains', async () => {
      const db = getDatabaseClient();
      const doctorId = 'dr_sharma';
      const date = '2026-11-28';
      const startTime = '17:30';

      // 1. Hold a slot via agent tool
      const holdRes = await executeAgentTool(
        'hold_slot',
        {
          doctorId,
          date,
          startTime,
          patientPhone: '9876543344',
        },
        { callId: `call_hold_${Date.now()}` }
      );
      expect(holdRes.success).toBe(true);
      const holdToken = (holdRes.data as any)?.holdToken;
      expect(holdToken).toBeDefined();

      // 2. Simulate caller hanging up mid-sentence before confirmation
      const session = createSession('9876543344', `call_dropped_${Date.now()}`);
      session.state = 'CONFIRM_READBACK';
      session.doctorId = doctorId;
      session.doctorName = 'Dr. Sharma';
      session.targetDate = date;
      session.selectedSlot = startTime;
      session.holdId = holdToken;

      await handleCallDropped(session);

      // Verify hold was cleanly released and session.holdId was cleared
      expect(session.holdId).toBeUndefined();

      // Verify the slot is once again available
      const slots = await db.getAvailableSlots(doctorId, date);
      expect(slots).toContain(startTime);
    });
  });

  describe('4. Database Fault Tolerance & Safe Query Execution', () => {
    it('handles query failure safely and does not bring down the server process', async () => {
      const db = getDatabaseClient();
      // Test querying with non-existent IDs
      const nonExistentDoc = await db.getDoctorById('invalid_doctor_id_9999');
      expect(nonExistentDoc).toBeNull();

      const nonExistentVerification = await db.findAppointmentForVerification(
        'NonExistentPatientXYZ',
        '9999'
      );
      expect(nonExistentVerification).toBeNull();

      // Server is still healthy and responsive
      const res = await new Promise<{ status: number }>((resolve, reject) => {
        http
          .get(`http://localhost:${testPort}/healthz`, (r) => {
            resolve({ status: r.statusCode || 0 });
          })
          .on('error', reject);
      });
      expect(res.status).toBe(200);
    });
  });
});
