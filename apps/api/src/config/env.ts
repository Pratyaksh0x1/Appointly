import { envSchema, EnvConfig } from '@appointly/shared';
import dotenv from 'dotenv';
import path from 'path';

// Load .env from project root or current working directory
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config();

export function validateEnv(rawEnv: NodeJS.ProcessEnv = process.env): EnvConfig {
  const parsed = envSchema.safeParse(rawEnv);

  if (!parsed.success) {
    const errorMessages = parsed.error.issues.map((issue) => {
      return `  - ${issue.path.join('.')}: ${issue.message}`;
    });

    console.error('\n❌ [Appointly Startup Error] Invalid environment configuration:');
    console.error(errorMessages.join('\n'));
    console.error('\nPlease check your .env file against .env.example.\n');
    throw new Error('Environment configuration validation failed');
  }

  return parsed.data;
}

let cachedEnv: EnvConfig | null = null;

export function getEnv(): EnvConfig {
  if (!cachedEnv) {
    const fallbackEnv = { ...process.env };
    if (!fallbackEnv.GNANI_API_KEY) fallbackEnv.GNANI_API_KEY = 'mock_gnani_key';
    if (!fallbackEnv.EVON_API_KEY) fallbackEnv.EVON_API_KEY = 'mock_evon_key';
    cachedEnv = validateEnv(fallbackEnv);
  }
  return cachedEnv;
}

export function getSafePublicConfig() {
  const env = getEnv();
  return {
    PORT: env.PORT,
    NODE_ENV: env.NODE_ENV,
    GNANI_STT_MODEL: env.GNANI_STT_MODEL,
    GNANI_STT_LANGUAGE: env.GNANI_STT_LANGUAGE,
    GNANI_TTS_MODEL: env.GNANI_TTS_MODEL,
    GNANI_TTS_VOICE: env.GNANI_TTS_VOICE,
    EVON_MODEL: env.EVON_MODEL,
    USE_MOCK_SERVICES: env.USE_MOCK_SERVICES,
    TOTAL_CREDIT_BUDGET: env.TOTAL_CREDIT_BUDGET,
  };
}

export { EnvConfig };
