// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { WeightReminderService } from './notifications/weight-reminder.service.js';
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
