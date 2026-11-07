import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { createServer } from '../src/index.js';
import { getDatabaseClient } from '../src/db/index.js';

describe('Health & Readiness Endpoints (/healthz & /readyz)', () => {
  let server: http.Server;
  const testPort = 3199;

  beforeAll(async () => {
    const db = getDatabaseClient();
    await db.initialize();
    server = createServer();
    await new Promise<void>((resolve) => server.listen(testPort, () => resolve()));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const get = (path: string): Promise<{ status?: number; data: any }> => {
    return new Promise((resolve, reject) => {
      http
        .get(`http://localhost:${testPort}${path}`, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            resolve({ status: res.statusCode, data: JSON.parse(body || '{}') });
          });
        })
        .on('error', reject);
    });
  };

  it('GET /healthz should return 200 with status ok', async () => {
    const res = await get('/healthz');
    expect(res.status).toBe(200);
    expect(res.data.status).toBe('ok');
    expect(res.data.time).toBeDefined();
    expect(typeof res.data.uptimeSeconds).toBe('number');
  });

  it('GET /readyz should return 200 with ready and database status', async () => {
    const res = await get('/readyz');
    expect(res.status).toBe(200);
    expect(res.data.status).toBe('ready');
    expect(res.data.database).toBeDefined();
    expect(res.data.doctorsLoaded).toBeGreaterThan(0);
  });
});
