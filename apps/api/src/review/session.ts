// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Reviewer-session cookie helpers.
 *
 * The cookie carries a signed token with the reviewer's label, 7-day TTL,
 * httpOnly + sameSite=lax. It is signed with a key of its own and made for
 * the reviewer panel (its audience says so): it is no access token of an
 * account, and an access token is no reviewer session.
 *
 * Cookies are parsed inline from the `Cookie` header to avoid pulling in
 * `cookie-parser` for this single cookie name.
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
export const REVIEWER_COOKIE_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface ReviewerClaims {
  label: string;
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
  payload: { label: string },
): { token: string; maxAgeSeconds: number } {
  const token = jwt.sign(
    { label: payload.label },
    { secret, expiresIn: REVIEWER_COOKIE_TTL_SECONDS, algorithm: TOKEN_ALGORITHM, audience: REVIEWER_AUDIENCE },
  );
  return { token, maxAgeSeconds: REVIEWER_COOKIE_TTL_SECONDS };
}

export function verifyReviewerCookie(
  jwt: JwtService,
  secret: string,
  token: string,
): ReviewerSession | null {
  try {
    const claims = jwt.verify<ReviewerClaims>(token, { secret, algorithms: [TOKEN_ALGORITHM], audience: REVIEWER_AUDIENCE });
    if (typeof claims.label !== 'string') return null;
    return {
      label: claims.label,
      issuedAt: new Date(claims.iat * 1000).toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * Minimal `Cookie:` header parser — handles `a=1; b=2; reviewer_session=...`
 * and percent-decodes the value. Avoids the `cookie-parser` middleware
 * dependency for a single named cookie.
 */
export function readCookie(
  cookieHeader: string | undefined,
  name: string,
): string | undefined {
  if (!cookieHeader) return undefined;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (k !== name) continue;
    const v = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  }
  return undefined;
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
    'SameSite=Lax',
  ];
  if (opts.secure) segments.push('Secure');
  segments.push(`Max-Age=${opts.clear ? 0 : opts.maxAgeSeconds}`);
  return segments.join('; ');
}
