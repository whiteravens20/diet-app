// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Reviewer-session cookie helpers.
 *
 * The cookie carries a signed token with the reviewer's label, 7-day TTL,
 * httpOnly + sameSite=strict. It is signed with a key of its own and made for
 * the reviewer panel (its audience says so): it is no access token of an
 * account, and an access token is no reviewer session.
 */
import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import { REVIEWER_AUDIENCE, TOKEN_ALGORITHM } from '../auth/token-kinds.js';
import { deriveKey } from '../common/crypto.js';
import type { Env } from '../config/env.js';

export const REVIEWER_COOKIE_NAME = 'reviewer_session';

/**
 * Secret the reviewer cookie is signed and verified with: the dedicated
 * REVIEWER_SESSION_SECRET, or a key derived from the data secret when the
 * operator has not set one. Either way it is never the key of user access
 * tokens, so a reviewer cookie cannot pass as one and neither secret leaks the
 * other.
 */
export function resolveReviewerSecret(config: ConfigService<Env, true>): string {
  return (
    config.get('REVIEWER_SESSION_SECRET', { infer: true }) ??
    deriveKey(config.get('DATA_ENCRYPTION_SECRET', { infer: true }), 'reviewer-session')
  );
}
/** 7 days, in seconds. */
const REVIEWER_COOKIE_TTL_SECONDS = 7 * 24 * 60 * 60;

interface ReviewerClaims {
  label: string;
  /** The epoch of the reviewer settings the session was begun in. */
  epoch: number;
  iat: number;
  exp: number;
}

export interface ReviewerSession {
  label: string;
  /** Cookie issuance time as ISO-8601 string. */
  issuedAt: string;
}

export function signReviewerCookie(
  jwt: JwtService,
  secret: string,
  payload: { label: string; epoch: number },
): { token: string; maxAgeSeconds: number } {
  const token = jwt.sign(
    { label: payload.label, epoch: payload.epoch },
    { secret, expiresIn: REVIEWER_COOKIE_TTL_SECONDS, algorithm: TOKEN_ALGORITHM, audience: REVIEWER_AUDIENCE },
  );
  return { token, maxAgeSeconds: REVIEWER_COOKIE_TTL_SECONDS };
}

/**
 * The session a cookie holds, when it is one of the epoch the reviewer
 * settings are in now: the password changed or the panel closed since, and it
 * is none.
 */
export function verifyReviewerCookie(
  jwt: JwtService,
  secret: string,
  token: string,
  epoch: number,
): ReviewerSession | null {
  try {
    const claims = jwt.verify<ReviewerClaims>(token, { secret, algorithms: [TOKEN_ALGORITHM], audience: REVIEWER_AUDIENCE });
    if (typeof claims.label !== 'string' || claims.epoch !== epoch) return null;
    return {
      label: claims.label,
      issuedAt: new Date(claims.iat * 1000).toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * Build a `Set-Cookie` header value for the reviewer session. `clear=true`
 * emits a cookie with `Max-Age=0` that overwrites the current one.
 */
export function buildReviewerSetCookie(opts: {
  token: string | null;
  maxAgeSeconds: number;
  clear?: boolean;
  /** Set to `true` behind HTTPS so the browser only sends it over TLS. */
  secure: boolean;
}): string {
  const value = opts.clear ? '' : opts.token ?? '';
  const segments = [
    `${REVIEWER_COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    // Never sent along with a request that another site caused.
    'SameSite=Strict',
  ];
  if (opts.secure) segments.push('Secure');
  segments.push(`Max-Age=${opts.clear ? 0 : opts.maxAgeSeconds}`);
  return segments.join('; ');
}
