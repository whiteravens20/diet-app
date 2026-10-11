// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AiKeyService } from './ai/ai-key.service.js';
import { AppModule } from './app.module.js';
import { AccountSecondFactor } from './auth/account-second-factor.service.js';
import { AddressResealService } from './auth/address-reseal.service.js';
import { pruneLinks } from './auth/one-time-links.js';
import { SessionsService } from './auth/sessions.service.js';
import { WeightReminderService } from './notifications/weight-reminder.service.js';
import { PrismaService } from './prisma/prisma.service.js';
import { PersonalRecipesService } from './recipes/personal-recipes.service.js';

/**
 * Scheduled-tasks process. Runs as a separate container
 * (`npm run start:worker`) sharing the same modules as the API, so periodic
 * jobs run on a single instance even when the API is scaled to several
 * replicas — that's what keeps the weight-reminder scan from double-firing.
 */
async function bootstrap(): Promise<void> {
  // No bufferLogs: this is a headless context with no logger attached to flush
  // the buffer, so buffering would swallow every log — including scan errors.
  const app = await NestFactory.createApplicationContext(AppModule);
  const weightReminders = app.get(WeightReminderService);
  const personalRecipes = app.get(PersonalRecipesService);
  const addresses = app.get(AddressResealService);
  const providerKeys = app.get(AiKeyService);
  const sessions = app.get(SessionsService);
  const secondFactor = app.get(AccountSecondFactor);
  const prisma = app.get(PrismaService);
  const logger = new Logger('Worker');

  // Hourly granularity is enough for both. The reminder scan debounces
  // per-profile against `lastWeightReminderAt`, so the user is never
  // re-notified within their own cadence window; a deleted recipe waits days
  // before it is removed for good.
  const jobs: [name: string, run: () => Promise<unknown>][] = [
    ['weight-reminder scan', () => weightReminders.scan()],
    [
      'removal of deleted personal recipes',
      async () => {
        const removed = await personalRecipes.collectDeleted();
        if (removed > 0) logger.log(`Removed ${removed} deleted personal recipe(s) that nothing uses any more.`);
      },
    ],
    [
      'removal of ended sessions and of links that can no longer be followed',
      async () => {
        const tokens = await sessions.prune();
        const links = (await pruneLinks(prisma)) + (await secondFactor.prune());
        if (tokens + links > 0) logger.log(`Removed ${tokens} token(s) of ended sessions and ${links} used or expired link(s) and sign-in challenge(s).`);
      },
    ],
    // What was encrypted before a value was sealed for its account. Each run
    // after the first finds nothing to do, unless a database from before was
    // restored in the meantime.
    [
      'sealing of stored addresses for their accounts',
      async () => {
        const { sealed, unreadable } = await addresses.run();
        if (sealed > 0) logger.log(`Sealed ${sealed} stored address(es) for the account each belongs to.`);
        if (unreadable > 0) logger.warn(`${unreadable} stored address(es) cannot be read with DATA_ENCRYPTION_SECRET as it is set: those accounts cannot be shown or mailed.`);
      },
    ],
    [
      'sealing of stored provider keys for their accounts',
      async () => {
        const { sealed } = await providerKeys.resealKeys();
        if (sealed > 0) logger.log(`Sealed ${sealed} stored provider key(s) for the account each belongs to.`);
      },
    ],
  ];
  const tickMs = 60 * 60 * 1000;
  // One after another, each failing on its own: a job that throws does not
  // keep the next one from running.
  const fireJobs = async (): Promise<void> => {
    for (const [name, run] of jobs) {
      try {
        await run();
      } catch (err) {
        logger.error(`${name} failed: ${(err as Error).message}`);
      }
    }
  };
  void fireJobs();
  const tick = setInterval(() => void fireJobs(), tickMs);
  logger.log(`Worker started — every 1h: ${jobs.map(([name]) => name).join(', ')}`);

  const shutdown = async (): Promise<void> => {
    clearInterval(tick);
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

void bootstrap();
