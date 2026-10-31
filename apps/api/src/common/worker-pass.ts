// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { WorkerState } from '@diet-app/shared';
import type { PrismaService } from '../prisma/prisma.service.js';

const NAME = 'worker pass';

/** The worker makes a pass an hour: after three of them without one it has gone quiet. */
const SILENT_AFTER_MS = 3 * 60 * 60_000;

/** The pass of the scheduled tasks that just ended, for the administrator's panel. */
export async function recordWorkerPass(prisma: PrismaService, failed: number): Promise<void> {
  const row = { state: { failed }, heartbeatAt: new Date() };
  await prisma.jobState.upsert({
    where: { name: NAME },
    create: { name: NAME, ...row },
    update: row,
  });
}

/** How the scheduled tasks stand, from their last pass. */
export async function readWorkerPass(
  prisma: PrismaService,
  now: Date,
): Promise<{ state: WorkerState; lastPassAt: string | null; failedJobs: number }> {
  const row = await prisma.jobState.findUnique({ where: { name: NAME } });
  if (!row) return { state: 'none', lastPassAt: null, failedJobs: 0 };
  const failedJobs = (row.state as { failed?: number } | null)?.failed ?? 0;
  const silent = now.getTime() - row.heartbeatAt.getTime() > SILENT_AFTER_MS;
  return {
    state: silent ? 'silent' : failedJobs > 0 ? 'failing' : 'ok',
    lastPassAt: row.heartbeatAt.toISOString(),
    failedJobs,
  };
}
