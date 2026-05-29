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

  // Deprecated template composer (apps/api/src/engine/recipe-templates.ts) that
  // produced semantically nonsense combinations like "cucumber baked with
  // coconut oil". Off by default; the curation queue (Phase D of the
  // recipe-curation pipeline) replaces it. Set to "true" to restore the old
  // behaviour as a temporary escape hatch.
  RECIPE_COMPOSER_ENABLED: boolFromString,
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
