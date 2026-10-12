// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { PolicyReport } from '@diet-app/shared';
import { describe, expect, it } from 'vitest';
import { kindOf, MOST_PER_REQUEST, violationsIn as read, worded } from './violation.js';

/** The violations in a body, as the route reads it: checked against the contract first. */
const violationsIn = (body: unknown) => read(PolicyReport.parse(body));

const APP = 'https://diet.example.test';

/** What `report-uri` makes a browser send. */
const posted = (report: Record<string, unknown>): unknown => ({ 'csp-report': report });
/** One of the reports `report-to` makes a browser send. */
const queued = (body: Record<string, unknown>, type = 'csp-violation'): unknown => ({ type, age: 12, url: `${APP}/meal-plans`, user_agent: 'A browser', body });

describe('a report against the content security policy', () => {
  it('is read as a browser posts it', () => {
    const [violation] = violationsIn(
      posted({
        'document-uri': `${APP}/meal-plans?profile=0b1f`,
        referrer: `${APP}/dashboard`,
        'violated-directive': 'script-src-elem',
        'effective-directive': 'script-src-elem',
        'original-policy': "default-src 'self'; script-src 'self' 'nonce-abc'",
        disposition: 'enforce',
        'blocked-uri': 'inline',
        'line-number': 1,
        'column-number': 4821,
        'source-file': `${APP}/_next/static/chunks/0a1b.js`,
        'status-code': 200,
        'script-sample': 'alert(document.cookie)',
      }),
    );

    expect(violation).toEqual({ disposition: 'enforce', directive: 'script-src-elem', blocked: 'inline', page: '/meal-plans', source: '/_next/static/chunks/0a1b.js:1:4821' });
  });

  it('is read as a browser sends the ones it had waiting, and only those about the policy', () => {
    const violations = violationsIn([
      queued({ documentURL: `${APP}/recipes/0b1f`, effectiveDirective: 'img-src', blockedURL: 'https://pictures.example/a/b.png?size=2', disposition: 'report', sourceFile: undefined }),
      queued({ id: 'SomeOldFeature', message: 'is deprecated' }, 'deprecation'),
      queued({ documentURL: `${APP}/login`, effectiveDirective: 'script-src', blockedURL: 'eval', disposition: 'enforce', sourceFile: `${APP}/_next/static/chunks/zz.js`, lineNumber: 3, columnNumber: 20249 }),
    ]);

    expect(violations).toEqual([
      { disposition: 'report', directive: 'img-src', blocked: 'https://pictures.example', page: '/recipes/0b1f', source: '' },
      { disposition: 'enforce', directive: 'script-src', blocked: 'eval', page: '/login', source: '/_next/static/chunks/zz.js:3:20249' },
    ]);
  });

  it('keeps nothing of the page\'s address but its path: a query can hold a token from a mail', () => {
    const [violation] = violationsIn(posted({ 'document-uri': `${APP}/reset-password?token=0123456789abcdef#top`, 'effective-directive': 'style-src-elem', 'blocked-uri': 'inline' }));

    expect(JSON.stringify(violation)).not.toContain('0123456789abcdef');
    expect(violation!.page).toBe('/reset-password');
  });

  it('keeps of what was blocked only where it came from', () => {
    const blocked = (uri: string): string => violationsIn(posted({ 'document-uri': `${APP}/`, 'effective-directive': 'connect-src', 'blocked-uri': uri }))[0]!.blocked;

    expect(blocked('https://collector.example/track?user=42&session=abc')).toBe('https://collector.example');
    expect(blocked('wss://collector.example:8443/socket')).toBe('wss://collector.example:8443');
    expect(blocked('data:text/html;base64,PHNjcmlwdD4=')).toBe('data');
    expect(blocked('blob:https://diet.example.test/0b1f')).toBe('https://diet.example.test');
    expect(blocked('wasm-eval')).toBe('wasm-eval');
    expect(blocked('not an address')).toBe('unknown');
    expect(blocked('')).toBe('unknown');
  });

  it('names a file of another site by the site, and a file of the application by its path', () => {
    const source = (file: string): string => violationsIn(posted({ 'document-uri': `${APP}/`, 'effective-directive': 'script-src', 'blocked-uri': 'eval', 'source-file': file, 'line-number': 7 }))[0]!.source;

    expect(source(`${APP}/_next/static/chunks/a.js?v=1`)).toBe('/_next/static/chunks/a.js:7');
    expect(source('https://cdn.example/lib/thing.js?key=secret')).toBe('https://cdn.example:7');
    // Something a browser extension put into the page: that it was one is enough.
    expect(source('chrome-extension://abcdefgh/content.js')).toBe('chrome-extension:7');
  });

  it('lets a sender write nothing into the log: no line break, no escape sequence, nothing without end', () => {
    const [violation] = violationsIn(
      posted({
        'document-uri': `${APP}/dash\nboard\r\n2026-10-12 ERROR [Auth] administrator signed in\u001b[31m`,
        'effective-directive': 'script-src\nFAKE LINE',
        'blocked-uri': `https://x.example/${'a'.repeat(3000)}`,
        'source-file': `${APP}/${'%0A'.repeat(200)}`,
      }),
    );
    const line = worded(violation!);

    // Printable characters only: no line break that would begin a line of the sender's own, no escape that would colour one.
    expect([...line].every((character) => character >= ' ' && character <= '~')).toBe(true);
    expect(line).not.toContain(' ERROR ');
    // Of a directive only its first word is taken, and only when it is written like one.
    expect(violation!.directive).toBe('script-src');
    expect(violationsIn(posted({ 'effective-directive': 'script-src;\nFAKE' }))[0]!.directive).toBe('unknown');
    expect(line.length).toBeLessThan(400);
  });

  it('takes the directive from the older field when the newer one is missing', () => {
    expect(violationsIn(posted({ 'violated-directive': "script-src 'self' 'nonce-abc'" }))[0]!.directive).toBe('script-src');
  });

  it('counts as enforced unless the browser says that the policy only watched', () => {
    expect(violationsIn(posted({ disposition: 'report' }))[0]!.disposition).toBe('report');
    expect(violationsIn(posted({}))[0]!.disposition).toBe('enforce');
    expect(violationsIn(posted({ disposition: 'whatever' }))[0]!.disposition).toBe('enforce');
  });

  it.each([null, undefined, 'a string', 42, {}, { 'csp-report': 'not a report' }, { 'csp-report': { 'line-number': 'seven' } }, [{ type: 7 }], [['nested']]])('is not what the body %j is', (body) => {
    expect(PolicyReport.safeParse(body).success).toBe(false);
  });

  it('is not a body with a field longer than any address, or with more reports than a browser keeps waiting', () => {
    expect(PolicyReport.safeParse(posted({ 'document-uri': `${APP}/${'a'.repeat(5000)}` })).success).toBe(false);
    expect(PolicyReport.safeParse(Array.from({ length: 101 }, () => queued({}))).success).toBe(false);
  });

  it('is read for a handful of reports at most, however many a request carries', () => {
    const many = Array.from({ length: MOST_PER_REQUEST + 30 }, (_, index) => queued({ documentURL: `${APP}/p${index}`, effectiveDirective: 'img-src', blockedURL: 'data' }));

    expect(violationsIn(many)).toHaveLength(MOST_PER_REQUEST);
  });
});

describe('two violations', () => {
  const one = { disposition: 'enforce', directive: 'script-src-elem', blocked: 'inline', page: '/meal-plans', source: '/_next/static/chunks/a.js:1:2' } as const;

  it('are of one kind when only the page differs', () => {
    expect(kindOf(one)).toBe(kindOf({ ...one, page: '/recipes' }));
  });

  it('are of two kinds when the directive, what was blocked, the file or the mode differs', () => {
    const kinds = new Set([one, { ...one, directive: 'style-src-elem' }, { ...one, blocked: 'eval' }, { ...one, source: '/_next/static/chunks/b.js:1:2' }, { ...one, disposition: 'report' as const }].map(kindOf));

    expect(kinds.size).toBe(5);
  });

  it('are said in a line each', () => {
    expect(worded(one)).toBe('script-src-elem blocked inline on /meal-plans (/_next/static/chunks/a.js:1:2)');
    expect(worded({ ...one, disposition: 'report', source: '' })).toBe('script-src-elem would block inline on /meal-plans');
  });
});
