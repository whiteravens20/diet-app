import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from './crypto.js';

const KEY = 'a'.repeat(64); // 32 bytes hex

describe('AES-256-GCM secret encryption', () => {
  it('round-trips a value', () => {
    const secret = 'sk-test-1234567890';
    expect(decryptSecret(encryptSecret(secret, KEY), KEY)).toBe(secret);
  });

  it('produces a different ciphertext each time (random IV)', () => {
    expect(encryptSecret('same', KEY)).not.toBe(encryptSecret('same', KEY));
  });

  it('rejects a tampered ciphertext', () => {
    const ct = encryptSecret('secret', KEY);
    const tampered = ct.slice(0, -2) + (ct.endsWith('0') ? '1' : '0');
    expect(() => decryptSecret(tampered, KEY)).toThrow();
  });
});
