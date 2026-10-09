// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { z } from 'zod';

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
 * Public, unauthenticated runtime configuration the web app needs before a user
 * is signed in. Served by `GET /api/config`. Deliberately exposes only
 * non-secret operator choices so the front-end can self-configure at runtime
 * (no `NEXT_PUBLIC_*` rebuild): whether to render the Turnstile widget and which
 * site key to use, whether email-driven flows (verification, email change) are
 * available, whether users may bring their own Ollama host, and what the
 * operator publishes about the instance.
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
});
export type PublicConfig = z.infer<typeof PublicConfig>;
