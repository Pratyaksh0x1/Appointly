import { z } from 'zod';

export const bookingInputSchema = z.object({
  doctorId: z.string().min(1, 'Doctor ID is required'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be formatted as YYYY-MM-DD'),
  startTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Start time must be formatted as HH:mm (e.g. 09:30)'),
  patientName: z.string().min(2, 'Patient name must be at least 2 characters'),
  patientPhone: z
    .string()
    .min(10, 'Patient phone must be at least 10 digits')
    .transform((val) => val.replace(/\D/g, '')),
  idempotencyKey: z.string().min(8, 'Idempotency key must be at least 8 characters'),
});

export const doctorScheduleUpdateSchema = z
  .object({
    workingHoursStart: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Start time must be formatted as HH:mm (e.g. 17:00)'),
    workingHoursEnd: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'End time must be formatted as HH:mm (e.g. 22:00)'),
    activeDays: z.array(z.string()).min(1, 'At least one active day must be specified'),
    durationMinutes: z.number().int().min(10).max(120).optional(),
    fee: z.number().min(0).optional(),
  })
  .refine(
    (data) => {
      const [sh, sm] = data.workingHoursStart.split(':').map((v) => parseInt(v, 10));
      const [eh, em] = data.workingHoursEnd.split(':').map((v) => parseInt(v, 10));
      return sh * 60 + sm < eh * 60 + em;
    },
    {
      message: 'workingHoursStart must be earlier than workingHoursEnd',
      path: ['workingHoursStart'],
    }
  );

export type DoctorScheduleUpdateInput = z.infer<typeof doctorScheduleUpdateSchema>;

export const callbackInputSchema = z.object({
  callId: z.string().min(1),
  patientPhone: z.string().min(10),
  reason: z.string().min(1),
  preferredSlot: z.string().optional(),
});

export const chatInputSchema = z.object({
  text: z.string().min(1, 'Text message is required'),
  callId: z
    .string()
    .optional()
    .default(() => `call_${Date.now()}`),
  phone: z.string().optional().default('9876543210'),
});

export const envSchema = z.object({
  PORT: z
    .string()
    .default('3000')
    .transform((val) => parseInt(val, 10)),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Neon PostgreSQL
  DATABASE_URL: z.string().default('postgres://postgres:postgres@localhost:5432/appointly'),
  DATABASE_URL_UNPOOLED: z.string().optional(),
  USE_IN_MEMORY_DB: z
    .string()
    .default('false')
    .transform((val) => val === 'true'),
  NEON_BRANCH: z.string().optional(),
  NEON_BRANCH_ID: z.string().optional(),
  NEON_FUNCTION_HOST_SUFFIX: z.string().optional(),

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
  GNANI_TTS_SPEED: z
    .string()
    .default('1.0')
    .transform((val) => parseFloat(val)),

  // Evon 30B LLM
  EVON_API_KEY: z.string().min(1, 'EVON_API_KEY must be provided (or mock)'),
  EVON_BASE_URL: z.string().url().default('https://api.vachana.ai/v1'),
  EVON_MODEL: z.string().default('evon-30b'),

  // Cost Management
  USE_MOCK_SERVICES: z
    .string()
    .default('false')
    .transform((val) => val === 'true'),
  TOTAL_CREDIT_BUDGET: z
    .string()
    .default('5000')
    .transform((val) => parseInt(val, 10)),
  PER_CALL_CREDIT_LIMIT: z
    .string()
    .default('50')
    .transform((val) => parseInt(val, 10)),
  DAILY_CREDIT_LIMIT: z
    .string()
    .default('2000')
    .transform((val) => parseInt(val, 10)),

  // Retries & Timeouts
  HTTP_TIMEOUT_MS: z
    .string()
    .default('8000')
    .transform((val) => parseInt(val, 10)),
  MAX_RETRIES: z
    .string()
    .default('3')
    .transform((val) => parseInt(val, 10)),
  BACKOFF_BASE_MS: z
    .string()
    .default('500')
    .transform((val) => parseInt(val, 10)),

  // Phase 8: Reliability & Security Hardening
  CORS_ORIGIN: z
    .string()
    .default('http://localhost:3000,http://127.0.0.1:3000,http://localhost:3099'),
  TRANSCRIPT_RETENTION_DAYS: z
    .string()
    .default('30')
    .transform((val) => parseInt(val, 10)),
  STORE_RAW_AUDIO: z
    .string()
    .default('false')
    .transform((val) => val === 'true'),
  RATE_LIMIT_MAX_PER_MINUTE: z
    .string()
    .default('120')
    .transform((val) => parseInt(val, 10)),
  MAX_REQUEST_SIZE_BYTES: z
    .string()
    .default('1048576')
    .transform((val) => parseInt(val, 10)),
});

export type EnvConfig = z.infer<typeof envSchema>;
