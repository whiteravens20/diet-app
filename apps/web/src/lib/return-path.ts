// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * The pages of a signed-in account, by the first part of their path. The
 * proxy guards them (its own list has to be written out, and a test holds
 * the two to each other), and a sign-in leads back to one of them only.
 */
export const ACCOUNT_PAGES = [
  '/dashboard',
  '/diary',
  '/profile',
  '/calculator',
  '/recipes',
  '/favorites',
  '/meal-plans',
  '/shopping-lists',
  '/inventory',
  '/settings',
] as const;

/** Where somebody lands after signing in when no other page was asked for. */
export const HOME = '/dashboard';

/** True for the path of a page of an account, with whatever it was asked with. The path is one a browser has read: no `..` is left in it. */
export function isAccountPage(path: string): boolean {
  return ACCOUNT_PAGES.some(
    (page) => path === page || path.startsWith(`${page}/`) || path.startsWith(`${page}?`),
  );
}

/** Where a path is read from, the way a browser would read it on the application's own address. Nothing is ever asked of this host. */
const ANYWHERE = 'http://application.invalid';

/**
 * The page a visitor wanted when they were sent to sign in, as a sign-in may
 * return to it: a page of an account, and nothing else. `next` in the address
 * of the sign-in page is anybody's to write, so it is read the way a browser
 * will read it (a `..` followed, a backslash taken for a slash, a tab
 * dropped), and whatever comes of that besides a page of an account (another
 * site, a script, a page of the API) is the home page instead.
 */
export function returnPath(asked: string | null | undefined): string {
  if (!asked) return HOME;
  let read: URL;
  try {
    read = new URL(asked, ANYWHERE);
  } catch {
    return HOME;
  }
  return read.origin === ANYWHERE && isAccountPage(read.pathname)
    ? `${read.pathname}${read.search}`
    : HOME;
}

/** The sign-in page for a visitor who was on `from`, so that signing in brings them back. */
export function signInPath(from: string): string {
  const back = returnPath(from);
  return back === HOME ? '/login' : `/login?next=${encodeURIComponent(back)}`;
}
