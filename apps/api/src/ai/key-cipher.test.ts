// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { encrypt } from '../common/crypto.js';
import { openKey, sealKey } from './key-cipher.js';

const SECRET = 'a1'.repeat(32);
const OTHER_SECRET = 'b2'.repeat(32);

describe('a stored provider key', () => {
  it('opens under the secret that sealed it', () => {
    expect(openKey(sealKey('sk-live-123', SECRET), SECRET)).toEqual({ ok: true, key: 'sk-live-123' });
  });

  it('is sealed differently every time and never holds the key in the clear', () => {
    const first = sealKey('sk-live-123', SECRET);
    expect(first).not.toBe(sealKey('sk-live-123', SECRET));
    expect(first).not.toContain('sk-live-123');
    expect(first).not.toContain(SECRET.slice(0, 16));
  });

  it('is recognised as sealed under another secret, without an attempt to open it', () => {
    expect(openKey(sealKey('sk-live-123', SECRET), OTHER_SECRET)).toEqual({
      ok: false,
      why: 'sealed under another secret',
    });
  });

  it('is reported as damaged when the id matches and the content does not open', () => {
    const sealed = sealKey('sk-live-123', SECRET);
    const damaged = `${sealed.slice(0, -2)}${sealed.endsWith('00') ? '11' : '00'}`;
    expect(openKey(damaged, SECRET)).toEqual({ ok: false, why: 'damaged' });
  });

  it('still opens when it was stored before ids were written', () => {
    expect(openKey(encrypt('sk-old-456', SECRET), SECRET)).toEqual({ ok: true, key: 'sk-old-456' });
  });

  it.each([
    ['one stored before ids, after the secret changed', encrypt('sk-old-456', OTHER_SECRET)],
    ['a value that is not a ciphertext at all', '00:00:00'],
    ['an empty value', ''],
    ['text', 'not a ciphertext'],
  ])('reports %s as unreadable instead of failing', (_name, stored) => {
    expect(openKey(stored, SECRET)).toEqual({ ok: false, why: 'damaged, or sealed under another secret' });
  });
});
