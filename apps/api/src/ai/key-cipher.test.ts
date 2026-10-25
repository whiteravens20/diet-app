// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { ciphertextWrittenBefore as writtenBefore } from '../testing/old-ciphertext.js';
import { isSealedForOwner, openKey, sealKey } from './key-cipher.js';

const SECRET = 'a1'.repeat(32);
const OTHER_SECRET = 'b2'.repeat(32);
const OWNER = '11111111-1111-4111-8111-111111111111';
const SOMEBODY_ELSE = '22222222-2222-4222-8222-222222222222';

/** The id `sealKey` puts in front of a key sealed under `secretHex`. */
const idOf = (secretHex: string): string => sealKey('x', secretHex, OWNER).split(':')[0]!;

describe('a stored provider key', () => {
  it('opens under the secret that sealed it, for the account it was sealed for', () => {
    expect(openKey(sealKey('sk-live-123', SECRET, OWNER), SECRET, OWNER)).toEqual({
      ok: true,
      key: 'sk-live-123',
    });
    expect(openKey(sealKey('sk-shared', SECRET, null), SECRET, null)).toEqual({
      ok: true,
      key: 'sk-shared',
    });
  });

  it('is sealed differently every time and never holds the key in the clear', () => {
    const first = sealKey('sk-live-123', SECRET, OWNER);
    expect(first).not.toBe(sealKey('sk-live-123', SECRET, OWNER));
    expect(first).not.toContain('sk-live-123');
    expect(first).not.toContain(SECRET.slice(0, 16));
    expect(first).not.toContain(OWNER);
    expect(isSealedForOwner(first)).toBe(true);
  });

  it('does not open in the row of another account, nor as the key of the instance', () => {
    const sealed = sealKey('sk-live-123', SECRET, OWNER);

    expect(openKey(sealed, SECRET, SOMEBODY_ELSE)).toEqual({ ok: false, why: 'damaged' });
    expect(openKey(sealed, SECRET, null)).toEqual({ ok: false, why: 'damaged' });
  });

  it('is recognised as sealed under another secret, without an attempt to open it', () => {
    expect(openKey(sealKey('sk-live-123', SECRET, OWNER), OTHER_SECRET, OWNER)).toEqual({
      ok: false,
      why: 'sealed under another secret',
    });
  });

  it('is reported as damaged when the id matches and the content does not open', () => {
    const sealed = sealKey('sk-live-123', SECRET, OWNER);
    const damaged = `${sealed.slice(0, -2)}${sealed.endsWith('00') ? '11' : '00'}`;
    expect(openKey(damaged, SECRET, OWNER)).toEqual({ ok: false, why: 'damaged' });
  });

  describe('stored before keys were bound to their owner', () => {
    it('still opens with the id of its secret in front, and is known for what it is', () => {
      const stored = `${idOf(SECRET)}:${writtenBefore('sk-mid-789', SECRET)}`;

      expect(openKey(stored, SECRET, OWNER)).toEqual({ ok: true, key: 'sk-mid-789' });
      expect(openKey(stored, OTHER_SECRET, OWNER)).toEqual({
        ok: false,
        why: 'sealed under another secret',
      });
      expect(isSealedForOwner(stored)).toBe(false);
    });

    it('still opens when it was stored before ids were written', () => {
      const stored = writtenBefore('sk-old-456', SECRET);

      expect(openKey(stored, SECRET, OWNER)).toEqual({ ok: true, key: 'sk-old-456' });
      expect(isSealedForOwner(stored)).toBe(false);
    });
  });

  it.each([
    ['one stored before ids, after the secret changed', writtenBefore('sk-old-456', OTHER_SECRET)],
    ['a value that is not a ciphertext at all', '00:00:00'],
    ['an empty value', ''],
    ['text', 'not a ciphertext'],
  ])('reports %s as unreadable instead of failing', (_name, stored) => {
    expect(openKey(stored, SECRET, OWNER)).toEqual({
      ok: false,
      why: 'damaged, or sealed under another secret',
    });
  });
});
