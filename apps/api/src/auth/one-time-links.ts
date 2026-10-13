// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';

/** What is kept of a link that was sent: its hash, so that the table is no list of working links. */
export function hashOfLink(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Every link an account was sent to reset its password or to move to another
 * address, and has not followed, stops working. Such a link was asked for
 * before the password or the address changed: afterwards it proves nothing
 * about who holds the account. Somebody who knew the old password could
 * otherwise still move the account after its owner had changed it.
 *
 * With `addressToo`, the links that confirm the account's address go as well:
 * they were sent to an address the account no longer has.
 */
export async function retirePendingLinks(tx: Prisma.TransactionClient, userId: string, { addressToo = false } = {}): Promise<void> {
  const pending = { where: { userId, usedAt: null }, data: { usedAt: new Date() } };
  await tx.passwordResetToken.updateMany(pending);
  await tx.emailChangeToken.updateMany(pending);
  if (addressToo) await tx.emailVerificationToken.updateMany(pending);
}

/**
 * Remove the links that can no longer be followed: used, or run out a day
 * ago. They answer the same as a link that never was, so nothing is lost
 * with them, and without this the three tables only ever grow. Returns how
 * many were removed.
 */
export async function pruneLinks(db: Pick<Prisma.TransactionClient, 'passwordResetToken' | 'emailVerificationToken' | 'emailChangeToken'>): Promise<number> {
  const gone = { OR: [{ usedAt: { not: null } }, { expiresAt: { lt: new Date(Date.now() - 86_400_000) } }] };
  const removed = await Promise.all([
    db.passwordResetToken.deleteMany({ where: gone }),
    db.emailVerificationToken.deleteMany({ where: gone }),
    db.emailChangeToken.deleteMany({ where: gone }),
  ]);
  return removed.reduce((sum, { count }) => sum + count, 0);
}

