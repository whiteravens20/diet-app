// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { createHash } from 'node:crypto';
import type { ThrottlerGetTrackerFunction } from '@nestjs/throttler';

/**
 * Whom a route that tries a credential counts a request against: the identity
 * that is being tried, not the address it comes from. Ten wrong passwords for
 * one account then slow down attempts on that account and nothing else.
 *
 * A tracker is a key in the limiter's memory and nothing more: it is hashed so
 * that no address or token sits there in the clear, never stored and never
 * sent anywhere.
 */

const digest = (kind: string, value: string): string => `${kind}:${createHash('sha256').update(value).digest('hex')}`;

/** The client's address, for a request that names nothing to count against. */
const byAddress = (req: Record<string, unknown>): string => `addr:${String(req.ip ?? '')}`;

/** A text field of the request body, or null when it is not there. */
function field(req: Record<string, unknown>, name: string): string | null {
  const body = req.body as Record<string, unknown> | undefined;
  const value = body?.[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The account a request names by its e-mail address: every way of writing one
 * address is one account, so the address is trimmed and lower-cased as it is
 * when it is looked up.
 */
export const byEmail: ThrottlerGetTrackerFunction = (req) => {
  const email = field(req, 'email');
  return email === null ? byAddress(req) : digest('email', email.trim().toLowerCase());
};

/** The token a request presents: a refresh token, or one from a link in a mail. */
export const byToken =
  (name: string): ThrottlerGetTrackerFunction =>
  (req) => {
    const token = field(req, name);
    return token === null ? byAddress(req) : digest('token', token);
  };
