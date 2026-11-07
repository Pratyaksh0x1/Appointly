import { describe, it, expect } from 'vitest';
import { maskPhone, maskName, sanitizeData, Logger } from '../src/logger/logger.js';

describe('Structured JSON Logger & Secret Redaction Engine', () => {
  it('should mask 10-digit Indian phone numbers', () => {
    expect(maskPhone('9876543210')).toBe('+91 ******3210');
    expect(maskPhone('+91 98765 43210')).toBe('+91 ******3210');
    expect(maskPhone('09876543210')).toBe('+91 ******3210');
  });

  it('should mask patient names', () => {
    expect(maskName('Rahul Sharma')).toBe('R**** S*****');
    expect(maskName('Sunita')).toBe('S*****');
  });

  it('ACCEPTANCE: should strictly redact sensitive secret keys, passwords, and API tokens', () => {
    const rawData = {
      apiKey: 'vach_secret_token_12345',
      api_key: 'sk_live_99887766',
      userPassword: 'mySuperSecretPassword!',
      authToken: 'Bearer secret_auth_token_abc',
      credential: 'secret_credential_value',
      access_token: 'jwt_token_xyz',
      patientPhone: '9876543210',
      patientName: 'Pooja Joshi',
      nested: {
        private_key: 'RSA_PRIVATE_KEY_CONTENTS',
        phone: '9123456789',
      },
    };

    const clean = sanitizeData(rawData) as Record<string, unknown>;
    expect(clean.apiKey).toBe('[REDACTED]');
    expect(clean.api_key).toBe('[REDACTED]');
    expect(clean.userPassword).toBe('[REDACTED]');
    expect(clean.authToken).toBe('[REDACTED]');
    expect(clean.credential).toBe('[REDACTED]');
    expect(clean.access_token).toBe('[REDACTED]');
    expect(clean.patientPhone).toBe('+91 ******3210');
    expect(clean.patientName).toBe('P**** J****');

    const nested = clean.nested as Record<string, unknown>;
    expect(nested.private_key).toBe('[REDACTED]');
    expect(nested.phone).toBe('+91 ******6789');
  });

  it('ACCEPTANCE: should redact inline phone numbers inside freeform raw text strings', () => {
    const text = 'User called from 9876543210 regarding slot availability';
    const clean = sanitizeData(text);
    expect(clean).toBe('User called from +91 ******3210 regarding slot availability');
  });

  it('ACCEPTANCE: formatLogEntry should format pino-style JSON with request_id and call_id', () => {
    const logger = new Logger('info', {
      call_id: 'call_live_123',
      request_id: 'req_live_456',
    });

    const entry = logger.formatLogEntry('info', 'Appointment booking processed', {
      apiKey: 'secret_key_123',
      patientPhone: '9876543210',
    });

    expect(entry.msg).toBe('Appointment booking processed');
    expect(entry.call_id).toBe('call_live_123');
    expect(entry.request_id).toBe('req_live_456');
    expect(entry.level).toBe(20);
    expect(entry.levelLabel).toBe('INFO');
    expect((entry.data as Record<string, unknown>).apiKey).toBe('[REDACTED]');
    expect((entry.data as Record<string, unknown>).patientPhone).toBe('+91 ******3210');
  });
});
