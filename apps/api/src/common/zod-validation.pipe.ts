// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { BadRequestException, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import { z, type ZodType } from 'zod';

/**
 * Validates a request payload against a Zod schema from `@diet-app/shared`.
 * Usage: `@Body(new ZodValidationPipe(LoginRequest)) body: LoginRequest`.
 * Bound to one named parameter, the issue path starts with that name.
 */
export class ZodValidationPipe<T> implements PipeTransform {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown, metadata?: ArgumentMetadata): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const parameter = metadata?.data ? [metadata.data] : [];
      throw new BadRequestException({
        statusCode: 400,
        error: 'VALIDATION_FAILED',
        message: 'Request payload failed validation.',
        issues: result.error.issues.map((i) => ({
          path: [...parameter, ...i.path].join('.'),
          message: i.message,
        })),
      });
    }
    return result.data;
  }
}

/**
 * An id in a path or in a query string. One that is no id names nothing: it
 * is refused as it comes in, before anything is looked up.
 * Usage: `@Param('id', requiredUuid) id: string`.
 */
export const requiredUuid = new ZodValidationPipe(z.string().uuid());

/**
 * A calendar day in a path, as `2026-03-01`. A day there is not (the 30th of
 * February) is refused, not moved to the next one that there is.
 * Usage: `@Param('date', requiredDate) date: string`.
 */
export const requiredDate = new ZodValidationPipe(z.string().date());
