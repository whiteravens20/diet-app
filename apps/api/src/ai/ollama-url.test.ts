// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import {
  assertAllowedOllamaUrl,
  OllamaUrlError,
  parseAllowedHosts,
  type OllamaUserPolicy,
} from './ollama-url.js';

const DEFAULT = 'http://ollama:11434';

function opts(policy: OllamaUserPolicy, allowedHosts: string[] = []) {
  return { policy, defaultBaseUrl: DEFAULT, allowedHosts };
}

describe('parseAllowedHosts', () => {
  it('splits, trims and drops blanks', () => {
    expect(parseAllowedHosts('a.local, b.local:9090 ,, c.local')).toEqual([
      'a.local',
      'b.local:9090',
      'c.local',
    ]);
  });
  it('returns [] for undefined / empty', () => {
    expect(parseAllowedHosts(undefined)).toEqual([]);
    expect(parseAllowedHosts('   ')).toEqual([]);
  });
});

describe('assertAllowedOllamaUrl — operator default (every policy)', () => {
  for (const policy of ['off', 'allowlist', 'public'] as const) {
    it(`always trusts the operator default host under "${policy}"`, () => {
      expect(assertAllowedOllamaUrl('http://ollama:11434/api/tags', opts(policy)).host).toBe(
        'ollama:11434',
      );
    });
  }
});

describe('assertAllowedOllamaUrl — off', () => {
  it('rejects any non-default host with OLLAMA_USER_DISABLED', () => {
    try {
      assertAllowedOllamaUrl('https://my-ollama.example.com:11434', opts('off'));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(OllamaUrlError);
      expect((err as OllamaUrlError).code).toBe('OLLAMA_USER_DISABLED');
    }
  });
});

describe('assertAllowedOllamaUrl — allowlist', () => {
  it('rejects internal hosts not in the allowlist (SSRF)', () => {
    expect(() => assertAllowedOllamaUrl('http://169.254.169.254/latest', opts('allowlist'))).toThrow(
      OllamaUrlError,
    );
    expect(() => assertAllowedOllamaUrl('http://10.0.0.1:9090', opts('allowlist'))).toThrow(
      OllamaUrlError,
    );
    expect(() => assertAllowedOllamaUrl('http://localhost:5432', opts('allowlist'))).toThrow(
      OllamaUrlError,
    );
  });
  it('rejects a different port on the default host (port is pinned)', () => {
    expect(() => assertAllowedOllamaUrl('http://ollama:5432', opts('allowlist'))).toThrow(
      OllamaUrlError,
    );
  });
  it('honours a bare-host allowlist entry across all ports', () => {
    expect(() => assertAllowedOllamaUrl('http://gpu-box:1234', opts('allowlist', ['gpu-box']))).not.toThrow();
    expect(() => assertAllowedOllamaUrl('http://gpu-box:5678', opts('allowlist', ['gpu-box']))).not.toThrow();
  });
  it('honours a host:port allowlist entry exactly', () => {
    expect(() =>
      assertAllowedOllamaUrl('http://gpu-box:11434', opts('allowlist', ['gpu-box:11434'])),
    ).not.toThrow();
    expect(() =>
      assertAllowedOllamaUrl('http://gpu-box:9999', opts('allowlist', ['gpu-box:11434'])),
    ).toThrow(OllamaUrlError);
  });
  it('accepts a full-URL allowlist entry', () => {
    expect(() =>
      assertAllowedOllamaUrl('http://gpu-box:11434', opts('allowlist', ['http://gpu-box:11434'])),
    ).not.toThrow();
  });
});

describe('assertAllowedOllamaUrl — public', () => {
  it('allows any public host (user BYOK liberty)', () => {
    expect(() => assertAllowedOllamaUrl('https://ollama.my-domain.com', opts('public'))).not.toThrow();
    expect(() =>
      assertAllowedOllamaUrl('http://203.0.113.7:11434', opts('public')),
    ).not.toThrow();
  });
  it('still blocks cloud-metadata + private ranges (SSRF stays closed)', () => {
    expect(() => assertAllowedOllamaUrl('http://169.254.169.254/', opts('public'))).toThrow(
      OllamaUrlError,
    );
    expect(() => assertAllowedOllamaUrl('http://10.1.2.3', opts('public'))).toThrow(OllamaUrlError);
    expect(() => assertAllowedOllamaUrl('http://172.16.0.1', opts('public'))).toThrow(OllamaUrlError);
    expect(() => assertAllowedOllamaUrl('http://192.168.1.10', opts('public'))).toThrow(OllamaUrlError);
    expect(() => assertAllowedOllamaUrl('http://127.0.0.1:11434', opts('public'))).toThrow(OllamaUrlError);
    expect(() => assertAllowedOllamaUrl('http://100.64.0.1', opts('public'))).toThrow(OllamaUrlError);
  });
  it('blocks loopback / internal hostnames', () => {
    expect(() => assertAllowedOllamaUrl('http://localhost:11434', opts('public'))).toThrow(OllamaUrlError);
    expect(() => assertAllowedOllamaUrl('http://db.internal:5432', opts('public'))).toThrow(OllamaUrlError);
    expect(() => assertAllowedOllamaUrl('http://printer.local', opts('public'))).toThrow(OllamaUrlError);
    // single-label container/service name
    expect(() => assertAllowedOllamaUrl('http://postgres:5432', opts('public'))).toThrow(OllamaUrlError);
  });
  it('blocks IPv6 loopback / ULA / link-local + v4-mapped', () => {
    expect(() => assertAllowedOllamaUrl('http://[::1]:11434', opts('public'))).toThrow(OllamaUrlError);
    expect(() => assertAllowedOllamaUrl('http://[fd00::1]:11434', opts('public'))).toThrow(OllamaUrlError);
    expect(() => assertAllowedOllamaUrl('http://[fe80::1]:11434', opts('public'))).toThrow(OllamaUrlError);
    expect(() => assertAllowedOllamaUrl('http://[::ffff:10.0.0.1]:11434', opts('public'))).toThrow(
      OllamaUrlError,
    );
  });
});

describe('assertAllowedOllamaUrl — universal rejections', () => {
  it('rejects non-http(s) protocols', () => {
    expect(() => assertAllowedOllamaUrl('file:///etc/passwd', opts('public'))).toThrow(OllamaUrlError);
    expect(() => assertAllowedOllamaUrl('gopher://evil:70', opts('public'))).toThrow(OllamaUrlError);
  });
  it('rejects a malformed URL', () => {
    expect(() => assertAllowedOllamaUrl('not a url', opts('allowlist'))).toThrow(OllamaUrlError);
  });
  it('matches the default host case-insensitively', () => {
    expect(() => assertAllowedOllamaUrl('http://OLLAMA:11434', opts('off'))).not.toThrow();
  });
});
