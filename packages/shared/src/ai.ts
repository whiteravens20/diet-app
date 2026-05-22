import { z } from 'zod';
import { AiProvider } from './enums.js';

/**
 * Per-user AI provider configuration. The API key is **write-only** — it is
 * encrypted at rest and never returned; the API exposes only `hasKey`.
 */
export const AiProviderConfigInput = z.object({
  provider: AiProvider,
  /** Plaintext key on the way in; encrypted server-side immediately. */
  apiKey: z.string().min(1).optional(),
  model: z.string().min(1),
  /** Lower number = tried first in the failover chain. */
  priority: z.number().int().min(0).default(0),
  enabled: z.boolean().default(true),
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
  /** True for admin-supplied defaults visible to all users. */
  isAdminDefault: z.boolean(),
});
export type AiProviderConfig = z.infer<typeof AiProviderConfig>;

/**
 * Diagnostic envelope attached to AI-assisted responses so the UI can show how
 * a result was produced and which validations the engine applied afterward.
 */
export const AiGenerationMeta = z.object({
  /** Provider that ultimately served the request, or null in fallback mode. */
  provider: AiProvider.nullable(),
  model: z.string().nullable(),
  /** Ordered list of providers that failed before this one succeeded. */
  failoverChain: z.array(AiProvider),
  /** True when no provider was usable and the deterministic engine was used. */
  usedDeterministicFallback: z.boolean(),
  /** Ingredients the validation layer rejected or remapped. */
  rejectedIngredients: z.array(z.string()),
  remappedIngredients: z.array(z.object({ from: z.string(), to: z.string() })),
});
export type AiGenerationMeta = z.infer<typeof AiGenerationMeta>;
