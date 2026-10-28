// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import * as z from './zod.js';

/**
 * A field a request was refused for: where it is (`path`, the parameter's
 * name first for a value of the path, the query or a header) and Zod's
 * English sentence (`message`), with what a client needs to word the refusal
 * itself. `code` is the kind, as Zod names it: `too_small` and `too_big` for a
 * number, a length or a number of items out of its bounds, `invalid_type`,
 * `invalid_format` (an id, a day, an address), `invalid_value` (none of the
 * values allowed), `custom` for a rule of the API's own, and the rest of Zod's.
 * A bound comes with `too_small` (`minimum`) and `too_big` (`maximum`), and
 * `inclusive` says whether the bound itself is allowed: `minimum` 0 that is not
 * inclusive is "more than 0".
 */
export const ApiErrorIssue = z.object({
  path: z.string(),
  message: z.string(),
  code: z.string(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  inclusive: z.boolean().optional(),
});
export type ApiErrorIssue = z.infer<typeof ApiErrorIssue>;

/** Uniform error envelope for every non-2xx API response. */
export const ApiError = z.object({
  statusCode: z.number().int(),
  /** Stable machine-readable code, e.g. `AUTH_INVALID_CREDENTIALS`. */
  error: z.string(),
  /** Human-readable message, safe to surface in the UI. */
  message: z.string(),
  /** The fields a request was refused for, with `VALIDATION_FAILED`. */
  issues: z.array(ApiErrorIssue).optional(),
  /**
   * What an error has to say beyond its code, for a client that words the
   * refusal itself. Which keys there are depends on `error`: the rules a
   * recipe breaks (`violations`), or the day, meal and recipe of a lock that
   * no longer holds (`date`, `slot`, `recipeId`).
   */
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ApiError = z.infer<typeof ApiError>;
