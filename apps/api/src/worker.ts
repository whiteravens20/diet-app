// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { WeightReminderService } from './notifications/weight-reminder.service.js';

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
  const logger = new Logger('Worker');

  // Periodic weight-reminder scan. Hourly granularity is enough: the
  // service debounces per-profile against `lastWeightReminderAt`, so the
  // user is never re-notified within their own cadence window.
  const tickMs = 60 * 60 * 1000;
  const fireScan = async (): Promise<void> => {
    try {
      await weightReminders.scan();
    } catch (err) {
      logger.error(`weight-reminder scan failed: ${(err as Error).message}`);
    }
  };
  void fireScan();
  const tick = setInterval(() => void fireScan(), tickMs);
  logger.log('Worker started — weight-reminder scan every 1h');

  const shutdown = async (): Promise<void> => {
    clearInterval(tick);
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

void bootstrap();
