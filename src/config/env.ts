import { z } from 'zod';

/**
 * Environment validation. The application refuses to start unless all required
 * variables are present. This prevents silent misconfiguration in production.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),

  // Always boots: if DATABASE_URL is missing/unresolved the app still starts with
  // an unreachable placeholder, and /status reports database:false (instead of
  // crash-looping invisibly).
  DATABASE_URL: z
    .string()
    .min(1)
    .default('postgresql://invalid:invalid@127.0.0.1:5432/invalid'),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  // 'inline' needs no Redis (default when REDIS_URL is unset/localhost). 'redis'
  // uses a durable BullMQ queue. Leave unset to auto-detect.
  QUEUE_DRIVER: z.enum(['redis', 'inline']).optional(),

  // Not strictly required to BOOT — a partially-configured deploy still starts so
  // /status can report what's missing (instead of crash-looping invisibly).
  OWNER_WHATSAPP_NUMBER: z.string().optional().default(''),
  // The HUMAN owner's name (Miron). NOT the assistant's name — the assistant is
  // called פליי. Keep these distinct so the assistant never calls the owner פליי.
  OWNER_NAME: z.string().default('מירון'),
  OWNER_TIMEZONE: z.string().default('Asia/Jerusalem'),
  OWNER_LANGUAGE: z.string().default('he'),

  WHATSAPP_VERIFY_TOKEN: z.string().optional().default(''),
  WHATSAPP_ACCESS_TOKEN: z.string().optional().default(''),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional().default(''),
  WHATSAPP_BUSINESS_ACCOUNT_ID: z.string().optional().default(''),
  META_APP_SECRET: z.string().optional().default(''),
  META_APP_ID: z.string().optional().default(''),

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
  // Cost tiering: cheap model for routine planning, heavy model for hard tasks
  // and document drafting. Planner escalates light->heavy only when needed.
  ANTHROPIC_MODEL_LIGHT: z.string().default('claude-haiku-4-5-20251001'),
  ANTHROPIC_MODEL_HEAVY: z.string().default('claude-sonnet-4-6'),

  // Planner router: when true, a cheap classification call picks a per-intent
  // specialist; otherwise every message uses the general monolith (zero change).
  // ON by default now that the split is proven; set the env var to 'false' to
  // roll back. NOTE: z.coerce.boolean() treats any non-empty string (incl.
  // "false") as true, so compare explicitly instead.
  PLANNER_ROUTER_ENABLED: z
    .string()
    .optional()
    .default('true')
    .transform((v) => v === 'true' || v === '1'),

  // Web research sub-agent. 'none' (default) keeps web_research disabled and the
  // planner falls back to assume/ask. Set a provider + its key to enable real
  // web search. Brave and Tavily both return cheap JSON; pick whichever you have.
  WEB_SEARCH_PROVIDER: z.enum(['none', 'brave', 'tavily']).default('none'),
  BRAVE_SEARCH_API_KEY: z.string().optional().default(''),
  TAVILY_API_KEY: z.string().optional().default(''),

  // Admin dashboard guard. When set, /admin requires this token (HTTP Basic
  // password, Bearer header, or ?token=). Left empty → dashboard stays open
  // (no lock-out for existing setups). Set it in production to protect PII.
  ADMIN_TOKEN: z.string().optional().default(''),

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

  // Neutralise unresolved Railway/Render variable references (e.g.
  // "${{Redis.REDIS_URL}}") so the app still boots and /status can report the
  // problem, instead of crash-looping with a cryptic URL parse error.
  // Normalise unresolved references ("${{...}}") AND empty strings so Zod
  // defaults apply (an unresolved Railway reference resolves to ""). Without
  // this the app crash-loops on an empty DATABASE_URL/REDIS_URL.
  const unresolved: string[] = [];
  for (const [k, v] of Object.entries(process.env)) {
    const isUnresolved = typeof v === 'string' && v.includes('${{');
    const isEmpty = v === '';
    if (!isUnresolved && !isEmpty) continue;
    if (isUnresolved) unresolved.push(k);
    if (k === 'DATABASE_URL') {
      // Prisma reads process.env.DATABASE_URL directly, so keep it a parseable
      // (but unreachable) URL; /status will report database:false.
      process.env.DATABASE_URL = 'postgresql://invalid:invalid@127.0.0.1:5432/invalid';
    } else {
      delete process.env[k]; // let the Zod default take over
    }
  }
  if (unresolved.length) {
    // eslint-disable-next-line no-console
    console.error(
      `\n[env] Unresolved variable reference(s): ${unresolved.join(', ')}. ` +
        `The referenced service is missing or named differently ` +
        `(e.g. add a "Redis" service). Continuing with defaults so /status works.\n`,
    );
  }

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
