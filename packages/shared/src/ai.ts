// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import * as z from './zod.js';
import { AiProvider } from './enums.js';

/**
 * Per-user AI provider configuration. The API key is **write-only** — it is
 * encrypted at rest and never returned; the API exposes only `hasKey`.
 */
/** A provider's key, the address of a provider's server and the name of a model: none longer than any provider's are. */
const apiKey = z.string().min(1).max(500);
const baseUrl = z.string().url().max(500);
const model = z.string().min(1).max(200);

export const AiProviderConfigInput = z
  .object({
    provider: AiProvider,
    /** Plaintext key on the way in; encrypted server-side immediately. */
    apiKey: apiKey.optional(),
    /** Per-config Ollama host. Required when provider = ollama. */
    baseUrl: baseUrl.optional(),
    model,
    /** Lower number = tried first in the failover chain. */
    priority: z.number().int().min(0).max(100).default(0),
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
  /**
   * True when a key is stored but can no longer be decrypted (the instance's
   * encryption secret changed, or the stored value is damaged). The provider
   * is skipped until the key is entered again.
   */
  keyUnreadable: z.boolean(),
  /** Per-config base URL (Ollama only). Null for other providers. */
  baseUrl: z.string().nullable(),
});
export type AiProviderConfig = z.infer<typeof AiProviderConfig>;

/**
 * Why the deterministic engine had to take over. Populated only when
 * `usedDeterministicFallback === true`. The UI maps these codes to a
 * localised "AI unavailable" toast/badge so the user knows the result came
 * from the engine and not from a model.
 *
 * - `quota_exhausted`     — `aiMode='admin'` user hit the monthly quota.
 * - `instance_quota_exhausted` — the operator's provider has served as many
 *                           calls as the instance allows in a month; it is
 *                           closed to every user until calls age out.
 * - `no_provider`         — `aiMode='none'`, or `byok` with no enabled
 *                           config, or `admin` with no configured admin
 *                           default (the operator didn't set
 *                           `AI_DEFAULT_PROVIDER`).
 * - `all_providers_failed`— every provider in the chain errored (auth,
 *                           network, model error). Details in `failoverChain`.
 * - `provider_timeout`    — at least one provider's request was aborted on
 *                           the client-side deadline (default 60s). Distinct
 *                           from `all_providers_failed` so the UI can surface
 *                           an actionable "your model is too slow, try a
 *                           smaller model or a cloud provider" hint instead
 *                           of a generic "didn't respond".
 * - `key_unreadable`      — the user's saved provider key can no longer be
 *                           decrypted, and no other provider answered. It
 *                           has to be entered again.
 * - `invalid_output`      — a provider answered, but not with something the
 *                           application could use (no JSON, the wrong shape,
 *                           an id that was not on offer). `provider` and
 *                           `model` name who answered.
 * - `not_permitted`       — the operator does not let this account use its
 *                           provider now (`AI_ADMIN_ACCESS`): the address is
 *                           not confirmed, or the account is not approved.
 * - `new_accounts_quota_exhausted` — the account is new, and the new accounts
 *                           together have used their part of the instance's
 *                           allowance; it is the account's own once it is no
 *                           longer new.
 */
export const AiFallbackReason = z.enum([
  'quota_exhausted',
  'instance_quota_exhausted',
  'new_accounts_quota_exhausted',
  'not_permitted',
  'no_provider',
  'all_providers_failed',
  'provider_timeout',
  'key_unreadable',
  'invalid_output',
]);
export type AiFallbackReason = z.infer<typeof AiFallbackReason>;

/**
 * How an AI-assisted result was produced: who answered, and whether the model
 * or the engine made the choice. Attached to every such response so the UI can
 * say so.
 */
export const AiGenerationMeta = z.object({
  /** The provider that answered, or null when none did. */
  provider: AiProvider.nullable(),
  model: z.string().nullable(),
  /** Ordered list of providers that failed before this one succeeded. */
  failoverChain: z.array(AiProvider),
  /** True when the deterministic engine made the choice, not a model. */
  usedDeterministicFallback: z.boolean(),
  /** Why the engine decided. Null when `usedDeterministicFallback === false`. */
  fallbackReason: AiFallbackReason.nullable(),
  /**
   * The model's own one-sentence explanation of its choice, as plain text.
   * Null when the engine decided or the model gave none.
   */
  reason: z.string().max(200).nullable(),
});
export type AiGenerationMeta = z.infer<typeof AiGenerationMeta>;

/**
 * A note that a model made a pick: which one, for what, and why. The API
 * signs it and hands it out with the pick, before anything is written; the
 * request that then takes the pick hands it back, and what is written says
 * that a model chose it. A client cannot write one, and a note is good for
 * the one pick it was made for. Opaque: a client passes it on unread.
 */
export const ModelPickNote = z.string().min(1).max(2048);
export type ModelPickNote = z.infer<typeof ModelPickNote>;

/**
 * Who the operator lets use its provider (`AI_ADMIN_ACCESS`): every account,
 * the accounts whose address is confirmed, or the accounts the operator
 * approved in the admin panel.
 */
export const OperatorAiAccess = z.enum(['everyone', 'confirmed', 'approved']);
export type OperatorAiAccess = z.infer<typeof OperatorAiAccess>;

/**
 * Whether an account may use the operator's provider now: `granted`, or what
 * it lacks for it under `AI_ADMIN_ACCESS`, a confirmed address or the
 * operator's approval.
 */
export const AdminAiAccess = z.enum(['granted', 'email_unconfirmed', 'not_approved']);
export type AdminAiAccess = z.infer<typeof AdminAiAccess>;

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
  /**
   * Calls the caller can still make: `limit - used`, clamped at 0, and 0 while
   * `instanceLimitReached`, while the account is new and
   * `newAccountsLimitReached`, or while `adminAccess` is not `granted`.
   * `null` when no quota applies to the caller.
   */
  remaining: z.number().int().nonnegative().nullable(),
  /**
   * ISO timestamp of when a place comes free again: the oldest call counted
   * against the limit that binds (the caller's own, or the instance's while
   * `instanceLimitReached`) drops out of the rolling window, or, for a new
   * account while the new accounts' part is used up, `newUntil`. Null when
   * nothing is counted or quota does not apply.
   */
  resetAt: z.string().datetime().nullable(),
  /**
   * True when all users together have used what the instance allows on the
   * operator's provider (`AI_ADMIN_INSTANCE_MONTHLY_LIMIT`), whatever is left
   * of the caller's own allowance.
   */
  instanceLimitReached: z.boolean(),
  /** Whether `AI_DEFAULT_PROVIDER` is set (gates the `admin` mode option). */
  adminProviderConfigured: z.boolean(),
  /** Whether the account may use the operator's provider, whatever its mode: the `admin` option is offered only when it is `granted`. */
  adminAccess: AdminAiAccess,
  /**
   * Until when the account is new: the accounts younger than
   * `AI_ADMIN_NEW_ACCOUNT_DAYS` share a part of the instance's allowance
   * (`AI_ADMIN_NEW_ACCOUNTS_PERCENT`). Null for an account that is not new.
   */
  newUntil: z.string().datetime().nullable(),
  /** True when the new accounts together have used their part of the instance's allowance. */
  newAccountsLimitReached: z.boolean(),
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
  apiKey: apiKey.optional(),
  /** Required for Ollama; ignored for the cloud providers. */
  baseUrl: baseUrl.optional(),
  /**
   * Anthropic has no `/v1/models` endpoint, so the probe needs a model id to
   * test. Optional for the others (they list models without it).
   */
  model: model.optional(),
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
