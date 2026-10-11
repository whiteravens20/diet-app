// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Prisma } from '@prisma/client';

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
