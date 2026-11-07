/**
 * Security Headers & CORS Allowlist Middleware
 * Applies strict enterprise security headers (CSP, HSTS, X-Frame-Options, etc.)
 * and validates origins against configured CORS allowlists.
 */

import http from 'http';
import { getEnv } from '../config/env.js';

export function applySecurityHeaders(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const env = getEnv();

  // 1. Strict Security Headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');

  // HSTS (enable in production and HTTPS environments)
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

  // Content Security Policy
  const cspDirectives = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://accounts.google.com https://cdn.tailwindcss.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "connect-src 'self' ws: wss: https:",
    "font-src 'self'",
    "frame-src 'self' https://accounts.google.com",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
  res.setHeader('Content-Security-Policy', cspDirectives);

  // 2. CORS Allowlist Validation
  const allowedOrigins = (env.CORS_ORIGIN || '*').split(',').map((o) => o.trim().toLowerCase());

  const originHeader = req.headers.origin;

  if (allowedOrigins.includes('*') || !originHeader) {
    res.setHeader('Access-Control-Allow-Origin', originHeader || '*');
  } else {
    const originLower = originHeader.toLowerCase();
    const isAllowed = allowedOrigins.some((allowed) => allowed === originLower || allowed === '*');

    if (isAllowed) {
      res.setHeader('Access-Control-Allow-Origin', originHeader);
      res.setHeader('Vary', 'Origin');
    } else {
      // Origin not permitted
      res.setHeader('Access-Control-Allow-Origin', allowedOrigins[0] || 'null');
    }
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, Idempotency-Key, X-Idempotency-Key, X-Request-ID, X-Call-ID'
  );
  res.setHeader('Access-Control-Max-Age', '86400'); // 24-hour preflight cache

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true; // request handled
  }

  return false;
}
