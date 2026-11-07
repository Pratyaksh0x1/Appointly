/**
 * Idempotency Middleware
 * Guarantees that mutating endpoints (POST, PUT, DELETE) executed with an
 * `Idempotency-Key` or `X-Idempotency-Key` header return identical cached responses
 * without re-executing side effects or double-booking.
 */

import http from 'http';
import { rootLogger } from '../logger/logger.js';

export interface IdempotencyEntry {
  status: 'IN_PROGRESS' | 'COMPLETED';
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: string;
  createdAt: number;
}

export class IdempotencyStore {
  private cache = new Map<string, IdempotencyEntry>();
  private ttlMs: number;

  constructor(ttlMs = 24 * 60 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  public get(key: string): IdempotencyEntry | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }
    return entry;
  }

  public setInProgress(key: string): void {
    this.cache.set(key, {
      status: 'IN_PROGRESS',
      statusCode: 200,
      headers: {},
      body: '',
      createdAt: Date.now(),
    });
  }

  public setCompleted(
    key: string,
    statusCode: number,
    headers: Record<string, string | string[]>,
    body: string
  ): void {
    this.cache.set(key, {
      status: 'COMPLETED',
      statusCode,
      headers,
      body,
      createdAt: Date.now(),
    });
  }

  public delete(key: string): void {
    this.cache.delete(key);
  }

  public clear(): void {
    this.cache.clear();
  }
}

export const globalIdempotencyStore = new IdempotencyStore();

export function getIdempotencyKey(req: http.IncomingMessage): string | undefined {
  const header = req.headers['idempotency-key'] || req.headers['x-idempotency-key'];
  return typeof header === 'string' ? header.trim() : undefined;
}

/**
 * Checks if the request is idempotent and replays cached response if available.
 * Returns true if request was handled from cache or conflict; false if processing should proceed.
 */
export function handleIdempotencyPreRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): boolean {
  const key = getIdempotencyKey(req);
  if (!key) return false;

  const existing = globalIdempotencyStore.get(key);
  if (!existing) {
    globalIdempotencyStore.setInProgress(key);
    attachIdempotencyRecorder(key, res);
    return false;
  }

  if (existing.status === 'IN_PROGRESS') {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'IDEMPOTENCY_IN_FLIGHT',
        message:
          'A request with this idempotency key is currently in flight. Please retry shortly.',
      })
    );
    return true;
  }

  // Replay cached response
  rootLogger.info(`[Idempotency] Replaying cached response for key: ${key}`);
  for (const [hName, hVal] of Object.entries(existing.headers)) {
    if (hVal !== undefined) {
      res.setHeader(hName, hVal);
    }
  }
  res.setHeader('X-Cache-Lookup', 'HIT');
  res.setHeader('X-Idempotency-Replay', 'true');
  res.writeHead(existing.statusCode);
  res.end(existing.body);
  return true;
}

function attachIdempotencyRecorder(key: string, res: http.ServerResponse): void {
  const originalWriteHead = res.writeHead;
  const originalWrite = res.write;
  const originalEnd = res.end;

  let capturedStatusCode = 200;
  let capturedBody = '';

  res.writeHead = function (this: http.ServerResponse, ...args: any[]): http.ServerResponse {
    if (typeof args[0] === 'number') {
      capturedStatusCode = args[0];
    }
    return originalWriteHead.apply(this, args as any);
  };

  res.write = function (this: http.ServerResponse, ...args: any[]): boolean {
    if (args[0]) {
      capturedBody += Buffer.isBuffer(args[0]) ? args[0].toString('utf8') : String(args[0]);
    }
    return originalWrite.apply(this, args as any);
  };

  res.end = function (this: http.ServerResponse, ...args: any[]): http.ServerResponse {
    if (args[0]) {
      capturedBody += Buffer.isBuffer(args[0]) ? args[0].toString('utf8') : String(args[0]);
    }

    // Capture response headers
    const rawHeaders = res.getHeaders();
    const capturedHeaders: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(rawHeaders)) {
      if (typeof v === 'string' || Array.isArray(v)) {
        capturedHeaders[k] = v;
      } else if (typeof v === 'number') {
        capturedHeaders[k] = String(v);
      }
    }

    // Only cache successful or intentional 4xx client outcomes, not 500 transient errors
    if (capturedStatusCode < 500) {
      globalIdempotencyStore.setCompleted(key, capturedStatusCode, capturedHeaders, capturedBody);
    } else {
      globalIdempotencyStore.delete(key);
    }

    return originalEnd.apply(this, args as any);
  };
}
