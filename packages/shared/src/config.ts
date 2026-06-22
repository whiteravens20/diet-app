import { z } from 'zod';

/**
 * Public, unauthenticated runtime configuration the web app needs before a user
 * is signed in. Served by `GET /api/config`. Deliberately exposes only
 * non-secret operator choices so the front-end can self-configure at runtime
 * (no `NEXT_PUBLIC_*` rebuild): whether to render the Turnstile widget and which
 * site key to use, and whether email-driven flows (verification, email change)
 * are available on this instance.
 */
export const PublicConfig = z.object({
  turnstile: z.object({
    enabled: z.boolean(),
    siteKey: z.string().nullable(),
  }),
  email: z.object({
    enabled: z.boolean(),
  }),
});
export type PublicConfig = z.infer<typeof PublicConfig>;
