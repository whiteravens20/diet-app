// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/** Where somebody lands after signing in when no other page was asked for. */
export const HOME = '/dashboard';

/**
 * The page a visitor wanted when they were sent to sign in, as a sign-in may
 * return to it: a path of this application, and nothing else. What could
 * lead anywhere else (another site, a scheme, a path a browser would read as
 * a host) is the home page instead, and so are the sign-in pages themselves.
 */
export function returnPath(asked: string | null | undefined): string {
  if (!asked || !asked.startsWith('/')) return HOME;
  // `//host` and `/\host` are another site to a browser, and a control character has no place in a path.
  if (asked.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(asked)) return HOME;
  if (/^\/(login|register)(\/|\?|$)/.test(asked)) return HOME;
  return asked;
}

/** The sign-in page for a visitor who was on `from`, so that signing in brings them back. */
export function signInPath(from: string): string {
  const back = returnPath(from);
  return back === HOME ? '/login' : `/login?next=${encodeURIComponent(back)}`;
}
