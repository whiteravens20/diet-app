// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * How long a call of a model is kept: a year, of a leap year too. Its limits
 * read no more than the last thirty days; the record of an account's use of AI
 * is kept the year its terms say.
 */
const CALLS_KEPT_DAYS = 366;

/** How long a write or a sending of a product is kept: the day its limits read, and no longer. */
const PRODUCT_CHANGES_KEPT_DAYS = 1;

const DAY_MS = 86_400_000;

/**
 * Remove the calls of models an account made more than `CALLS_KEPT_DAYS` ago,
 * and the writes and sendings of products made more than
 * `PRODUCT_CHANGES_KEPT_DAYS` ago. Returns how many were removed.
 */
export async function pruneLimitLogs(prisma: PrismaService, now = Date.now()): Promise<number> {
  const [calls, products] = await prisma.$transaction([
    prisma.aiUsageLog.deleteMany({
      where: { createdAt: { lt: new Date(now - CALLS_KEPT_DAYS * DAY_MS) } },
    }),
    prisma.ownProductChange.deleteMany({
      where: { at: { lt: new Date(now - PRODUCT_CHANGES_KEPT_DAYS * DAY_MS) } },
    }),
  ]);
  return calls.count + products.count;
}
