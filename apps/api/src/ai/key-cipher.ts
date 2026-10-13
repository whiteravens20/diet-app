// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * How a user's provider key is stored: encrypted under
 * `AI_KEY_ENCRYPTION_SECRET` for the account it belongs to, with the id of
 * that secret in front.
 *
 * The id says which secret sealed a key without revealing anything about it.
 * A key sealed under another secret (the operator changed it, or restored a
 * database from another instance) is then recognised for what it is, instead
 * of looking like damage. Keys stored before ids were written have none and
 * are opened with the current secret.
 */
import { createHmac } from 'node:crypto';
import { decrypt, encrypt, inCurrentForm } from '../common/crypto.js';

/** Why a stored key could not be opened; for the log, not for the user. */
type UnreadableKey = 'sealed under another secret' | 'damaged' | 'damaged, or sealed under another secret';

export type OpenedKey = { ok: true; key: string } | { ok: false; why: UnreadableKey };

/** A short, stable name for a secret that does not help anyone guess it. */
function secretId(secretHex: string): string {
  return createHmac('sha256', Buffer.from(secretHex, 'hex')).update('ai-provider-key-id').digest('hex').slice(0, 8);
}

/** Whose a key is: an account's, or the instance's where the row belongs to nobody. */
function contextOf(ownerId: string | null): string {
  return `ai-provider-key:${ownerId ?? 'instance'}`;
}

/** The id in front of a stored key, when it has one, and the ciphertext after it. */
function partsOf(stored: string): { id: string | null; ciphertext: string } {
  const cut = stored.indexOf(':');
  const rest = stored.slice(cut + 1);
  // An id stands in front of a ciphertext of the current form, or of the three
  // parts of the earlier one. Three parts alone were written before ids.
  const hasId = cut > 0 && (inCurrentForm(rest) || rest.split(':').length === 3);
  return hasId ? { id: stored.slice(0, cut), ciphertext: rest } : { id: null, ciphertext: stored };
}

export function sealKey(plaintext: string, secretHex: string, ownerId: string | null): string {
  return `${secretId(secretHex)}:${encrypt(plaintext, secretHex, contextOf(ownerId))}`;
}

export function openKey(stored: string, secretHex: string, ownerId: string | null): OpenedKey {
  const { id, ciphertext } = partsOf(stored);
  if (id !== null && id !== secretId(secretHex)) {
    return { ok: false, why: 'sealed under another secret' };
  }
  try {
    return { ok: true, key: decrypt(ciphertext, secretHex, contextOf(ownerId)) };
  } catch {
    // With a matching id the secret is right, so the stored value is damaged
    // or was sealed for another account. Without an id there is no telling
    // damage from another secret.
    return { ok: false, why: id !== null ? 'damaged' : 'damaged, or sealed under another secret' };
  }
}

/** True for a key stored as `sealKey` stores one now: with the secret's id, bound to its owner. */
export function isSealedForOwner(stored: string): boolean {
  const { id, ciphertext } = partsOf(stored);
  return id !== null && inCurrentForm(ciphertext);
}
