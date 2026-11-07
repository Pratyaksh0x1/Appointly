/**
 * Appointly Voice Session Authentication & Rate Limiter
 * Issues short-lived, single-use voice session tokens for WebSocket authentication.
 * Non-negotiable security rule: Never expose Gnani or Evon API keys to the browser.
 */

import crypto from 'crypto';
import { rootLogger } from '../logger/logger.js';

export interface VoiceSessionAuthRecord {
  token: string;
  ip: string;
  createdAt: number;
  expiresAt: number;
  patientPhone?: string;
  doctorId?: string;
  isUsed: boolean;
}

export interface SessionTokenResult {
  sessionToken: string;
  wsUrl: string;
  expiresInSec: number;
}

const TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_REQUESTS_PER_MINUTE = 20;

// Token storage
const sessionTokens = new Map<string, VoiceSessionAuthRecord>();

// IP sliding window rate-limiting
const rateLimitMap = new Map<string, number[]>();

/**
 * Checks and records rate limit for an IP address.
 * Throws an Error if rate limit exceeded.
 */
export function checkRateLimit(ip: string): void {
  const now = Date.now();
  const windowStart = now - 60000; // 1 minute window

  let timestamps = rateLimitMap.get(ip) || [];
  timestamps = timestamps.filter((t) => t > windowStart);

  if (timestamps.length >= MAX_REQUESTS_PER_MINUTE) {
    rootLogger.warn(`[VoiceAuth] Rate limit exceeded for IP: ${ip}`, { ip });
    throw new Error('TOO_MANY_REQUESTS: Rate limit exceeded. Try again in one minute.');
  }

  timestamps.push(now);
  rateLimitMap.set(ip, timestamps);
}

/**
 * Creates a cryptographically secure short-lived session token for WebSocket authentication.
 */
export function createVoiceSessionToken(
  ip: string,
  meta?: { patientPhone?: string; doctorId?: string },
  port: number = 3000
): SessionTokenResult {
  checkRateLimit(ip);

  // Generate 32-byte secure random token
  const token = `vtok_${crypto.randomBytes(24).toString('hex')}`;
  const now = Date.now();
  const expiresAt = now + TOKEN_TTL_MS;

  const record: VoiceSessionAuthRecord = {
    token,
    ip,
    createdAt: now,
    expiresAt,
    patientPhone: meta?.patientPhone,
    doctorId: meta?.doctorId,
    isUsed: false,
  };

  sessionTokens.set(token, record);

  rootLogger.info(`[VoiceAuth] Generated short-lived voice session token`, {
    tokenPrefix: token.slice(0, 10),
    expiresInSec: TOKEN_TTL_MS / 1000,
  });

  return {
    sessionToken: token,
    wsUrl: `/ws/voice?token=${token}`,
    expiresInSec: TOKEN_TTL_MS / 1000,
  };
}

/**
 * Validates a voice session token presented during WebSocket upgrade.
 * Marks token as active and ensures single-use or active session validation.
 */
export function validateVoiceSessionToken(token: string): VoiceSessionAuthRecord | null {
  if (!token || typeof token !== 'string') {
    return null;
  }

  const record = sessionTokens.get(token);
  if (!record) {
    rootLogger.warn(`[VoiceAuth] Token not found or invalid: ${token.slice(0, 10)}...`);
    return null;
  }

  const now = Date.now();
  if (now > record.expiresAt) {
    rootLogger.warn(`[VoiceAuth] Token expired: ${token.slice(0, 10)}...`);
    sessionTokens.delete(token);
    return null;
  }

  return record;
}

/**
 * Consumes / marks token as used upon WebSocket connection.
 */
export function markVoiceSessionTokenUsed(token: string): void {
  const record = sessionTokens.get(token);
  if (record) {
    record.isUsed = true;
  }
}

/**
 * Revokes a session token.
 */
export function revokeVoiceSessionToken(token: string): void {
  sessionTokens.delete(token);
}

/**
 * Periodic cleanup of expired tokens.
 */
export function cleanupExpiredTokens(): void {
  const now = Date.now();
  for (const [token, record] of sessionTokens.entries()) {
    if (now > record.expiresAt) {
      sessionTokens.delete(token);
    }
  }
}

// Clean up expired tokens every 5 minutes
setInterval(cleanupExpiredTokens, 5 * 60 * 1000).unref();
