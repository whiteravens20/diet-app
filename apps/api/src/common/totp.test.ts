// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { base32, codeAt, hotp, matchingStep, otpauthUri, stepAt } from './totp.js';

const ascii = (text: string): Buffer => Buffer.from(text, 'ascii');

describe('one-time codes by counter (RFC 4226, appendix D)', () => {
  const secret = ascii('12345678901234567890');
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];

  it.each(expected.map((code, counter) => [counter, code] as const))('counter %i gives %s', (counter, code) => {
    expect(hotp(secret, counter)).toBe(code);
  });
});

describe('one-time codes by time (RFC 6238, appendix B)', () => {
  const secrets = {
    sha1: ascii('12345678901234567890'),
    sha256: ascii('12345678901234567890123456789012'),
    sha512: ascii('1234567890123456789012345678901234567890123456789012345678901234'),
  } as const;
  const vectors: [seconds: number, sha1: string, sha256: string, sha512: string][] = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ];

  it.each(vectors)('at %i seconds', (seconds, sha1, sha256, sha512) => {
    const step = stepAt(seconds * 1000);
    expect(hotp(secrets.sha1, step, 8, 'sha1')).toBe(sha1);
    expect(hotp(secrets.sha256, step, 8, 'sha256')).toBe(sha256);
    expect(hotp(secrets.sha512, step, 8, 'sha512')).toBe(sha512);
  });

  it('counts steps of thirty seconds from the beginning of 1970', () => {
    expect(stepAt(0)).toBe(0);
    expect(stepAt(29_999)).toBe(0);
    expect(stepAt(30_000)).toBe(1);
    expect(stepAt(59_000)).toBe(1);
    expect(stepAt(1111111109_000)).toBe(37037036);
  });

  it('gives an authenticator the six digits of the step the time is in', () => {
    // The last six of the eight digits above: the same number, taken to fewer places.
    expect(codeAt(secrets.sha1, 59_000)).toBe('287082');
    expect(codeAt(secrets.sha1, 1111111109_000)).toBe('081804');
    expect(codeAt(secrets.sha1, 20000000000_000)).toBe('353130');
  });
});

describe('which step a code belongs to', () => {
  const secret = ascii('12345678901234567890');
  const at = 1111111109_000;
  const step = stepAt(at);

  it('is the present one, the one before or the one after', () => {
    expect(matchingStep(secret, codeAt(secret, at), at)).toBe(step);
    expect(matchingStep(secret, codeAt(secret, at - 30_000), at)).toBe(step - 1);
    expect(matchingStep(secret, codeAt(secret, at + 30_000), at)).toBe(step + 1);
  });

  it('is none for a code of a minute ago, or of a minute from now', () => {
    expect(matchingStep(secret, codeAt(secret, at - 60_000), at)).toBeNull();
    expect(matchingStep(secret, codeAt(secret, at + 60_000), at)).toBeNull();
  });

  it('is none for a code of another secret', () => {
    expect(matchingStep(ascii('09876543210987654321'), codeAt(secret, at), at)).toBeNull();
  });

  it.each(['', '08180', '0818044', 'abcdef', '081 804', '８１８０４０'])('is none for %j, which is no code', (code) => {
    expect(matchingStep(secret, code, at)).toBeNull();
  });
});

describe('a secret as an authenticator reads it (RFC 4648, base 32)', () => {
  it.each([
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ])('%j is written %s, without padding', (text, encoded) => {
    expect(base32(ascii(text))).toBe(encoded);
  });

  it('writes twenty bytes as thirty-two characters', () => {
    expect(base32(ascii('12345678901234567890'))).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });
});

describe('what an authenticator scans', () => {
  it('names the application and the account, and says how the codes are made', () => {
    const uri = new URL(otpauthUri({ secret: ascii('12345678901234567890'), issuer: 'Diet App (diet.example)', account: 'anna+test@example.com' }));
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.host).toBe('totp');
    expect(decodeURIComponent(uri.pathname)).toBe('/Diet App (diet.example):anna+test@example.com');
    expect(Object.fromEntries(uri.searchParams)).toEqual({
      secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      issuer: 'Diet App (diet.example)',
      algorithm: 'SHA1',
      digits: '6',
      period: '30',
    });
  });

  it('keeps a colon out of the names, where it would part them', () => {
    const uri = otpauthUri({ secret: ascii('12345678901234567890'), issuer: 'Diet: App', account: 'a:b' });
    expect(decodeURIComponent(new URL(uri).pathname)).toBe('/Diet App:ab');
    expect(new URL(uri).searchParams.get('issuer')).toBe('Diet App');
  });
});
