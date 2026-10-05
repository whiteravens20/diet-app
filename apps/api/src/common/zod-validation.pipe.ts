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
 * A required id in the query string.
 * Usage: `@Query('profileId', requiredUuid) profileId: string`.
 */
export const requiredUuid = new ZodValidationPipe(z.string().uuid());
