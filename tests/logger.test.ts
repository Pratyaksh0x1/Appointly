import { describe, it, expect } from 'vitest';
import { maskPhone, maskName, sanitizeData } from '../src/logger/logger.js';

describe('Structured JSON Logger & PII Sanitizer', () => {
  it('should mask 10-digit Indian phone numbers', () => {
    expect(maskPhone('9876543210')).toBe('+91 ******3210');
    expect(maskPhone('+91 98765 43210')).toBe('+91 ******3210');
    expect(maskPhone('09876543210')).toBe('+91 ******3210');
  });

  it('should mask patient names', () => {
    expect(maskName('Rahul Sharma')).toBe('R**** S*****');
    expect(maskName('Sunita')).toBe('S*****');
  });

  it('should redact sensitive secret keys and PII in objects', () => {
    const rawData = {
      apiKey: 'gnani_secret_token_12345',
      userPassword: 'myPassword!',
      patientPhone: '9876543210',
      patientName: 'Pooja Joshi',
      nested: {
        authToken: 'bearer xyz',
        phone: '9123456789',
      },
    };

    const clean = sanitizeData(rawData) as Record<string, unknown>;
    expect(clean.apiKey).toBe('[REDACTED]');
    expect(clean.userPassword).toBe('[REDACTED]');
    expect(clean.patientPhone).toBe('+91 ******3210');
    expect(clean.patientName).toBe('P**** J****');

    const nested = clean.nested as Record<string, unknown>;
    expect(nested.authToken).toBe('[REDACTED]');
    expect(nested.phone).toBe('+91 ******6789');
  });

  it('should redact inline phone numbers inside raw text strings', () => {
    const text = 'User called from 9876543210 regarding slot availability';
    const clean = sanitizeData(text);
    expect(clean).toBe('User called from +91 ******3210 regarding slot availability');
  });
});
