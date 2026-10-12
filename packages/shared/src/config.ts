// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import * as z from './zod.js';
import { DietType } from './enums.js';
import { MOST_PROFILES_PER_ACCOUNT } from './profile.js';

/**
 * Whether — and how — a user may point a bring-your-own Ollama config at a host
 * of their choosing. An operator picks this per instance:
 *  - `off`       users cannot configure their own Ollama at all (the operator's
 *                env-configured Ollama, if any, still serves `admin`-mode users).
 *  - `allowlist` (default) only the operator's `OLLAMA_BASE_URL` host and any
 *                host in `OLLAMA_ALLOWED_HOSTS` are permitted.
 *  - `public`    any host EXCEPT internal/private/loopback/link-local addresses,
 *                so a user's own publicly-reachable Ollama works without letting
 *                the server be used to reach the operator's internal network.
 */
export const OllamaUserPolicy = z.enum(['off', 'allowlist', 'public']);
export type OllamaUserPolicy = z.infer<typeof OllamaUserPolicy>;

/**
 * The recipes a meal needs before a week of it stays inside the default limit
 * on repeats: the same recipe at most three times in seven days. With fewer, a
 * plan is still made and repeats a dish more often than a profile asks.
 */
export const VARIETY_DEPTH = 3;

/** A number of meals a day, as the key of an object. */
export const MealCountKey = z.enum(['2', '3', '4', '5']);
export type MealCountKey = z.infer<typeof MealCountKey>;

/**
 * For every diet and number of meals a day: how many shared recipes the
 * thinnest of those meals has to choose from. Zero means no plan can be made
 * for the pair from the catalogue alone; under `VARIETY_DEPTH` a plan repeats
 * itself.
 */
export const CatalogueDepth = z.record(DietType, z.record(MealCountKey, z.number().int().min(0)));
export type CatalogueDepth = z.infer<typeof CatalogueDepth>;

/**
 * Public, unauthenticated runtime configuration the web app needs before a user
 * is signed in. Served by `GET /api/config`. Deliberately exposes only
 * non-secret operator choices so the front-end can self-configure at runtime
 * (no `NEXT_PUBLIC_*` rebuild): whether to render the Turnstile widget and which
 * site key to use, whether email-driven flows (verification, email change) are
 * available, whether users may bring their own Ollama host, what the
 * operator publishes about the instance, and which diets the recipe catalogue
 * can serve.
 */
export const PublicConfig = z.object({
  turnstile: z.object({
    enabled: z.boolean(),
    siteKey: z.string().nullable(),
  }),
  email: z.object({
    enabled: z.boolean(),
  }),
  ai: z.object({
    ollamaUserPolicy: OllamaUserPolicy,
  }),
  instance: z.object({
    /** Where the "support us" link points; null means the project's own page. */
    supportUrl: z.string().url().nullable(),
    /** How to reach whoever runs this instance; null when they published nothing. */
    operatorContact: z.string().nullable(),
    /** The running version: the package version unless the operator set another label. */
    version: z.string(),
  }),
  catalogue: z.object({
    depth: CatalogueDepth,
  }),
  accounts: z.object({
    /** How many profiles an account may hold on this instance. */
    maxProfiles: z.number().int().min(1).max(MOST_PROFILES_PER_ACCOUNT),
  }),
});
export type PublicConfig = z.infer<typeof PublicConfig>;
