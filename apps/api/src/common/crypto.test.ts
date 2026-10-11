// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { ciphertextWrittenBefore as writtenBefore } from '../testing/old-ciphertext.js';
import { blindIndex, decrypt, deriveKey, encrypt, inCurrentForm, pepperPassword } from './crypto.js';

const KEY = 'a'.repeat(64); // 32 bytes hex
const KEY2 = 'b'.repeat(64);

describe('a value encrypted for storage', () => {
  const MINE = 'user-email:11111111-1111-4111-8111-111111111111';
  const THEIRS = 'user-email:22222222-2222-4222-8222-222222222222';

  it('reads back as what it was', () => {
    expect(decrypt(encrypt('user@example.com', KEY, MINE), KEY, MINE)).toBe('user@example.com');
  });

  it('is written with a version, a nonce of 12 bytes and a tag of 16', () => {
    expect(encrypt('user@example.com', KEY, MINE)).toMatch(/^v2:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);
    expect(inCurrentForm(encrypt('user@example.com', KEY, MINE))).toBe(true);
  });

  it('is written differently every time', () => {
    expect(encrypt('same', KEY, MINE)).not.toBe(encrypt('same', KEY, MINE));
  });

  it('does not open once a byte of it was changed', () => {
    const stored = encrypt('secret', KEY, MINE);
    const changed = stored.slice(0, -2) + (stored.endsWith('0') ? '1' : '0');
    expect(() => decrypt(changed, KEY, MINE)).toThrow();
  });

  it('does not open with another key', () => {
    expect(() => decrypt(encrypt('secret', KEY, MINE), KEY2, MINE)).toThrow();
  });

  it('opens only as what it was written as: not in another row, and not as another kind of value', () => {
    const stored = encrypt('user@example.com', KEY, MINE);

    expect(() => decrypt(stored, KEY, THEIRS)).toThrow();
    expect(() => decrypt(stored, KEY, 'pending-email:11111111-1111-4111-8111-111111111111')).toThrow();
  });

  it('does not open with a shortened tag', () => {
    const [version, iv, tag, data] = encrypt('secret', KEY, MINE).split(':');

    // Four bytes of the tag would verify if the length were not fixed.
    expect(() => decrypt([version, iv, tag!.slice(0, 8), data].join(':'), KEY, MINE)).toThrow('malformed ciphertext');
  });

  it.each([
    ['a nonce of another length', (iv: string, tag: string, data: string) => `v2:${iv.slice(2)}:${tag}:${data}`],
    ['no data', (iv: string, tag: string) => `v2:${iv}:${tag}:`],
    ['a part too many', (iv: string, tag: string, data: string) => `v2:${iv}:${tag}:${data}:00`],
    ['text that is no hex', (iv: string, tag: string) => `v2:${iv}:${tag}:not-hex`],
    ['a version nobody wrote', (iv: string, tag: string, data: string) => `v9:${iv}:${tag}:${data}`],
  ])('refuses %s', (_name, make) => {
    const [, iv, tag, data] = encrypt('secret', KEY, MINE).split(':');

    expect(() => decrypt(make(iv!, tag!, data!), KEY, MINE)).toThrow();
  });

  describe('written before the form had a version', () => {
    it('still opens, whoever it is read for: nothing was bound to it', () => {
      const old = writtenBefore('user@example.com', KEY);

      expect(inCurrentForm(old)).toBe(false);
      expect(decrypt(old, KEY, MINE)).toBe('user@example.com');
      expect(decrypt(old, KEY, THEIRS)).toBe('user@example.com');
    });

    it('does not open with a shortened tag either', () => {
      const [iv, tag, data] = writtenBefore('secret', KEY).split(':');

      expect(() => decrypt([iv, tag!.slice(0, 8), data].join(':'), KEY, MINE)).toThrow('malformed ciphertext');
    });

    it('is not what a value of the current form becomes when its version is cut off', () => {
      const stored = encrypt('user@example.com', KEY, MINE);

      expect(() => decrypt(stored.slice('v2:'.length), KEY, THEIRS)).toThrow();
    });
  });
});

describe('blind index', () => {
  it('is deterministic for the same input and key', () => {
    expect(blindIndex('a@example.com', KEY)).toBe(blindIndex('a@example.com', KEY));
  });

  it('differs for different inputs', () => {
    expect(blindIndex('a@example.com', KEY)).not.toBe(blindIndex('b@example.com', KEY));
  });

  it('differs under a different key', () => {
    expect(blindIndex('a@example.com', KEY)).not.toBe(blindIndex('a@example.com', KEY2));
  });
});

describe('deriveKey', () => {
  it('is deterministic and yields a 64-hex key', () => {
    const k = deriveKey(KEY, 'email-encryption');
    expect(k).toBe(deriveKey(KEY, 'email-encryption'));
    expect(k).toMatch(/^[0-9a-f]{64}$/);
  });

  it('yields independent keys per purpose', () => {
    expect(deriveKey(KEY, 'email-encryption')).not.toBe(deriveKey(KEY, 'email-index'));
  });
});

describe('pepperPassword', () => {
  it('is deterministic for the same password and key', () => {
    expect(pepperPassword('hunter2hunter2', KEY)).toBe(pepperPassword('hunter2hunter2', KEY));
  });

  it('differs under a different key', () => {
    expect(pepperPassword('hunter2hunter2', KEY)).not.toBe(pepperPassword('hunter2hunter2', KEY2));
  });
});
