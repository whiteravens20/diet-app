// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * How long a row of what an account did is kept for the limits that count
 * such rows: a year, of a leap year too. None of them reads more than the
 * last thirty days.
 */
const KEPT_DAYS = 366;

/**
 * Remove the calls of models and the writes and sendings of products that an
 * account made more than `KEPT_DAYS` ago. Returns how many were removed.
 */
export async function pruneLimitLogs(prisma: PrismaService, now = Date.now()): Promise<number> {
  const before = new Date(now - KEPT_DAYS * 86_400_000);
  const [calls, products] = await prisma.$transaction([
    prisma.aiUsageLog.deleteMany({ where: { createdAt: { lt: before } } }),
    prisma.ownProductChange.deleteMany({ where: { at: { lt: before } } }),
  ]);
  return calls.count + products.count;
}
