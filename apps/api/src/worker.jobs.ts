// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { INestApplicationContext, Logger } from '@nestjs/common';
import { AccountSecondFactor } from './auth/account-second-factor.service.js';
import { BrowserSignIn } from './auth/browser-sign-in.service.js';
import { pruneLinks } from './auth/one-time-links.js';
import { SessionsService } from './auth/sessions.service.js';
import { pruneIdempotencyKeys } from './common/idempotency.js';
import { runAlone } from './common/job-lock.js';
import { NotificationsService } from './notifications/notifications.service.js';
import { WeightReminderService } from './notifications/weight-reminder.service.js';
import { PrismaService } from './prisma/prisma.service.js';
import { PersonalRecipesService } from './recipes/personal-recipes.service.js';

/** A job of the worker: what the log calls it, and what it does. */
export type Job = readonly [name: string, run: () => Promise<unknown>];

/**
 * The jobs the worker runs, in the order it runs them. Hourly is often
 * enough for all of them: the reminder scan debounces per profile against
 * `lastWeightReminderAt`, so the user is never re-notified within their own
 * cadence window, and a deleted recipe waits days before it is removed for
 * good.
 */
export function workerJobs(app: INestApplicationContext, logger: Logger): Job[] {
  const weightReminders = app.get(WeightReminderService);
  const notifications = app.get(NotificationsService);
  const personalRecipes = app.get(PersonalRecipesService);
  const sessions = app.get(SessionsService);
  const secondFactor = app.get(AccountSecondFactor);
  const browsers = app.get(BrowserSignIn);
  const prisma = app.get(PrismaService);

  return [
    ['weight-reminder scan', () => weightReminders.scan()],
    [
      'removal of notifications nobody will look at again',
      async () => {
        const removed = await notifications.prune();
        if (removed > 0) logger.log(`Removed ${removed} old notification(s).`);
      },
    ],
    [
      'removal of deleted personal recipes',
      async () => {
        const removed = await personalRecipes.collectDeleted();
        if (removed > 0)
          logger.log(`Removed ${removed} deleted personal recipe(s) that nothing uses any more.`);
      },
    ],
    [
      'removal of ended sessions and of links that can no longer be followed',
      async () => {
        const tokens = await sessions.prune();
        const links =
          (await pruneLinks(prisma)) + (await secondFactor.prune()) + (await browsers.prune());
        if (tokens + links > 0)
          logger.log(
            `Removed ${tokens} token(s) of ended sessions and ${links} used or expired link(s), sign-in challenge(s) and browser code(s).`,
          );
      },
    ],
    [
      'removal of the keys of additions sent more than a week ago',
      async () => {
        const removed = await pruneIdempotencyKeys(prisma);
        if (removed > 0)
          logger.log(`Removed ${removed} key(s) of additions sent more than a week ago.`);
      },
    ],
  ];
}

/**
 * Run the jobs one after another, each failing on its own: a job that throws
 * does not keep the next one from running. A job that is running somewhere
 * already is left to whoever runs it.
 */
export async function runJobs(
  prisma: PrismaService,
  jobs: readonly Job[],
  logger: Logger,
): Promise<void> {
  for (const [name, run] of jobs) {
    try {
      const ran = await runAlone(prisma, name, async () => void (await run()));
      if (!ran) logger.log(`${name}: running elsewhere, left alone this time.`);
    } catch (err) {
      logger.error(`${name} failed: ${(err as Error).message}`);
    }
  }
}
