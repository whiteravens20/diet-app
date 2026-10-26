// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import {
  contentSecurityPolicy,
  POLICY_REPORTS,
  SECURITY_HEADERS,
  TRANSPORT_HEADERS,
} from './security-headers';

/** A policy as a browser reads it: each directive with its values. */
function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split('; ').map((directive) => {
      const [name, ...values] = directive.split(' ');
      return [name!, values] as const;
    }),
  );
}

const NONCE = 'q83vEjRWeJASNFZ4mrze8A==';
const at = (settings: { https?: boolean; turnstile?: boolean } = {}): Map<string, string[]> =>
  directives(contentSecurityPolicy({ nonce: NONCE, https: false, turnstile: false, ...settings }));

describe('the headers every response of the web application carries', () => {
  const byKey = new Map(SECURITY_HEADERS.map((h) => [h.key.toLowerCase(), h.value]));

  it('forbid sniffing and framing, and keep a referrer short', () => {
    expect(byKey.get('x-content-type-options')).toBe('nosniff');
    expect(byKey.get('x-frame-options')).toBe('DENY');
    expect(byKey.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(byKey.get('permissions-policy')).toContain('camera=()');
  });

  it('hold nothing that depends on the request or the instance: no policy with a nonce, no header for https alone', () => {
    expect(
      [...byKey.keys()].filter(
        (key) => key.includes('content-security-policy') || key === 'strict-transport-security',
      ),
    ).toEqual([]);
  });
});

describe('the headers of an instance served over https', () => {
  const byKey = new Map(TRANSPORT_HEADERS.map((h) => [h.key.toLowerCase(), h.value]));

  it('keep browsers to https for two years, subdomains too, and leave the preload list to the owner of the domain', () => {
    expect(byKey.get('strict-transport-security')).toBe('max-age=63072000; includeSubDomains');
  });

  it('name the endpoint the policy reports to', () => {
    expect(byKey.get('reporting-endpoints')).toBe(`csp="${POLICY_REPORTS}"`);
  });
});

describe('the content security policy of a page', () => {
  it('runs only the scripts that carry the nonce of the response, and what they load', () => {
    expect(at().get('script-src')).toEqual([
      "'self'",
      `'nonce-${NONCE}'`,
      "'strict-dynamic'",
      "'wasm-unsafe-eval'",
    ]);
  });

  it('lets no script make code from text, and none run from the page itself; compiling WebAssembly is all it allows of the kind', () => {
    const scripts = at({ https: true, turnstile: true }).get('script-src')!;

    expect(scripts).not.toContain("'unsafe-eval'");
    expect(scripts).not.toContain("'unsafe-inline'");
    expect(scripts).not.toContain("'unsafe-hashes'");
    // No address a script may come from besides the application's own: a list of hosts is a list of ways in.
    expect(scripts.join(' ')).not.toMatch(/https?:|\*/);
  });

  it('wants the nonce on a style tag as on a script, and allows a style attribute', () => {
    expect(at().get('style-src-elem')).toEqual(["'self'", `'nonce-${NONCE}'`]);
    expect(at().get('style-src-attr')).toEqual(["'unsafe-inline'"]);
  });

  it("takes everything else from the application's own address", () => {
    const policy = at();

    expect(policy.get('default-src')).toEqual(["'self'"]);
    // `data:` is no address anything is sent to: the layout library of the printed list reads itself from one.
    expect(policy.get('connect-src')).toEqual(["'self'", 'data:']);
    // No worker at all, so a script that got into a page cannot register one that outlives it.
    expect(policy.get('worker-src')).toEqual(["'none'"]);
    expect(policy.get('base-uri')).toEqual(["'self'"]);
    expect(policy.get('form-action')).toEqual(["'self'"]);
    expect(policy.get('object-src')).toEqual(["'none'"]);
    expect(policy.get('img-src')).toEqual(["'self'", 'data:', 'blob:']);
  });

  it('frames nothing, and may be framed by nobody', () => {
    expect(at().get('frame-src')).toEqual(["'none'"]);
    expect(at().get('frame-ancestors')).toEqual(["'none'"]);
  });

  it('allows the frame of the Turnstile challenge where the instance uses one, and nothing else of it', () => {
    const [without, with_] = [at(), at({ turnstile: true })];

    expect(with_.get('frame-src')).toEqual(['https://challenges.cloudflare.com']);
    // Its script is loaded by a script of the page, which the policy trusts: it needs no entry of its own.
    expect(with_.get('script-src')).toEqual(without.get('script-src'));
    expect(with_.get('connect-src')).toEqual(without.get('connect-src'));
  });

  it('says where to report what it blocked', () => {
    expect(at().get('report-uri')).toEqual([POLICY_REPORTS]);
  });

  it("upgrades http requests and reports to the named endpoint only on an https instance: on http the upgrade would break the application's own requests", () => {
    expect(at().has('upgrade-insecure-requests')).toBe(false);
    expect(at().has('report-to')).toBe(false);
    expect(at({ https: true }).has('upgrade-insecure-requests')).toBe(true);
    expect(at({ https: true }).get('report-to')).toEqual(['csp']);
  });

  it('is one line a header can carry', () => {
    expect(contentSecurityPolicy({ nonce: NONCE, https: true, turnstile: true })).not.toMatch(
      /[\r\n]/,
    );
  });
});
