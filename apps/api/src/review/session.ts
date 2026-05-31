/**
 * Reviewer-session cookie helpers (Phase H).
 *
 * The cookie carries a signed JWT with `{ kind: 'reviewer', label, locale }`,
 * 7-day TTL, httpOnly + sameSite=lax. We reuse the existing JWT_ACCESS_SECRET
 * so no new secret needs to be configured; reviewer JWTs and user JWTs are
 * distinguished by the `kind` claim.
 *
 * Cookies are parsed inline from the `Cookie` header to avoid pulling in
 * `cookie-parser` for this single cookie name.
 */
import type { JwtService } from '@nestjs/jwt';

export const REVIEWER_COOKIE_NAME = 'reviewer_session';
/** 7 days, in seconds — matches the spec ("7-day TTL"). */
export const REVIEWER_COOKIE_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface ReviewerClaims {
  kind: 'reviewer';
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
    { kind: 'reviewer', label: payload.label },
    { secret, expiresIn: REVIEWER_COOKIE_TTL_SECONDS },
  );
  return { token, maxAgeSeconds: REVIEWER_COOKIE_TTL_SECONDS };
}

export function verifyReviewerCookie(
  jwt: JwtService,
  secret: string,
  token: string,
): ReviewerSession | null {
  try {
    const claims = jwt.verify<ReviewerClaims>(token, { secret });
    if (claims.kind !== 'reviewer') return null;
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
