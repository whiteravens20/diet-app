// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * How a user's provider key is stored: encrypted under
 * `AI_KEY_ENCRYPTION_SECRET` for the account it belongs to, with the id of
 * that secret in front.
 *
 * The id says which secret sealed a key without revealing anything about it.
 * A key sealed under another secret (the operator changed it, or restored a
 * database from another instance) is then recognised for what it is, instead
 * of looking like damage.
 */
import { createHmac } from 'node:crypto';
import { decrypt, encrypt } from '../common/crypto.js';

/** Why a stored key could not be opened; for the log, not for the user. */
type UnreadableKey = 'sealed under another secret' | 'damaged';

export type OpenedKey = { ok: true; key: string } | { ok: false; why: UnreadableKey };

/** A short, stable name for a secret that does not help anyone guess it. */
function secretId(secretHex: string): string {
  return createHmac('sha256', Buffer.from(secretHex, 'hex'))
    .update('ai-provider-key-id')
    .digest('hex')
    .slice(0, 8);
}

/** Whose a key is: an account's, or the instance's where the row belongs to nobody. */
function contextOf(ownerId: string | null): string {
  return `ai-provider-key:${ownerId ?? 'instance'}`;
}

export function sealKey(plaintext: string, secretHex: string, ownerId: string | null): string {
  return `${secretId(secretHex)}:${encrypt(plaintext, secretHex, contextOf(ownerId))}`;
}

/** What `secretId` gives: eight hex digits. */
const SECRET_ID = /^[0-9a-f]{8}$/;

export function openKey(stored: string, secretHex: string, ownerId: string | null): OpenedKey {
  const cut = stored.indexOf(':');
  const id = cut > 0 ? stored.slice(0, cut) : '';
  if (!SECRET_ID.test(id)) return { ok: false, why: 'damaged' };
  if (id !== secretId(secretHex)) {
    return { ok: false, why: 'sealed under another secret' };
  }
  try {
    return { ok: true, key: decrypt(stored.slice(cut + 1), secretHex, contextOf(ownerId)) };
  } catch {
    // The id matches, so the secret is right: the stored value is damaged or
    // was sealed for another account.
    return { ok: false, why: 'damaged' };
  }
}
