// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { BadRequestException, type ExecutionContext, createParamDecorator } from '@nestjs/common';

/** The header a client names an addition's key in. */
const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/** What a key may be: one to 128 visible characters, as a UUID is. */
const KEY = /^[\x21-\x7e]{1,128}$/;

/**
 * The key a client sent with an addition it may send again when the answer
 * is lost (`Idempotency-Key`): the addition sent again under the same key is
 * answered from what the first one wrote. The key is a string, quoted or not,
 * as the IETF draft writes it. A request without one is written as it comes;
 * a key of another form is refused.
 *
 * Usage: `create(@IdempotencyKey() key: string | null) { … }`
 */
export const IdempotencyKey = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | null => {
    const request = ctx
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | string[] | undefined> }>();
    return idempotencyKey(request.headers[IDEMPOTENCY_KEY_HEADER]);
  },
);

/** The key a request names in its header; null when it names none. */
export function idempotencyKey(header: string | string[] | undefined): string | null {
  if (header === undefined) return null;
  const key = typeof header === 'string' ? header.trim().replace(/^"(.*)"$/, '$1') : '';
  if (!KEY.test(key)) {
    throw new BadRequestException({
      statusCode: 400,
      error: 'VALIDATION_FAILED',
      message: 'Request payload failed validation.',
      issues: [
        {
          path: IDEMPOTENCY_KEY_HEADER,
          message: 'Must be one to 128 visible characters, such as a UUID.',
          code: 'custom',
        },
      ],
    });
  }
  return key;
}
