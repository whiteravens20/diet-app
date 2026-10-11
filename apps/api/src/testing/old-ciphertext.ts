// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { createCipheriv, randomBytes } from 'node:crypto';

/**
 * A value as the application stored it before ciphertexts had a version:
 * `iv:tag:data`, with nothing bound to it. Tests use it to stand for what a
 * database from before still holds.
 */
export function ciphertextWrittenBefore(plaintext: string, keyHex: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${data.toString('hex')}`;
}
