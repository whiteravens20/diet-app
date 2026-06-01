/**
 * Environment validation. Parsed once at boot; a malformed env fails fast with
 * a clear message rather than surfacing as a runtime error later.
 */
import { z } from 'zod';

const boolFromString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  API_PORT: z.coerce.number().int().default(4000),
  APP_URL: z.string().url().default('http://localhost:3000'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  JWT_ACCESS_TTL: z.coerce.number().int().default(900),
  JWT_REFRESH_TTL: z.coerce.number().int().default(2_592_000),
  PASSWORD_HASH_ROUNDS: z.coerce.number().int().min(8).max(15).default(12),

  // 64 hex chars = 32 bytes for AES-256-GCM.
  AI_KEY_ENCRYPTION_SECRET: z.string().regex(/^[0-9a-fA-F]{64}$/, '64 hex chars required'),
  // Master secret for encrypting user PII at rest (email) and peppering
  // password hashes. Purpose-specific keys are HKDF-derived from it.
  DATA_ENCRYPTION_SECRET: z.string().regex(/^[0-9a-fA-F]{64}$/, '64 hex chars required'),

  AI_DEFAULT_PROVIDER: z.enum(['openai', 'anthropic', 'openrouter', 'ollama']).optional(),
  AI_DEFAULT_MODEL: z.string().optional(),
  // F10 per-user weekly quota for `aiMode='admin'` users (rolling 7 days).
  // 'byok' and 'none' users do not consume this. Set to 0 to deny the admin
  // mode entirely without unsetting AI_DEFAULT_PROVIDER.
  AI_ADMIN_USER_WEEKLY_LIMIT: z.coerce.number().int().min(0).default(10),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  // Treat an empty string the same as "not set" so operators who don't run
  // Ollama can blank the var without tripping the URL validator.
  OLLAMA_BASE_URL: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().url().default('http://localhost:11434'),
  ),

  TURNSTILE_ENABLED: boolFromString,
  TURNSTILE_SECRET_KEY: z.string().optional(),

  RATE_LIMIT_WINDOW: z.coerce.number().int().default(60),
  RATE_LIMIT_MAX: z.coerce.number().int().default(120),
  RATE_LIMIT_AI_MAX: z.coerce.number().int().default(20),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().default('no-reply@diet-app.local'),

  // Admin panel (F16). Fail-closed: when ADMIN_PASSWORD is empty or left at
  // the placeholder, every /api/admin/* route returns 403 — no JWT, no user.
  ADMIN_USER: z.string().default('admin'),
  ADMIN_PASSWORD: z.string().default(''),

  // Curation-queue ship mechanism (Phase E).
  //
  // Three ship modes are exposed by the curation queue: `local` (writes to
  // live DB tables with source=MANUAL + a gitignored sidecar file in
  // INSTANCE_DATA_DIR), `upstream-pr` (opens a gh-CLI PR — admin-controlled,
  // OFF by default), and `zip` (download a bundle behind a one-shot signed
  // token).
  //
  // `local` always available; `zip` always available; `upstream-pr` only
  // shown in the admin UI when SHIP_UPSTREAM_ENABLED=true AND a token + the
  // `gh` binary on PATH are present at runtime.
  INSTANCE_DATA_DIR: z.string().default('instance-data'),
  SHIP_UPSTREAM_ENABLED: boolFromString,
  SHIP_UPSTREAM_REMOTE: z.string().default('origin'),
  SHIP_UPSTREAM_BASE_BRANCH: z.string().default('main'),
  SHIP_UPSTREAM_GH_TOKEN: z.string().optional(),
  SHIP_UPSTREAM_GIT_AUTHOR_NAME: z.string().optional(),
  SHIP_UPSTREAM_GIT_AUTHOR_EMAIL: z.string().optional(),
  // Signs the zip-download one-shot tokens. Defaults reuse JWT_ACCESS_SECRET
  // when unset — the token has a 10-minute TTL so reuse is acceptable.
  SHIP_DOWNLOAD_TOKEN_SECRET: z.string().optional(),
});

/** Sentinel password meaning "admin panel disabled". Mirrors archivum-null. */
export const ADMIN_PASSWORD_PLACEHOLDER = 'CHANGE_ME_IMMEDIATELY';

/** Whether ADMIN_PASSWORD has been set to a real value. */
export function isAdminEnabled(env: Pick<Env, 'ADMIN_PASSWORD'>): boolean {
  const p = env.ADMIN_PASSWORD;
  return p.length > 0 && p !== ADMIN_PASSWORD_PLACEHOLDER;
}

export type Env = z.infer<typeof envSchema>;

/** @nestjs/config `validate` hook. */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
