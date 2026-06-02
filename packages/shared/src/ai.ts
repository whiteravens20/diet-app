import { z } from 'zod';
import { AiProvider } from './enums.js';

/**
 * Per-user AI provider configuration. The API key is **write-only** — it is
 * encrypted at rest and never returned; the API exposes only `hasKey`.
 */
export const AiProviderConfigInput = z
  .object({
    provider: AiProvider,
    /** Plaintext key on the way in; encrypted server-side immediately. */
    apiKey: z.string().min(1).optional(),
    /** Per-config Ollama host. Required when provider = ollama. */
    baseUrl: z.string().url().optional(),
    model: z.string().min(1),
    /** Lower number = tried first in the failover chain. */
    priority: z.number().int().min(0).default(0),
    enabled: z.boolean().default(true),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.provider === 'ollama') {
      if (!cfg.baseUrl) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['baseUrl'],
          message: 'AI_BASE_URL_REQUIRED',
        });
      }
    } else if (!cfg.apiKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['apiKey'],
        message: 'AI_API_KEY_REQUIRED',
      });
    }
  });
export type AiProviderConfigInput = z.infer<typeof AiProviderConfigInput>;

/** AI provider config as returned by the API — never includes the key. */
export const AiProviderConfig = z.object({
  id: z.string().uuid(),
  provider: AiProvider,
  model: z.string(),
  priority: z.number().int(),
  enabled: z.boolean(),
  hasKey: z.boolean(),
  /** Per-config base URL (Ollama only). Null for other providers. */
  baseUrl: z.string().nullable(),
  /** True for admin-supplied defaults visible to all users. */
  isAdminDefault: z.boolean(),
});
export type AiProviderConfig = z.infer<typeof AiProviderConfig>;

/**
 * Diagnostic envelope attached to AI-assisted responses so the UI can show how
 * a result was produced and which validations the engine applied afterward.
 */
/**
 * Why the deterministic engine had to take over. Populated only when
 * `usedDeterministicFallback === true`. The UI maps these codes to a
 * localised "AI unavailable" toast/badge so the user knows the result came
 * from the engine and not from a model.
 *
 * - `quota_exhausted`     — `aiMode='admin'` user hit the monthly quota.
 * - `no_provider`         — `aiMode='none'`, or `byok` with no enabled
 *                           config, or `admin` with no configured admin
 *                           default (the operator didn't set
 *                           `AI_DEFAULT_PROVIDER`).
 * - `all_providers_failed`— every provider in the chain errored (auth,
 *                           network, model error). Details in `failoverChain`.
 */
export const AiFallbackReason = z.enum([
  'quota_exhausted',
  'no_provider',
  'all_providers_failed',
]);
export type AiFallbackReason = z.infer<typeof AiFallbackReason>;

export const AiGenerationMeta = z.object({
  /** Provider that ultimately served the request, or null in fallback mode. */
  provider: AiProvider.nullable(),
  model: z.string().nullable(),
  /** Ordered list of providers that failed before this one succeeded. */
  failoverChain: z.array(AiProvider),
  /** True when no provider was usable and the deterministic engine was used. */
  usedDeterministicFallback: z.boolean(),
  /** Why fallback happened. Null when `usedDeterministicFallback === false`. */
  fallbackReason: AiFallbackReason.nullable(),
  /** Ingredients the validation layer rejected or remapped. */
  rejectedIngredients: z.array(z.string()),
  remappedIngredients: z.array(z.object({ from: z.string(), to: z.string() })),
});
export type AiGenerationMeta = z.infer<typeof AiGenerationMeta>;

/**
 * Snapshot of the caller's AI routing state. The app-shell chip and the
 * Settings AI card both render from this. `providerConfigured` flags whether
 * the operator has set `AI_DEFAULT_PROVIDER` — when false the `admin` mode
 * option is hidden in the UI.
 */
export const AiQuotaStatus = z.object({
  mode: z.enum(['none', 'admin', 'byok']),
  /**
   * Operator's env-configured monthly call cap (`AI_ADMIN_USER_MONTHLY_LIMIT`).
   * Returned regardless of the caller's mode so the Settings UI can gate the
   * `admin` option on it; `0` means admin mode is disabled instance-wide.
   */
  limit: z.number().int().nonnegative(),
  /** Calls in the trailing 30-day window. Only meaningful for `admin`. */
  used: z.number().int().nonnegative(),
  /** `limit - used`, clamped at 0. `null` when no quota applies to the caller. */
  remaining: z.number().int().nonnegative().nullable(),
  /**
   * ISO timestamp of when the oldest counted call drops out of the rolling
   * window — i.e. when `used` will decrement by at least one. Null when
   * `used === 0` or quota does not apply.
   */
  resetAt: z.string().datetime().nullable(),
  /** Whether `AI_DEFAULT_PROVIDER` is set (gates the `admin` mode option). */
  adminProviderConfigured: z.boolean(),
});
export type AiQuotaStatus = z.infer<typeof AiQuotaStatus>;

/**
 * Test-connection probe. Hits the provider's models-list endpoint without
 * persisting the credential — the UI calls this from the BYOK form before
 * saving so the user can confirm the key works (and pick a model from the
 * returned list).
 */
export const AiTestConnectionRequest = z.object({
  provider: AiProvider,
  /** Required for OpenAI / Anthropic / OpenRouter; ignored for Ollama. */
  apiKey: z.string().min(1).optional(),
  /** Required for Ollama; ignored for the cloud providers. */
  baseUrl: z.string().url().optional(),
  /**
   * Anthropic has no `/v1/models` endpoint, so the probe needs a model id to
   * test. Optional for the others (they list models without it).
   */
  model: z.string().min(1).optional(),
});
export type AiTestConnectionRequest = z.infer<typeof AiTestConnectionRequest>;

export const AiTestConnectionResponse = z.object({
  ok: z.boolean(),
  /** Sorted list of model ids the provider returned. Empty for Anthropic. */
  models: z.array(z.string()),
  /** Provider error verbatim when `ok === false`. */
  error: z.string().nullable(),
});
export type AiTestConnectionResponse = z.infer<typeof AiTestConnectionResponse>;
