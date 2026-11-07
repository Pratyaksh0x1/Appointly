/**
 * Rate Limiting Middleware (Sliding Window)
 * Supports per-IP and per-session rate limits with standard HTTP response headers.
 */

import http from 'http';
import { getEnv } from '../config/env.js';

interface RateLimitRecord {
  timestamps: number[];
}

export class SlidingWindowRateLimiter {
  private ipWindows = new Map<string, RateLimitRecord>();
  private sessionWindows = new Map<string, RateLimitRecord>();
  private windowMs: number;
  private defaultMaxPerMinute: number;

  constructor(windowMs = 60000, defaultMaxPerMinute = 120) {
    this.windowMs = windowMs;
    this.defaultMaxPerMinute = defaultMaxPerMinute;
  }

  public checkRateLimit(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    customLimit?: number
  ): boolean {
    const env = getEnv();
    const limit = customLimit || env.RATE_LIMIT_MAX_PER_MINUTE || this.defaultMaxPerMinute;
    const now = Date.now();
    const windowStart = now - this.windowMs;

    // 1. Identify Client Key (IP and optional Session/Doctor token)
    const rawIp =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.socket.remoteAddress ||
      '127.0.0.1';

    const authHeader = req.headers.authorization || '';
    const sessionToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : undefined;

    // 2. Check IP Rate Limit
    let ipRecord = this.ipWindows.get(rawIp);
    if (!ipRecord) {
      ipRecord = { timestamps: [] };
      this.ipWindows.set(rawIp, ipRecord);
    }
    // Prune stale timestamps
    ipRecord.timestamps = ipRecord.timestamps.filter((t) => t > windowStart);

    // 3. Check Session Rate Limit if session present
    let sessionRecord: RateLimitRecord | undefined = undefined;
    if (sessionToken) {
      sessionRecord = this.sessionWindows.get(sessionToken);
      if (!sessionRecord) {
        sessionRecord = { timestamps: [] };
        this.sessionWindows.set(sessionToken, sessionRecord);
      }
      sessionRecord.timestamps = sessionRecord.timestamps.filter((t) => t > windowStart);
    }

    const currentIpCount = ipRecord.timestamps.length;
    const currentSessionCount = sessionRecord ? sessionRecord.timestamps.length : 0;
    const effectiveCount = Math.max(currentIpCount, currentSessionCount);
    const remaining = Math.max(0, limit - effectiveCount - 1);
    const resetTimeSeconds = Math.ceil((now + this.windowMs) / 1000);

    // Set standard rate limit headers
    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(resetTimeSeconds));

    if (effectiveCount >= limit) {
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': String(Math.ceil(this.windowMs / 1000)),
      });
      res.end(
        JSON.stringify({
          error: 'TOO_MANY_REQUESTS',
          message: 'Too many requests. Please slow down and try again later.',
          retryAfterSeconds: Math.ceil(this.windowMs / 1000),
        })
      );
      return false; // Rate limit exceeded, request halted
    }

    // Record request timestamp
    ipRecord.timestamps.push(now);
    if (sessionRecord) {
      sessionRecord.timestamps.push(now);
    }

    return true; // Allowed
  }

  public reset(): void {
    this.ipWindows.clear();
    this.sessionWindows.clear();
  }
}

export const globalRateLimiter = new SlidingWindowRateLimiter();
