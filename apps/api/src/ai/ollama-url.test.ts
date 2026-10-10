// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import {
  assertAllowedOllamaUrl,
  isOperatorOllama,
  isPublicAddress,
  OllamaUrlError,
  parseAllowedHosts,
  type OllamaUserPolicy,
} from './ollama-url.js';

const DEFAULT = 'http://ollama:11434';

function opts(policy: OllamaUserPolicy, allowedHosts: string[] = []) {
  return { policy, defaultBaseUrl: DEFAULT, allowedHosts };
}

const refused = (url: string, policy: OllamaUserPolicy, allowedHosts: string[] = []): OllamaUrlError => {
  try {
    assertAllowedOllamaUrl(url, opts(policy, allowedHosts));
  } catch (err) {
    expect(err).toBeInstanceOf(OllamaUrlError);
    return err as OllamaUrlError;
  }
  throw new Error(`${url} was expected to be refused under "${policy}"`);
};

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

describe("the operator's own instance in a user's configuration", () => {
  it.each(['allowlist', 'public'] as const)('is allowed under "%s" and marked as the operator\'s to pay for', (policy) => {
    expect(assertAllowedOllamaUrl('http://ollama:11434/api/tags', opts(policy))).toMatchObject({
      operatorHost: true,
      publicOnly: false,
    });
  });

  it.each([
    'http://OLLAMA:11434',
    'http://ollama.:11434',
    'http://ollama:11434/some/path',
  ])('is recognised when written as %s', (url) => {
    expect(isOperatorOllama(url, DEFAULT)).toBe(true);
  });

  it.each([
    'http://ollama:5432',
    'http://ollama',
    'https://ollama:11434.evil.example',
    'http://other:11434',
    'not a url',
  ])('is not confused with %s', (url) => {
    expect(isOperatorOllama(url, DEFAULT)).toBe(false);
  });

  it('compares the port a connection would use, written or not', () => {
    expect(isOperatorOllama('http://ollama:80', 'http://ollama')).toBe(true);
    expect(isOperatorOllama('https://ollama', 'http://ollama')).toBe(false);
  });
});

describe('policy off', () => {
  it.each(['https://my-ollama.example.com:11434', 'http://ollama:11434', 'http://gpu-box:11434'])(
    'refuses %s: a user configures no Ollama at all',
    (url) => {
      expect(refused(url, 'off', ['gpu-box']).code).toBe('OLLAMA_USER_DISABLED');
    },
  );
});

describe('policy allowlist', () => {
  it.each(['http://169.254.169.254/latest', 'http://10.0.0.1:9090', 'http://localhost:5432', 'https://ollama.example.com'])(
    'refuses %s, which is not on the list',
    (url) => {
      expect(refused(url, 'allowlist').code).toBe('OLLAMA_HOST_NOT_ALLOWED');
    },
  );

  it('refuses a different port on the operator\'s host (the port is part of the entry)', () => {
    refused('http://ollama:5432', 'allowlist');
  });

  it('honours a bare-host entry across all ports', () => {
    expect(() => assertAllowedOllamaUrl('http://gpu-box:1234', opts('allowlist', ['gpu-box']))).not.toThrow();
    expect(() => assertAllowedOllamaUrl('http://gpu-box:5678', opts('allowlist', ['gpu-box']))).not.toThrow();
  });

  it('honours a host:port entry exactly', () => {
    expect(() =>
      assertAllowedOllamaUrl('http://gpu-box:11434', opts('allowlist', ['gpu-box:11434'])),
    ).not.toThrow();
    refused('http://gpu-box:9999', 'allowlist', ['gpu-box:11434']);
  });

  it('accepts a full-URL entry', () => {
    expect(() =>
      assertAllowedOllamaUrl('http://gpu-box:11434', opts('allowlist', ['http://gpu-box:11434'])),
    ).not.toThrow();
  });

  it('trusts where a listed name resolves: the operator vouched for it', () => {
    expect(assertAllowedOllamaUrl('http://gpu-box.lan:11434', opts('allowlist', ['gpu-box.lan']))).toMatchObject({
      operatorHost: false,
      publicOnly: false,
    });
  });
});

describe('policy public', () => {
  it.each(['https://ollama.my-domain.com', 'http://203.0.113.7:11434', 'http://[2606:4700:4700::1111]:11434'])(
    'allows %s, to be dialled only at a public address',
    (url) => {
      expect(assertAllowedOllamaUrl(url, opts('public'))).toMatchObject({ operatorHost: false, publicOnly: true });
    },
  );

  it.each([
    // Private, loopback, link-local and carrier-grade ranges.
    'http://169.254.169.254/',
    'http://10.1.2.3',
    'http://172.16.0.1',
    'http://192.168.1.10',
    'http://127.0.0.1:11434',
    'http://100.64.0.1',
    'http://0.0.0.0:11434',
    // Other ways to write 127.0.0.1.
    'http://2130706433/',
    'http://0x7f.1/',
    'http://127.1/',
    // Reserved ranges that are not private but lead nowhere public.
    'http://198.18.0.1',
    'http://224.0.0.1',
    'http://240.0.0.1',
    'http://255.255.255.255',
    'http://192.0.0.8',
  ])('refuses the internal or reserved address %s', (url) => {
    refused(url, 'public');
  });

  it.each([
    'http://localhost:11434',
    'http://db.internal:5432',
    'http://printer.local',
    // A single label is a container or service name.
    'http://postgres:5432',
    // A trailing dot names the same host.
    'http://postgres.:5432/',
    'http://api.:4000/',
    'http://localhost.:11434/',
    'http://db.internal.:5432',
  ])('refuses the internal name %s', (url) => {
    refused(url, 'public');
  });

  it.each([
    'http://[::1]:11434',
    'http://[::]:11434',
    'http://[fd00::1]:11434',
    'http://[fe80::1]:11434',
    'http://[fec0::1]:11434',
    'http://[ff02::1]:11434',
    // IPv4 carried inside IPv6, in each of the forms that exist.
    'http://[::ffff:10.0.0.1]:11434',
    'http://[::ffff:a00:1]:11434',
    'http://[::127.0.0.1]:11434',
    'http://[::ffff:0:7f00:1]:11434',
    'http://[64:ff9b::7f00:1]:11434',
    'http://[2002:7f00:1::]:11434',
    'http://[2001::1]:11434',
  ])('refuses the IPv6 address %s', (url) => {
    refused(url, 'public');
  });
});

describe('under every policy', () => {
  it.each(['file:///etc/passwd', 'gopher://evil:70', 'ftp://ollama:11434'])('refuses the protocol of %s', (url) => {
    refused(url, 'public');
    refused(url, 'allowlist');
  });

  it('refuses a malformed URL', () => {
    refused('not a url', 'allowlist');
    refused('http://999.1.1.1', 'public');
  });
});

describe('isPublicAddress', () => {
  it.each(['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('%s is public', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each([
    '127.0.0.1',
    '10.0.0.5',
    '172.31.255.255',
    '192.168.0.1',
    '169.254.169.254',
    '100.127.0.1',
    '198.19.0.1',
    '239.255.255.250',
    '::1',
    'fd12:3456::1',
    'fe80::1',
    '::ffff:192.168.0.1',
    '64:ff9b::a00:1',
    'not-an-address',
    '',
  ])('%s is not', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
});
