// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { z } from 'zod';

/** Uniform error envelope for every non-2xx API response. */
export const ApiError = z.object({
  statusCode: z.number().int(),
  /** Stable machine-readable code, e.g. `AUTH_INVALID_CREDENTIALS`. */
  error: z.string(),
  /** Human-readable message, safe to surface in the UI. */
  message: z.string(),
  /** Optional field-level validation issues. */
  issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  /**
   * What an error has to say beyond its code, for a client that words the
   * refusal itself. Which keys there are depends on `error`: the rules a
   * recipe breaks (`violations`), or the day, meal and recipe of a lock that
   * no longer holds (`date`, `slot`, `recipeId`).
   */
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ApiError = z.infer<typeof ApiError>;
