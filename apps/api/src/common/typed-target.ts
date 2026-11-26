// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { BadRequestException } from '@nestjs/common';

/**
 * Refuse a calorie target somebody typed, for a profile, a plan or a day,
 * under the least this body may be given (`CalorieCalculation.leastTypedTarget`):
 * as a failed field of the request, so that a form says it beside the field.
 */
export function refuseUnderLeast(
  typed: number | null | undefined,
  least: number,
  path: string,
): void {
  if (typed == null || typed >= least) return;
  throw new BadRequestException({
    statusCode: 400,
    error: 'VALIDATION_FAILED',
    message: 'Request payload failed validation.',
    issues: [
      {
        path,
        message: `The least calorie target this body may be given is ${least} kcal.`,
        // As the schema of a request says its bounds: a client words the least in its own language.
        code: 'too_small',
        minimum: least,
        inclusive: true,
      },
    ],
  });
}
