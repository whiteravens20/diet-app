// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Prisma } from '@prisma/client';

/**
 * Hold an account, or a profile, until the transaction ends. Of the requests
 * that add to what it has, one goes at a time, and each counts what the one
 * before it added: a most is then the most, however many requests arrive
 * together.
 *
 * The row is held against other holders and against a change of the row
 * itself. Rows that refer to it are written by others as before.
 */
export const holdAccount = (tx: Prisma.TransactionClient, userId: string): Promise<unknown> =>
  tx.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${userId} FOR NO KEY UPDATE`;

export const holdProfile = (tx: Prisma.TransactionClient, profileId: string): Promise<unknown> =>
  tx.$queryRaw`SELECT 1 FROM "Profile" WHERE "id" = ${profileId} FOR NO KEY UPDATE`;
