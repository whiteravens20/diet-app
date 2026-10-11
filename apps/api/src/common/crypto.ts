// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

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
const TAG_BYTES = 16;
const VERSION = 'v2';

/**
 * AES-256-GCM encryption for a value that is stored. Written as
 * `v2:iv:tag:data`, the last three in hex. A fresh random IV per call means
 * the same plaintext encrypts differently every time, so an encrypted column
 * cannot be queried by equality (use `blindIndex` for that).
 *
 * `context` says what the value is and whose (`user-email:<user id>`). It is
 * bound into the ciphertext without being stored, and the value opens only
 * when the same context is given: a ciphertext copied into another row, or
 * into another column, does not open there.
 */
export function encrypt(plaintext: string, keyHex: string, context: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, Buffer.from(keyHex, 'hex'), iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('hex'), cipher.getAuthTag().toString('hex'), data.toString('hex')].join(':');
}

/**
 * Reverses {@link encrypt}. Throws when the value was changed, was written
 * for another context or under another key, or is not a ciphertext.
 *
 * A value of three parts was written before the form had a version, with no
 * context bound to it: it opens for any context, until `inCurrentForm` values
 * have taken the place of all of them.
 */
export function decrypt(ciphertext: string, keyHex: string, context: string): string {
  const parts = ciphertext.split(':');
  const current = parts[0] === VERSION;
  const [ivHex, tagHex, dataHex] = current ? parts.slice(1) : parts;
  const iv = Buffer.from(ivHex ?? '', 'hex');
  const tag = Buffer.from(tagHex ?? '', 'hex');
  const data = Buffer.from(dataHex ?? '', 'hex');
  // The tag's length is part of the form: one cut short would still verify,
  // against far fewer guesses, if the length were left to the stored value.
  if (parts.length !== (current ? 4 : 3) || iv.length !== IV_BYTES || tag.length !== TAG_BYTES || data.length === 0 || data.length * 2 !== dataHex!.length) {
    throw new Error('malformed ciphertext');
  }
  const decipher = createDecipheriv(ALGORITHM, Buffer.from(keyHex, 'hex'), iv, { authTagLength: TAG_BYTES });
  if (current) decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/** What every value in the form `encrypt` writes begins with; a query can tell the two forms apart by it. */
export const CURRENT_FORM_PREFIX = `${VERSION}:`;

/** True for a value in the form `encrypt` writes: one that is not has no context bound to it yet. */
export function inCurrentForm(ciphertext: string): boolean {
  return ciphertext.startsWith(CURRENT_FORM_PREFIX);
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
