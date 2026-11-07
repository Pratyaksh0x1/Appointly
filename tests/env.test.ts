import { describe, it, expect } from 'vitest';
import { validateEnv, getSafePublicConfig } from '../src/config/env.js';

describe('Environment Validation', () => {
  it('should validate valid environment configuration', () => {
    const raw = {
      PORT: '4000',
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://user:pass@localhost:5432/testdb',
      USE_IN_MEMORY_DB: 'true',
      GNANI_API_KEY: 'test_gnani_key',
      EVON_API_KEY: 'test_evon_key',
      TOTAL_CREDIT_BUDGET: '5000',
    };

    const config = validateEnv(raw as unknown as NodeJS.ProcessEnv);
    expect(config.PORT).toBe(4000);
    expect(config.USE_IN_MEMORY_DB).toBe(true);
    expect(config.TOTAL_CREDIT_BUDGET).toBe(5000);
    expect(config.GNANI_STT_MODEL).toBe('prisma-v3.0');
    expect(config.GNANI_TTS_VOICE).toBe('Shivani');
  });

  it('should fail fast if required API keys are missing', () => {
    const raw = {
      GNANI_API_KEY: '',
    };
    expect(() => validateEnv(raw as unknown as NodeJS.ProcessEnv)).toThrow();
  });

  it('should strip secrets in getSafePublicConfig()', () => {
    const safeConfig = getSafePublicConfig();
    expect(safeConfig).not.toHaveProperty('GNANI_API_KEY');
    expect(safeConfig).not.toHaveProperty('EVON_API_KEY');
    expect(safeConfig).not.toHaveProperty('DATABASE_URL');
    expect(safeConfig).toHaveProperty('GNANI_TTS_VOICE');
    expect(safeConfig).toHaveProperty('TOTAL_CREDIT_BUDGET');
  });
});

