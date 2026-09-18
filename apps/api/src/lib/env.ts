import { z } from 'zod';

/**
 * Environment Configuration with Zod Validation
 *
 * Validates all environment variables at startup.
 * Fails fast with clear error messages if configuration is invalid.
 */

// ============================================
// Environment Schema
// ============================================

const envSchema = z.object({
  // Node environment
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // API Server — Railway injects PORT; fall back to API_PORT or 3001
  API_PORT: z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .default(Number(process.env.PORT) || 3001),
  API_HOST: z.string().default('0.0.0.0'),
  // Comma-separated list of allowed origins, e.g.
  // "http://localhost:3000,http://localhost:5174"
  CORS_ORIGIN: z.string().default('http://localhost:3000'),

  // Database
  DATABASE_URL: z
    .string()
    .refine(
      (url) =>
        url.startsWith('postgresql://') ||
        url.startsWith('postgres://') ||
        url.startsWith('file://') ||
        url.startsWith('file:'),
      'DATABASE_URL must be a valid PostgreSQL or SQLite connection string'
    ),

  // Redis (optional in development – omit to run API without Redis for Chat only)
  REDIS_URL: z.string().optional().default(''),

  // S3-compatible Storage (required for audio file storage)
  S3_BUCKET: z.string().min(1),
  S3_REGION: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_ENDPOINT: z.string().url().optional(),

  // AI Services
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  TRANSCRIPTION_PROVIDER: z.enum(['deepgram', 'openai', 'whisper-local', 'mock']).default('openai'),
  /** ISO 639-1 hint (e.g. ko, hi). Omit to let the provider auto-detect. */
  TRANSCRIPTION_LANGUAGE: z
    .string()
    .regex(/^[a-z]{2}(-[A-Z]{2})?$/)
    .optional(),
  /** When false, ignore iOS on-device transcripts and always use cloud STT. */
  USE_CLIENT_TRANSCRIPT: z.coerce.boolean().default(false),
  DEBRIEF_PROVIDER: z.enum(['openai', 'claude']).default('claude'),
  DEEPGRAM_API_KEY: z.string().min(1).optional(),

  // Local Whisper (optional)
  WHISPER_MODEL_PATH: z.string().optional(),
  WHISPER_BINARY_PATH: z.string().optional(),

  // Diarization Service (optional - required for voice profile enrollment)
  DIARIZATION_SERVICE_URL: z.string().url().optional(),

  // Rate Limiting
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),

  // Upload Limits
  MAX_UPLOAD_SIZE_MB: z.coerce.number().int().positive().default(500),

  // Optional server-side transcoding (for MediaRecorder webm/ogg compatibility)
  ENABLE_FFMPEG_TRANSCODE: z.coerce.boolean().default(false),
  TESTER_UIDS: z.string().optional(), // comma-separated Firebase UIDs with unlimited PRO access

  // Sentry (optional)
  SENTRY_DSN: z.string().url().optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),

  // OpenTelemetry (optional)
  OTEL_ENABLED: z.coerce.boolean().default(false),
  OTEL_SERVICE_NAME: z.string().default('twin-api'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),

  // Firebase Auth (optional – omit to keep using x-user-id header)
  FIREBASE_PROJECT_ID: z.string().optional(),
  FIREBASE_SERVICE_ACCOUNT_JSON: z.string().optional(),

  // RevenueCat webhook authentication. Required in production because the
  // webhook controls server-side access to paid features.
  REVENUECAT_WEBHOOK_SECRET: z.string().min(1).optional(),
});

// ============================================
// Type Exports
// ============================================

export type Env = z.infer<typeof envSchema>;

// ============================================
// Validation
// ============================================

let validatedEnv: Env | null = null;

/**
 * Validate and parse environment variables
 * Call this at application startup
 */
export function validateEnv(): Env {
  if (validatedEnv) {
    return validatedEnv;
  }

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('❌ Environment validation failed:');
    console.error('');

    const errors = result.error.flatten();

    // Field errors
    for (const [field, messages] of Object.entries(errors.fieldErrors)) {
      console.error(`  ${field}:`);
      messages?.forEach((msg) => console.error(`    - ${msg}`));
    }

    // Form errors
    if (errors.formErrors.length > 0) {
      console.error('  General errors:');
      errors.formErrors.forEach((msg) => console.error(`    - ${msg}`));
    }

    console.error('');
    console.error('Please check your .env file and ensure all required variables are set.');
    process.exit(1);
  }

  // Additional validation for provider-specific requirements
  const env = result.data;

  if (env.NODE_ENV === 'production' && !env.REDIS_URL) {
    console.error('❌ REDIS_URL is required in production');
    process.exit(1);
  }

  if (env.NODE_ENV === 'production' && !env.FIREBASE_PROJECT_ID) {
    console.error('❌ FIREBASE_PROJECT_ID is required in production');
    console.error('Protected API routes cannot authenticate Firebase ID tokens without it.');
    process.exit(1);
  }

  if (env.NODE_ENV === 'production' && !env.REVENUECAT_WEBHOOK_SECRET) {
    console.error('❌ REVENUECAT_WEBHOOK_SECRET is required in production');
    console.error('Configure the same Authorization header value in the RevenueCat webhook.');
    process.exit(1);
  }

  if (env.TRANSCRIPTION_PROVIDER === 'deepgram' && !env.DEEPGRAM_API_KEY) {
    console.error('❌ DEEPGRAM_API_KEY is required when TRANSCRIPTION_PROVIDER=deepgram');
    process.exit(1);
  }

  validatedEnv = env;
  return env;
}

/**
 * Get validated environment (must call validateEnv first)
 */
export function getEnv(): Env {
  if (!validatedEnv) {
    return validateEnv();
  }
  return validatedEnv;
}

/**
 * Reset the cached environment. Intended for tests that mutate process.env.
 */
export function resetValidatedEnv(): void {
  validatedEnv = null;
}

/**
 * Check if running in production
 */
export function isProduction(): boolean {
  return getEnv().NODE_ENV === 'production';
}

/**
 * Check if running in development
 */
export function isDevelopment(): boolean {
  return getEnv().NODE_ENV === 'development';
}

/**
 * Check if running in test
 */
export function isTest(): boolean {
  return getEnv().NODE_ENV === 'test';
}
