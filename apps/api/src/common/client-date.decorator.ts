// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { BadRequestException, type ExecutionContext, createParamDecorator } from '@nestjs/common';

/** The header a client names its day in, as `2026-03-01`. */
export const CLIENT_DATE_HEADER = 'x-client-date';

const DAY_MS = 86_400_000;

/**
 * What day it is for the client of a request.
 *
 * The server knows the moment, not the day: at eleven at night in Warsaw it
 * is the next day in Tokyo and still the same in Lisbon. A client says which
 * day it is where its user is (`X-Client-Date`), and whatever depends on
 * "today" goes by that: which plan is under way, which days have passed.
 *
 * The day a client names is taken when it is the server's own day, the one
 * before or the one after: nowhere on earth is it any other. A client that
 * names none gets null, and whoever asked goes by the server's day, in UTC.
 *
 * Usage: `list(@ClientDate() today: string | null) { … }`
 */
export const ClientDate = createParamDecorator((_data: unknown, ctx: ExecutionContext): string | null => {
  const request = ctx.switchToHttp().getRequest<{ headers: Record<string, string | string[] | undefined> }>();
  return clientDate(request.headers[CLIENT_DATE_HEADER], new Date());
});

/** The day a request names in its header, checked against the moment it arrived; null when it names none. */
export function clientDate(header: string | string[] | undefined, now: Date): string | null {
  const server = now.toISOString().slice(0, 10);
  if (header === undefined) return null;
  const named = typeof header === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(header) ? Date.parse(`${header}T00:00:00Z`) : Number.NaN;
  // A day there is not (the 30th of February) is parsed as another one, or not at all.
  const real = !Number.isNaN(named) && new Date(named).toISOString().slice(0, 10) === header;
  if (!real || Math.abs(named - Date.parse(`${server}T00:00:00Z`)) > DAY_MS) {
    throw new BadRequestException({
      statusCode: 400,
      error: 'VALIDATION_FAILED',
      message: 'Request payload failed validation.',
      issues: [{ path: CLIENT_DATE_HEADER, message: `Must be the day it is where the client is, as YYYY-MM-DD: ${server} or a day next to it.` }],
    });
  }
  return header as string;
}
