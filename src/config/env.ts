import { z } from 'zod';

/**
 * Environment validation. The application refuses to start unless all required
 * variables are present. This prevents silent misconfiguration in production.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

  OWNER_WHATSAPP_NUMBER: z.string().min(5),
  OWNER_TIMEZONE: z.string().default('Asia/Jerusalem'),
  OWNER_LANGUAGE: z.string().default('he'),

  WHATSAPP_VERIFY_TOKEN: z.string().min(1),
  WHATSAPP_ACCESS_TOKEN: z.string().min(1),
  WHATSAPP_PHONE_NUMBER_ID: z.string().min(1),
  WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().optional().default(''),
  META_APP_SECRET: z.string().optional().default(''),

  GOOGLE_CLIENT_ID: z.string().optional().default(''),
  GOOGLE_CLIENT_SECRET: z.string().optional().default(''),
  GOOGLE_REDIRECT_URI: z
    .string()
    .optional()
    .default('http://localhost:3000/auth/google/callback'),
  GOOGLE_TOKEN_ENCRYPTION_KEY: z.string().min(16).default('dev_only_insecure_key_change_me!'),

  OPENAI_API_KEY: z.string().optional().default(''),
  ANTHROPIC_API_KEY: z.string().optional().default(''),
  AI_PLANNER_PROVIDER: z.enum(['anthropic', 'openai']).default('anthropic'),
  AI_TRANSCRIPTION_PROVIDER: z.enum(['openai']).default('openai'),
  AI_VISION_PROVIDER: z.enum(['openai']).default('openai'),

  STORAGE_PROVIDER: z.enum(['local', 'drive', 's3']).default('local'),
  LOCAL_STORAGE_PATH: z.string().default('./storage'),

  DAILY_PLAN_TIME: z.string().default('07:30'),
  MIDDAY_CHECKIN_TIME: z.string().default('13:00'),
  END_OF_DAY_TIME: z.string().default('18:30'),
});

export type AppEnv = z.infer<typeof envSchema>;

let cached: AppEnv | null = null;

export function loadEnv(): AppEnv {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    // eslint-disable-next-line no-console
    console.error(`\n[env] Invalid environment configuration:\n${issues}\n`);
    throw new Error('Environment validation failed. See logs above.');
  }
  cached = parsed.data;
  return cached;
}

export const env = (): AppEnv => loadEnv();
