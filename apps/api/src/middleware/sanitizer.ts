/**
 * Input Sanitization & Request Size Limiter Middleware
 * Enforces strict request body size limits (HTTP 413) and sanitizes JSON input
 * against prototype pollution, control characters, and injection vectors.
 */

import http from 'http';
import { getEnv } from '../config/env.js';

export function sanitizeString(val: string): string {
  if (!val || typeof val !== 'string') return '';
  return val
    .replace(/\0/g, '') // Strip null bytes
    .replace(/[\u0000-\u0008\u000B-\u000C\u000E-\u001F]/g, '') // Strip ASCII control chars
    .trim();
}

export function sanitizeObject<T>(input: T): T {
  if (typeof input === 'string') {
    return sanitizeString(input) as unknown as T;
  }
  if (Array.isArray(input)) {
    return input.map((item) => sanitizeObject(item)) as unknown as T;
  }
  if (input !== null && typeof input === 'object') {
    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      // Prototype pollution defense
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        continue;
      }
      cleaned[sanitizeString(key)] = sanitizeObject(value);
    }
    return cleaned as unknown as T;
  }
  return input;
}

export interface ReadBodyResult<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  statusCode?: number;
}

export async function readAndSanitizeJsonBody<T = any>(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  maxBytes?: number
): Promise<ReadBodyResult<T>> {
  const env = getEnv();
  const limit = maxBytes || env.MAX_REQUEST_SIZE_BYTES || 1048576; // 1MB default

  const contentLength = parseInt((req.headers['content-length'] as string) || '0', 10);
  if (contentLength > limit) {
    res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'PAYLOAD_TOO_LARGE',
        message: `Request entity exceeds maximum allowable size of ${limit} bytes.`,
      })
    );
    return { success: false, statusCode: 413, error: 'PAYLOAD_TOO_LARGE' };
  }

  return new Promise<ReadBodyResult<T>>((resolve) => {
    let raw = '';
    let receivedBytes = 0;
    let isAborted = false;

    req.on('data', (chunk) => {
      if (isAborted) return;
      receivedBytes += chunk.length;
      if (receivedBytes > limit) {
        isAborted = true;
        req.destroy();
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'PAYLOAD_TOO_LARGE',
            message: `Request stream exceeded maximum size of ${limit} bytes.`,
          })
        );
        resolve({ success: false, statusCode: 413, error: 'PAYLOAD_TOO_LARGE' });
        return;
      }
      raw += chunk;
    });

    req.on('end', () => {
      if (isAborted) return;
      if (!raw.trim()) {
        resolve({ success: true, data: {} as T });
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        const sanitized = sanitizeObject(parsed);
        resolve({ success: true, data: sanitized });
      } catch (err: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: 'MALFORMED_JSON',
            message: 'Invalid JSON payload received in request body.',
          })
        );
        resolve({ success: false, statusCode: 400, error: 'MALFORMED_JSON' });
      }
    });

    req.on('error', (err) => {
      if (isAborted) return;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'STREAM_ERROR', message: String(err.message || err) }));
      resolve({ success: false, statusCode: 400, error: 'STREAM_ERROR' });
    });
  });
}
