// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

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

  // OpenAPI/Swagger UI at /api/docs. Off in production by default (the schema
  // dump aids reconnaissance); operators opt in explicitly. Left unset, it
  // resolves to `true` outside production — see validateEnv.
  SWAGGER_ENABLED: z.enum(['true', 'false']).optional(),

  DATABASE_URL: z.string().url(),

  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  // Independent secret for the reviewer-session cookie. Optional: when unset it
  // falls back to JWT_ACCESS_SECRET. Set it to a distinct value so a leaked (or
  // rotated) user-access secret can't be used to forge reviewer cookies, and so
  // rotating one doesn't invalidate the other. See review/session.ts.
  REVIEWER_SESSION_SECRET: z.string().min(16).optional(),
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
  // F10 per-user monthly quota for `aiMode='admin'` users (rolling 30 days).
  // 'byok' and 'none' users do not consume this. Set to 0 to deny the admin
  // mode entirely without unsetting AI_DEFAULT_PROVIDER.
  AI_ADMIN_USER_MONTHLY_LIMIT: z.coerce.number().int().min(0).default(40),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  // Treat an empty string the same as "not set" so operators who don't run
  // Ollama can blank the var without tripping the URL validator.
  OLLAMA_BASE_URL: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().url().default('http://localhost:11434'),
  ),
  // Whether/how a user may point their own BYOK Ollama config at a host:
  //   off       — users can't configure Ollama (operator default still serves
  //               admin-mode users).
  //   allowlist — (default) only OLLAMA_BASE_URL's host + OLLAMA_ALLOWED_HOSTS.
  //   public    — any host except internal/private/loopback ranges.
  // See packages/shared OllamaUserPolicy and apps/api/src/ai/ollama-url.ts.
  OLLAMA_USER_POLICY: z.enum(['off', 'allowlist', 'public']).default('allowlist'),
  // SSRF allowlist for user-supplied Ollama base URLs (the `/ai/test` probe and
  // persisted BYOK configs) when OLLAMA_USER_POLICY=allowlist. Comma-separated
  // `host` or `host:port` entries. OLLAMA_BASE_URL's host is always allowed;
  // this only widens the set for operators who let users point BYOK elsewhere.
  OLLAMA_ALLOWED_HOSTS: z.string().optional(),

  // USDA FoodData Central importer (admin-triggered). `DEMO_KEY` is FDC's public
  // rate-limited key; operators set a real key for bulk imports.
  FDC_API_KEY: z.string().default('DEMO_KEY'),
  FDC_DATA_TYPES: z.string().default('Foundation'),

  // Override the curated `data/` directory location (tests / non-standard
  // layouts). Read by the non-DI CLI path helper `admin/seed/data-hash.ts`.
  SEED_DATA_DIR: z.string().optional(),

  TURNSTILE_ENABLED: boolFromString,
  // Public site key — safe to expose to the browser via GET /api/config. The
  // secret key never leaves the server.
  TURNSTILE_SITE_KEY: z.string().optional(),
  TURNSTILE_SECRET_KEY: z.string().optional(),

  RATE_LIMIT_WINDOW: z.coerce.number().int().default(60),
  RATE_LIMIT_MAX: z.coerce.number().int().default(120),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().default('no-reply@diet-app.local'),

  // Admin panel (F16). Fail-closed: when ADMIN_PASSWORD is empty or left at
  // the placeholder, every /api/admin/* route returns 403 — no JWT, no user.
  ADMIN_USER: z.string().default('admin'),
  ADMIN_PASSWORD: z.string().default(''),

  // Curation-queue ship mechanism.
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

  // "Pull ingredient overrides from a repo" — the reverse of the local ship.
  // The admin panel fetches a repo's `data/ingredient-overrides.json` and
  // applies the rows to the live DB as source=MANUAL. Read-only and
  // container-friendly (a plain HTTP fetch, no git working tree). The operator
  // types the repo in the UI; this is only the default prefill. Accepts an
  // `owner/repo[@branch]` (GitHub) or a full raw URL (e.g. gitea/gitlab).
  // Public repos need no auth; private GitHub repos use OVERRIDES_PULL_TOKEN.
  OVERRIDES_PULL_SOURCE: z.string().default('whiteravens20/diet-app'),
  // PAT for pulling from a PRIVATE repo. Only ever sent to GitHub hosts. Falls
  // back to SHIP_UPSTREAM_GH_TOKEN when unset.
  OVERRIDES_PULL_TOKEN: z.string().optional(),
});

/** Sentinel password meaning "admin panel disabled". Mirrors archivum-null. */
export const ADMIN_PASSWORD_PLACEHOLDER = 'CHANGE_ME_IMMEDIATELY';

/** Whether ADMIN_PASSWORD has been set to a real value. */
export function isAdminEnabled(env: Pick<Env, 'ADMIN_PASSWORD'>): boolean {
  const p = env.ADMIN_PASSWORD;
  return p.length > 0 && p !== ADMIN_PASSWORD_PLACEHOLDER;
}

// `SWAGGER_ENABLED` is parsed as an optional string flag but resolved to a
// firm boolean by validateEnv (NODE_ENV-aware default), so the runtime type
// the rest of the app sees is always a boolean.
export type Env = Omit<z.infer<typeof envSchema>, 'SWAGGER_ENABLED'> & {
  SWAGGER_ENABLED: boolean;
};

/**
 * Whether ConfigModule skips the env files on disk. A test run supplies its
 * whole environment explicitly, so a developer's own `.env` (a real SMTP host,
 * provider keys, the development database) can never reach a test.
 */
// eslint-disable-next-line no-restricted-syntax -- decides where configuration is read from, before ConfigService exists
export const IGNORE_ENV_FILES = process.env.NODE_ENV === 'test';

/** @nestjs/config `validate` hook. */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const { SWAGGER_ENABLED, ...rest } = result.data;
  return {
    ...rest,
    // Explicit flag wins; otherwise on everywhere except production.
    SWAGGER_ENABLED:
      SWAGGER_ENABLED !== undefined
        ? SWAGGER_ENABLED === 'true'
        : rest.NODE_ENV !== 'production',
  };
}
