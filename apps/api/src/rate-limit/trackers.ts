// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { createHash } from 'node:crypto';
import { SetMetadata } from '@nestjs/common';
import type { ThrottlerGetTrackerFunction } from '@nestjs/throttler';
import { REFRESH_COOKIE } from '../auth/session-cookies.js';
import { readCookie } from '../common/cookies.js';
import { countedAddress } from './client-address.js';

/**
 * What a route that tries a credential is counted by: the credential that is
 * being tried, on top of who sends the request. Wrong passwords for one
 * account then slow down attempts on that account and nothing else.
 *
 * What a request is counted by is a key in the limiter's memory and nothing
 * more: it is hashed so that no address or token sits there in the clear,
 * never stored and never sent anywhere.
 */

/** One count of a route that tries a credential. */
export interface CredentialCount {
  /** What the request is counted by. */
  by: ThrottlerGetTrackerFunction;
  /** How often that may be tried within `ttl`. */
  limit: number;
  /** Milliseconds. Whoever passes the limit waits as long. */
  ttl: number;
}

export const CREDENTIAL_COUNTS = 'rate-limit:credential-counts';

/**
 * Marks a route that tries a credential and says what it is counted by. The
 * counts are taken in the order given, and the first that is used up refuses
 * the request before the later ones see it.
 */
export const TriesCredential = (...counts: CredentialCount[]): MethodDecorator => SetMetadata(CREDENTIAL_COUNTS, counts);

const digest = (kind: string, value: string): string => `${kind}:${createHash('sha256').update(value).digest('hex')}`;

/** A text field of the request body; a request without it counts with all the others without it. */
function field(req: Record<string, unknown>, name: string): string {
  const body = req.body as Record<string, unknown> | undefined;
  const value = body?.[name];
  return typeof value === 'string' ? value : '';
}

/**
 * The account a request names by its e-mail address: every way of writing one
 * address is one account, so the address is trimmed and lower-cased as it is
 * when it is looked up.
 */
const account = (req: Record<string, unknown>): string => field(req, 'email').trim().toLowerCase();

/** The account a request names, wherever the request comes from. */
export const byAccount: ThrottlerGetTrackerFunction = (req) => digest('account', account(req));

/**
 * The account a request names, as tried from the address the request comes
 * from. Somebody guessing at an account uses up what their own address may
 * try at it, and not what its owner may, who sits at another address.
 *
 * Where the API cannot tell its clients apart (`TRUST_PROXY` off behind a
 * proxy) every request has the same address, and this is the account alone.
 */
export const byAccountAndAddress: ThrottlerGetTrackerFunction = (req) =>
  digest('account+address', `${account(req)}\n${countedAddress(req.ip)}`);

/** The token a request presents in its body: one from a link in a mail. */
export const byToken =
  (name: string): ThrottlerGetTrackerFunction =>
  (req) =>
    digest('token', field(req, name));

/**
 * The refresh token a request presents: in its body, or for a browser in its
 * cookie. Without the cookie every browser would be counted as one.
 */
export const byRefreshToken: ThrottlerGetTrackerFunction = (req) => {
  const headers = req.headers as Record<string, string | undefined> | undefined;
  return digest('token', field(req, 'refreshToken') || (readCookie(headers?.cookie, REFRESH_COOKIE) ?? ''));
};
