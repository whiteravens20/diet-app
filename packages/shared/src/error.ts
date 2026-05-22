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
});
export type ApiError = z.infer<typeof ApiError>;
