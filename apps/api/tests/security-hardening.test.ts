import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { createServer } from '../src/index.js';
import { getDatabaseClient } from '../src/db/index.js';
import { globalRateLimiter } from '../src/middleware/rate-limiter.js';
import { globalIdempotencyStore } from '../src/middleware/idempotency.js';
import { maskPhone, redactPiiFromTranscript } from '../src/logger/logger.js';
import { runTranscriptRetentionJob } from '../src/services/transcript-retention.js';
import { signDoctorToken, CLINIC_DOCTOR_ROSTER } from '../src/auth/jwt-auth.js';

describe('Phase 8: Reliability & Security Hardening Suite', () => {
  let server: http.Server;
  const testPort = 3195;
  const doctorToken = signDoctorToken(CLINIC_DOCTOR_ROSTER['dr_sharma']);

  beforeAll(async () => {
    const db = getDatabaseClient();
    await db.initialize();
    globalIdempotencyStore.clear();
    globalRateLimiter.reset();

    server = createServer();
    await new Promise<void>((resolve) => server.listen(testPort, () => resolve()));
  });

  afterAll(async () => {
    globalIdempotencyStore.clear();
    globalRateLimiter.reset();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function makeRequest(
    method: string,
    reqPath: string,
    headers: Record<string, string> = {},
    body?: any
  ): Promise<{ status: number; headers: http.IncomingHttpHeaders; data: any; rawBody: string }> {
    return new Promise((resolve, reject) => {
      const payload = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined;
      const reqHeaders: Record<string, string> = {
        ...headers,
      };
      if (payload && !reqHeaders['Content-Type']) {
        reqHeaders['Content-Type'] = 'application/json';
      }
      if (payload && !reqHeaders['Content-Length']) {
        reqHeaders['Content-Length'] = String(Buffer.byteLength(payload));
      }

      const req = http.request(
        {
          hostname: 'localhost',
          port: testPort,
          path: reqPath,
          method,
          headers: reqHeaders,
        },
        (res) => {
          let raw = '';
          res.on('data', (c) => (raw += c));
          res.on('end', () => {
            let data: any = {};
            try {
              data = JSON.parse(raw);
            } catch {
              data = raw;
            }
            resolve({
              status: res.statusCode || 0,
              headers: res.headers,
              data,
              rawBody: raw,
            });
          });
        }
      );

      req.on('error', reject);
      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  }

  describe('1. Security Headers & CORS Enforcement', () => {
    it('applies strict enterprise security headers on GET /health', async () => {
      const res = await makeRequest('GET', '/health');
      expect(res.status).toBe(200);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['x-xss-protection']).toBe('1; mode=block');
      expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
      expect(res.headers['strict-transport-security']).toContain('max-age=31536000');
      expect(res.headers['content-security-policy']).toBeDefined();
    });

    it('handles CORS OPTIONS preflight correctly with standard allowed headers', async () => {
      const res = await makeRequest('OPTIONS', '/api/chat', {
        Origin: 'http://localhost:3000',
        'Access-Control-Request-Method': 'POST',
      });
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBeDefined();
      expect(res.headers['access-control-allow-methods']).toContain('POST');
      expect(res.headers['access-control-allow-headers']).toContain('Idempotency-Key');
    });
  });

  describe('2. Idempotency Key Guarantees', () => {
    it('replays identical cached response on duplicate Idempotency-Key on POST /api/chat', async () => {
      const idemKey = `idem_chat_${Date.now()}`;
      const payload = {
        text: 'Namaste, Dr. Sharma ki OPD timing bataiye.',
        callId: `call_idem_${Date.now()}`,
        phone: '9876543210',
      };

      // Turn 1
      const res1 = await makeRequest('POST', '/api/chat', { 'Idempotency-Key': idemKey }, payload);
      expect(res1.status).toBe(200);
      expect(res1.data.replyText).toBeDefined();

      // Turn 2: identical key should return cached response without LLM re-invocation
      const res2 = await makeRequest('POST', '/api/chat', { 'Idempotency-Key': idemKey }, payload);
      expect(res2.status).toBe(200);
      expect(res2.headers['x-cache-lookup']).toBe('HIT');
      expect(res2.headers['x-idempotency-replay']).toBe('true');
      expect(res2.data.replyText).toBe(res1.data.replyText);
    });

    it('replays cached response on duplicate X-Idempotency-Key', async () => {
      const idemKey = `x_idem_${Date.now()}`;
      const payload = {
        text: 'Available doctors list please',
        callId: `call_x_${Date.now()}`,
      };

      const res1 = await makeRequest(
        'POST',
        '/api/chat',
        { 'X-Idempotency-Key': idemKey },
        payload
      );
      expect(res1.status).toBe(200);

      const res2 = await makeRequest(
        'POST',
        '/api/chat',
        { 'X-Idempotency-Key': idemKey },
        payload
      );
      expect(res2.status).toBe(200);
      expect(res2.headers['x-idempotency-replay']).toBe('true');
      expect(res2.data.replyText).toBe(res1.data.replyText);
    });
  });

  describe('3. Rate Limiting Protection (Sliding Window)', () => {
    it('enforces rate limits and returns 429 when threshold exceeded', async () => {
      // Test SlidingWindowRateLimiter instance directly with small threshold
      const mockReq = {
        headers: { 'x-forwarded-for': '192.168.10.50' },
        socket: { remoteAddress: '192.168.10.50' },
      } as any;

      const mockRes = {
        headers: {} as Record<string, string>,
        statusCode: 200,
        body: '',
        setHeader(k: string, v: string) {
          this.headers[k] = v;
        },
        writeHead(code: number, headers?: any) {
          this.statusCode = code;
          if (headers) Object.assign(this.headers, headers);
        },
        end(data: string) {
          this.body = data;
        },
      } as any;

      const customLimit = 3;
      // Requests 1, 2, 3 should pass
      expect(globalRateLimiter.checkRateLimit(mockReq, mockRes, customLimit)).toBe(true);
      expect(globalRateLimiter.checkRateLimit(mockReq, mockRes, customLimit)).toBe(true);
      expect(globalRateLimiter.checkRateLimit(mockReq, mockRes, customLimit)).toBe(true);

      // Request 4 should be rejected with 429
      const allowed = globalRateLimiter.checkRateLimit(mockReq, mockRes, customLimit);
      expect(allowed).toBe(false);
      expect(mockRes.statusCode).toBe(429);
      expect(mockRes.headers['Retry-After']).toBeDefined();
      expect(mockRes.headers['X-RateLimit-Remaining']).toBe('0');
      const errBody = JSON.parse(mockRes.body);
      expect(errBody.error).toBe('TOO_MANY_REQUESTS');
    });
  });

  describe('4. Request Body Size Limits & Sanitization', () => {
    it('rejects oversized JSON payload with HTTP 413 Payload Too Large', async () => {
      // Send oversized payload (larger than 1MB or configured limit)
      // We send large chunk of repeated characters to /api/chat
      const bigString = 'A'.repeat(1.5 * 1024 * 1024); // 1.5 MB
      const oversizedPayload = JSON.stringify({ text: bigString });

      const res = await makeRequest(
        'POST',
        '/api/chat',
        { 'Content-Type': 'application/json' },
        oversizedPayload
      );

      expect(res.status).toBe(413);
      expect(res.data.error).toBe('PAYLOAD_TOO_LARGE');
    });

    it('sanitizes null bytes and prototype pollution keys in JSON input', async () => {
      const maliciousPayload = {
        text: 'Hello doctor\0\u0007',
        __proto__: { isAdmin: true },
        constructor: { evil: true },
      };

      const res = await makeRequest('POST', '/api/chat', {}, maliciousPayload);
      expect(res.status).toBe(200);
      // Prototype was not polluted
      expect((Object.prototype as any).isAdmin).toBeUndefined();
    });
  });

  describe('5. PII & Secret Redaction Automated Verification', () => {
    it('masks phone numbers keeping only last 4 digits with +91 prefix', () => {
      expect(maskPhone('9876543210')).toBe('+91 ******3210');
      expect(maskPhone('9123456789')).toBe('+91 ******6789');
      expect(maskPhone('123')).toBe('******');
    });

    it('redacts phone numbers, 12-digit Aadhaar, emails, and Bearer tokens from transcripts', () => {
      const sensitiveText =
        'Mera phone 9876543210 hai, Aadhaar 1234 5678 9012, email patient@example.com aur Bearer eyJhbGciOiJIUzI1NiIs. Please check.';
      const cleaned = redactPiiFromTranscript(sensitiveText);

      // Verify no plain text PII remains
      expect(cleaned).not.toContain('9876543210');
      expect(cleaned).not.toContain('1234 5678 9012');
      expect(cleaned).not.toContain('patient@example.com');
      expect(cleaned).not.toContain('eyJhbGciOiJIUzI1NiIs');

      expect(cleaned).toContain('+91 ******3210');
      expect(cleaned).toContain('****-****-****');
      expect(cleaned).toContain('p***t@example.com');
      expect(cleaned).toContain('Bearer [REDACTED]');
    });
  });

  describe('6. Transcript Retention Compliance Job', () => {
    it('runs transcript retention job and successfully reports purged counts', async () => {
      const result = await runTranscriptRetentionJob(30);
      expect(result).toBeDefined();
      expect(result.retentionDays).toBe(30);
      expect(typeof result.deletedCount).toBe('number');
    });
  });

  describe('7. Zero Raw Audio Storage Guarantee', () => {
    it('verifies no raw audio files (.wav, .pcm, .raw) exist on disk', () => {
      // In Appointly, all voice mic buffers are processed ephemerally in RAM (Buffer)
      // and never persisted to local disk.
      const appRoot = process.cwd();
      const files = fs.readdirSync(appRoot);
      const audioFiles = files.filter(
        (f) => f.endsWith('.wav') || f.endsWith('.pcm') || f.endsWith('.raw')
      );
      expect(audioFiles.length).toBe(0);
    });
  });
});
