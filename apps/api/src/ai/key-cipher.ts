// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * How a user's provider key is stored: encrypted under
 * `AI_KEY_ENCRYPTION_SECRET`, with the id of that secret in front.
 *
 * The id says which secret sealed a key without revealing anything about it.
 * A key sealed under another secret (the operator changed it, or restored a
 * database from another instance) is then recognised for what it is, instead
 * of looking like damage. Keys stored before ids were written have none and
 * are opened with the current secret.
 */
import { createHmac } from 'node:crypto';
import { decrypt, encrypt } from '../common/crypto.js';

/** Why a stored key could not be opened; for the log, not for the user. */
export type UnreadableKey = 'sealed under another secret' | 'damaged' | 'damaged, or sealed under another secret';

export type OpenedKey = { ok: true; key: string } | { ok: false; why: UnreadableKey };

/** A short, stable name for a secret that does not help anyone guess it. */
function secretId(secretHex: string): string {
  return createHmac('sha256', Buffer.from(secretHex, 'hex')).update('ai-provider-key-id').digest('hex').slice(0, 8);
}

export function sealKey(plaintext: string, secretHex: string): string {
  return `${secretId(secretHex)}:${encrypt(plaintext, secretHex)}`;
}

export function openKey(stored: string, secretHex: string): OpenedKey {
  const parts = stored.split(':');
  // Four parts carry an id; three were written before there was one.
  const ciphertext = parts.length === 4 ? parts.slice(1).join(':') : stored;
  if (parts.length === 4 && parts[0] !== secretId(secretHex)) {
    return { ok: false, why: 'sealed under another secret' };
  }
  try {
    return { ok: true, key: decrypt(ciphertext, secretHex) };
  } catch {
    // With a matching id the secret is right, so the stored value is damaged.
    // Without an id there is no telling the two apart.
    return { ok: false, why: parts.length === 4 ? 'damaged' : 'damaged, or sealed under another secret' };
  }
}
