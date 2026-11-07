import { z } from 'zod';
import dotenv from 'dotenv';

// Load .env into process.env before validation
dotenv.config();

const envSchema = z.object({
  PORT: z.string().default('3000').transform((val) => parseInt(val, 10)),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Database
  DATABASE_URL: z.string().default('postgres://postgres:postgres@localhost:5432/appointly'),
  USE_IN_MEMORY_DB: z.string().default('true').transform((val) => val === 'true'),

  // Gnani Speech APIs
  GNANI_API_KEY: z.string().min(1, 'GNANI_API_KEY must be provided (or use mock in test/dev)'),
  GNANI_STT_URL: z.string().url().default('https://api.vachana.ai/stt/v3'),
  GNANI_STT_WS_URL: z.string().url().default('wss://api.vachana.ai/stt/v3/stream'),
  GNANI_STT_MODEL: z.string().default('prisma-v3.0'),
  GNANI_STT_LANGUAGE: z.string().default('indic-auto'),

  // Gnani Timbre TTS
  GNANI_TTS_URL: z.string().url().default('https://api.vachana.ai/api/v1/tts/inference'),
  GNANI_TTS_SSE_URL: z.string().url().default('https://api.vachana.ai/api/v1/tts/sse'),
  GNANI_TTS_WS_URL: z.string().url().default('wss://api.vachana.ai/api/v1/tts'),
  GNANI_TTS_MODEL: z.string().default('timbre-v3.0'),
  GNANI_TTS_VOICE: z.string().default('Shivani'),
  GNANI_TTS_LANGUAGE: z.string().default('hi-IN'),
  GNANI_TTS_SPEED: z.string().default('1.0').transform((val) => parseFloat(val)),

  // Evon 30B LLM (Gnani open-weight Indic foundational model)
  // TODO(verify): Verify exact Gnani Evon 30B chat completion endpoint URL, model identifier string, and auth headers
  EVON_API_KEY: z.string().min(1, 'EVON_API_KEY must be provided (or mock)'),
  EVON_BASE_URL: z.string().url().default('https://api.vachana.ai/v1'),
  EVON_MODEL: z.string().default('evon-30b'),

  // Cost Management & Mock Mode
  USE_MOCK_SERVICES: z.string().default('false').transform((val) => val === 'true'),
  TOTAL_CREDIT_BUDGET: z.string().default('5000').transform((val) => parseInt(val, 10)),
  PER_CALL_CREDIT_LIMIT: z.string().default('50').transform((val) => parseInt(val, 10)),
  DAILY_CREDIT_LIMIT: z.string().default('2000').transform((val) => parseInt(val, 10)),

  // Retries & Timeouts
  HTTP_TIMEOUT_MS: z.string().default('8000').transform((val) => parseInt(val, 10)),
  MAX_RETRIES: z.string().default('3').transform((val) => parseInt(val, 10)),
  BACKOFF_BASE_MS: z.string().default('500').transform((val) => parseInt(val, 10)),
});

export type EnvConfig = z.infer<typeof envSchema>;

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

// Lazy-loaded validated environment
let cachedEnv: EnvConfig | null = null;

export function getEnv(): EnvConfig {
  if (!cachedEnv) {
    // For test runner safety, provide defaults if keys aren't set
    const fallbackEnv = { ...process.env };
    if (!fallbackEnv.GNANI_API_KEY) fallbackEnv.GNANI_API_KEY = 'mock_gnani_key';
    if (!fallbackEnv.EVON_API_KEY) fallbackEnv.EVON_API_KEY = 'mock_evon_key';
    cachedEnv = validateEnv(fallbackEnv);
  }
  return cachedEnv;
}

/**
 * Strips secrets so frontend/dashboard or logs cannot leak API keys
 */
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
