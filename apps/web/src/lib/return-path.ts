// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * The pages of a signed-in account, by the first part of their path. The
 * proxy guards them (its own list has to be written out, and a test holds
 * the two to each other), and a sign-in leads back to one of them only.
 */
export const ACCOUNT_PAGES = ['/dashboard', '/profile', '/recipes', '/meal-plans', '/shopping-lists', '/inventory', '/settings'] as const;

/** Where somebody lands after signing in when no other page was asked for. */
export const HOME = '/dashboard';

/** True for the path of a page of an account, with whatever it was asked with. */
export function isAccountPage(path: string): boolean {
  return ACCOUNT_PAGES.some((page) => path === page || path.startsWith(`${page}/`) || path.startsWith(`${page}?`));
}

/**
 * The page a visitor wanted when they were sent to sign in, as a sign-in may
 * return to it: a page of an account, and nothing else. `next` in the address
 * of the sign-in page is anybody's to write, so whatever it holds besides
 * (another site, a script, a page of the API) is the home page instead.
 */
export function returnPath(asked: string | null | undefined): string {
  return asked && isAccountPage(asked) ? asked : HOME;
}

/** The sign-in page for a visitor who was on `from`, so that signing in brings them back. */
export function signInPath(from: string): string {
  const back = returnPath(from);
  return back === HOME ? '/login' : `/login?next=${encodeURIComponent(back)}`;
}
