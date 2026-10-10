// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Environment validation. Parsed once at boot; a malformed env fails fast with
 * a clear message rather than surfacing as a runtime error later.
 *
 * A key that is present but blank counts as not set: env templates ship their
 * optional keys as `KEY=`, and such a line must mean "use the default", never
 * "the value is an empty string".
 */
import { z } from 'zod';

const boolFromString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  APP_URL: z.string().url().default('http://localhost:3000'),

  // OpenAPI/Swagger UI at /api/docs. Off in production by default (the schema
  // dump aids reconnaissance); operators opt in explicitly. Left unset, it
  // resolves to `true` outside production — see validateEnv.
  SWAGGER_ENABLED: z.enum(['true', 'false']).optional(),

  DATABASE_URL: z.string().url(),

  JWT_ACCESS_SECRET: z.string().min(16),
  // Secret for the reviewer-session cookie. Optional: when unset, a key derived
  // from DATA_ENCRYPTION_SECRET is used, so the cookie never shares a key with
  // user access tokens. Set it to rotate reviewer sessions on their own. See
  // review/session.ts.
  REVIEWER_SESSION_SECRET: z.string().min(16).optional(),
  // Lifetimes in seconds: an access token between a minute and a day, a
  // refresh token between an hour and a year.
  JWT_ACCESS_TTL: z.coerce.number().int().min(60).max(86_400).default(900),
  JWT_REFRESH_TTL: z.coerce.number().int().min(3_600).max(31_536_000).default(2_592_000),
  PASSWORD_HASH_ROUNDS: z.coerce.number().int().min(8).max(15).default(12),

  // 64 hex chars = 32 bytes for AES-256-GCM.
  AI_KEY_ENCRYPTION_SECRET: z.string().regex(/^[0-9a-fA-F]{64}$/, '64 hex chars required'),
  // Master secret for encrypting user PII at rest (email) and peppering
  // password hashes. Purpose-specific keys are HKDF-derived from it.
  DATA_ENCRYPTION_SECRET: z.string().regex(/^[0-9a-fA-F]{64}$/, '64 hex chars required'),

  AI_DEFAULT_PROVIDER: z.enum(['openai', 'anthropic', 'openrouter', 'ollama']).optional(),
  AI_DEFAULT_MODEL: z.string().optional(),
  // Per-user monthly quota for `aiMode='admin'` users (rolling 30 days).
  // 'byok' and 'none' users do not consume this. Set to 0 to deny the admin
  // mode entirely without unsetting AI_DEFAULT_PROVIDER.
  AI_ADMIN_USER_MONTHLY_LIMIT: z.coerce.number().int().min(0).max(1_000_000).default(40),
  // The same window for all users together: the one number that bounds what
  // the operator's provider can be asked for, however many accounts exist.
  AI_ADMIN_INSTANCE_MONTHLY_LIMIT: z.coerce.number().int().min(0).max(100_000_000).default(1000),
  OPENAI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  OLLAMA_BASE_URL: z.string().url().default('http://localhost:11434'),
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

  // A window of zero seconds or a limit of zero requests would refuse every
  // request, so both have a floor of one.
  RATE_LIMIT_WINDOW: z.coerce.number().int().min(1).max(3_600).default(60),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(1_000_000).default(120),

  // What the operator publishes about the instance. Served by GET /api/config,
  // so a change takes effect on restart, without rebuilding the web app.
  // Where the footer's "support us" link points; unset uses the project's page.
  SUPPORT_URL: z.string().url().optional(),
  // An e-mail address shown on the terms page; unset shows that none was published.
  OPERATOR_CONTACT: z.string().email().max(200).optional(),
  // Version label shown in the footer; unset uses the package version.
  APP_VERSION: z.string().max(40).optional(),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().default('no-reply@diet-app.local'),

  // Admin panel. Fail-closed: when ADMIN_PASSWORD is empty or left at
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
  // Signs the bundle-download one-shot tokens. When unset, a key derived from
  // DATA_ENCRYPTION_SECRET is used.
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

/** Sentinel password meaning "admin panel disabled". */
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

const HOW_TO_GENERATE =
  'Run `sh scripts/init-env.sh` for a new install, or generate one value with `openssl rand -hex 32`.';

/** Why a secret cannot have been generated at random, or null when it looks random. */
function whyNotRandom(value: string): string | null {
  if (/change[-_ ]?me/i.test(value)) return 'is a template placeholder';
  if (new Set(value).size < 8) return 'has too little variety to be a random value';
  return null;
}

/**
 * Secrets that sign tokens and encrypt stored data. A value copied from a
 * template is public knowledge: with it anyone can mint a session or read the
 * stored addresses, so the API does not start on one. Tests are exempt; they
 * use fixed values on a throwaway database.
 */
function secretProblems(env: z.infer<typeof envSchema>): string[] {
  if (env.NODE_ENV === 'test') return [];
  const problems: string[] = [];
  const check = (key: string, value: string | undefined, minLength: number) => {
    if (value === undefined) return;
    const reason = value.length < minLength ? `is shorter than ${minLength} characters` : whyNotRandom(value);
    if (reason) problems.push(`  ${key}: ${reason}. ${HOW_TO_GENERATE}`);
  };
  check('JWT_ACCESS_SECRET', env.JWT_ACCESS_SECRET, 32);
  check('REVIEWER_SESSION_SECRET', env.REVIEWER_SESSION_SECRET, 32);
  check('SHIP_DOWNLOAD_TOKEN_SECRET', env.SHIP_DOWNLOAD_TOKEN_SECRET, 32);
  check('AI_KEY_ENCRYPTION_SECRET', env.AI_KEY_ENCRYPTION_SECRET, 64);
  check('DATA_ENCRYPTION_SECRET', env.DATA_ENCRYPTION_SECRET, 64);
  if (env.AI_KEY_ENCRYPTION_SECRET === env.DATA_ENCRYPTION_SECRET) {
    problems.push('  AI_KEY_ENCRYPTION_SECRET: must differ from DATA_ENCRYPTION_SECRET.');
  }
  if (env.REVIEWER_SESSION_SECRET !== undefined && env.REVIEWER_SESSION_SECRET === env.JWT_ACCESS_SECRET) {
    problems.push('  REVIEWER_SESSION_SECRET: must differ from JWT_ACCESS_SECRET; leave it blank to have one derived.');
  }
  return problems;
}

/** `KEY=` in an env file means "not set". */
function withoutBlanks(raw: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(raw).filter(([, value]) => !(typeof value === 'string' && value.trim() === '')),
  );
}

/** @nestjs/config `validate` hook. */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(withoutBlanks(raw));
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const weak = secretProblems(result.data);
  if (weak.length > 0) {
    throw new Error(`Refusing to start with secrets that are not secret:\n${weak.join('\n')}`);
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

/**
 * What an operator should know about how this instance is set up, one line per
 * point, logged once at boot. Lines that start with `!` deserve attention.
 */
export function describePosture(
  env: Pick<
    Env,
    | 'NODE_ENV'
    | 'APP_URL'
    | 'ADMIN_PASSWORD'
    | 'SMTP_HOST'
    | 'SMTP_PORT'
    | 'AI_DEFAULT_PROVIDER'
    | 'AI_ADMIN_USER_MONTHLY_LIMIT'
    | 'AI_ADMIN_INSTANCE_MONTHLY_LIMIT'
    | 'SWAGGER_ENABLED'
  >,
): string[] {
  const https = env.APP_URL.startsWith('https://');
  return [
    `environment: ${env.NODE_ENV}`,
    https
      ? `public origin: ${env.APP_URL}`
      : `! public origin ${env.APP_URL} is not https: session cookies travel unprotected outside a trusted network`,
    isAdminEnabled(env) ? 'admin panel: enabled' : 'admin panel: disabled (ADMIN_PASSWORD not set)',
    env.SMTP_HOST ? `mail: ${env.SMTP_HOST}:${env.SMTP_PORT}` : 'mail: not configured (accounts are verified on sign-up, no password reset)',
    env.AI_DEFAULT_PROVIDER
      ? `operator AI provider: ${env.AI_DEFAULT_PROVIDER}, at most ${env.AI_ADMIN_USER_MONTHLY_LIMIT} calls per user and ${env.AI_ADMIN_INSTANCE_MONTHLY_LIMIT} for the whole instance in 30 days`
      : 'operator AI provider: none',
    env.SWAGGER_ENABLED && env.NODE_ENV === 'production'
      ? '! API documentation is served at /api/docs on a production instance'
      : `API documentation: ${env.SWAGGER_ENABLED ? 'served at /api/docs' : 'off'}`,
  ];
}
