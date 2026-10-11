// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * What a session is called where an account looks at its sessions: the
 * browser and the system it was opened from, as far as the request said
 * ("Firefox on Linux"). Only these two names are kept of the User-Agent
 * header: the rest of it tells one visitor from another, and nothing here
 * needs that.
 */
export function sessionLabel(userAgent: string | undefined): string | null {
  if (!userAgent) return null;
  const system = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1] ?? null;
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1] ?? clientName(userAgent);
  if (browser && system) return `${browser} on ${system}`;
  return browser ?? system;
}

// The first that matches: a browser built on another names that one too.
const BROWSERS: [RegExp, string][] = [
  [/\bEdg(e|A|iOS)?\//, 'Edge'],
  [/\bOPR\//, 'Opera'],
  [/\bFirefox\//, 'Firefox'],
  [/\bChrome\//, 'Chrome'],
  [/\bVersion\/[\d.]+ .*Safari\//, 'Safari'],
];

const SYSTEMS: [RegExp, string][] = [
  [/\bAndroid\b/, 'Android'],
  [/\b(iPhone|iPad|iPod)\b/, 'iOS'],
  [/\bWindows NT\b/, 'Windows'],
  [/\bMac OS X\b/, 'macOS'],
  [/\bLinux\b/, 'Linux'],
];

/** What a client that is no browser calls itself: the product name its header begins with. */
function clientName(userAgent: string): string | null {
  const name = /^([A-Za-z][A-Za-z0-9._-]{0,39})\//.exec(userAgent)?.[1];
  return name && name !== 'Mozilla' ? name : null;
}
