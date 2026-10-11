// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { PrismaService } from './prisma/prisma.service.js';
import { runJobs, workerJobs } from './worker.jobs.js';
import { WorkerModule } from './worker.module.js';

/**
 * Scheduled-tasks process. Runs as a separate container
 * (`npm run start:worker`), so the API can be scaled to several replicas
 * without any of them running these jobs. Each job takes a lock of the
 * database's for as long as it runs: a second worker, or an old one that is
 * still up while a new one starts, leaves a job to whoever is at it.
 */
async function bootstrap(): Promise<void> {
  // No bufferLogs: this is a headless context with no logger attached to flush
  // the buffer, so buffering would swallow every log — including scan errors.
  const app = await NestFactory.createApplicationContext(WorkerModule);
  const prisma = app.get(PrismaService);
  const logger = new Logger('Worker');
  const jobs = workerJobs(app, logger);

  const tickMs = 60 * 60 * 1000;
  void runJobs(prisma, jobs, logger);
  const tick = setInterval(() => void runJobs(prisma, jobs, logger), tickMs);
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
