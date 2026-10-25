// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { PrismaService } from '../prisma/prisma.service.js';

/** The longest a job may hold its lock: longer than any pass takes. */
const LONGEST_RUN_MS = 2 * 60 * 60_000;

/**
 * Run a scheduled job unless it is running already: in another worker (two
 * are started, or an old and a new one overlap while the instance is
 * updated), or in this one, when a pass outlasts the hour to the next.
 *
 * The lock is one of the database's own, taken for a transaction that stays
 * open while the job runs and holds nothing else. It goes when the job ends,
 * and with the connection when the process dies: nothing is left to clear
 * up. Returns false when the job was left to whoever runs it.
 */
export function runAlone(
  prisma: PrismaService,
  name: string,
  job: () => Promise<void>,
): Promise<boolean> {
  return prisma.$transaction(
    async (tx) => {
      const [held] = await tx.$queryRaw<
        { locked: boolean }[]
      >`SELECT pg_try_advisory_xact_lock(hashtext(${`diet-app job: ${name}`})) AS locked`;
      if (!held?.locked) return false;
      await job();
      return true;
    },
    { maxWait: 10_000, timeout: LONGEST_RUN_MS },
  );
}
