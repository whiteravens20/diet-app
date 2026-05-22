import { describe, expect, it } from 'vitest';
import { blindIndex, decrypt, deriveKey, encrypt, pepperPassword } from './crypto.js';

const KEY = 'a'.repeat(64); // 32 bytes hex
const KEY2 = 'b'.repeat(64);

describe('AES-256-GCM encryption', () => {
  it('round-trips a value', () => {
    const secret = 'user@example.com';
    expect(decrypt(encrypt(secret, KEY), KEY)).toBe(secret);
  });

  it('produces a different ciphertext each time (random IV)', () => {
    expect(encrypt('same', KEY)).not.toBe(encrypt('same', KEY));
  });

  it('rejects a tampered ciphertext', () => {
    const ct = encrypt('secret', KEY);
    const tampered = ct.slice(0, -2) + (ct.endsWith('0') ? '1' : '0');
    expect(() => decrypt(tampered, KEY)).toThrow();
  });

  it('rejects decryption with the wrong key', () => {
    expect(() => decrypt(encrypt('secret', KEY), KEY2)).toThrow();
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
