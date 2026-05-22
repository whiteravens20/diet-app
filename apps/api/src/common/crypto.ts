/**
 * Cryptographic primitives for protecting data at rest.
 *
 * Used for AI provider API keys and user email addresses. The goal is that a
 * database dump — or a curious administrator — never sees plaintext: emails are
 * encrypted, passwords are hashed + peppered, and lookups go through a keyed
 * blind index rather than the plaintext value.
 *
 * All keys are 32-byte values supplied as 64 hex characters.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

/**
 * AES-256-GCM encryption. Ciphertext format: `iv:authTag:data`, all hex.
 * A fresh random IV per call means the same plaintext encrypts differently
 * every time — so an encrypted column cannot be queried by equality (use
 * `blindIndex` for that).
 */
export function encrypt(plaintext: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${data.toString('hex')}`;
}

/** Reverses {@link encrypt}. Throws if the ciphertext was tampered with. */
export function decrypt(ciphertext: string, keyHex: string): string {
  const [ivHex, tagHex, dataHex] = ciphertext.split(':');
  if (!ivHex || !tagHex || !dataHex) throw new Error('malformed ciphertext');
  const key = Buffer.from(keyHex, 'hex');
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Deterministic keyed hash (HMAC-SHA256) for equality lookups on an otherwise
 * encrypted column — a "blind index". The same input always yields the same
 * output, so it can carry a UNIQUE constraint and back a `findUnique`, while
 * revealing nothing without the key.
 */
export function blindIndex(value: string, keyHex: string): string {
  return createHmac('sha256', Buffer.from(keyHex, 'hex')).update(value).digest('hex');
}

/**
 * HKDF-derives a 32-byte (64 hex) purpose-specific key from a master secret.
 * One configured secret thus yields independent keys for encryption, blind
 * indexing and the password pepper — compromising one purpose does not leak
 * the others.
 */
export function deriveKey(masterHex: string, purpose: string): string {
  const derived = hkdfSync('sha256', Buffer.from(masterHex, 'hex'), '', purpose, 32);
  return Buffer.from(derived).toString('hex');
}

/**
 * Peppers a password before bcrypt: HMAC-SHA256 with an app-only key, base64
 * encoded. A stolen database (without the key) cannot be brute-forced offline,
 * and the fixed-length output sidesteps bcrypt's 72-byte input truncation.
 */
export function pepperPassword(password: string, keyHex: string): string {
  return createHmac('sha256', Buffer.from(keyHex, 'hex')).update(password, 'utf8').digest('base64');
}
