import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Worker } from 'bullmq';
import type { GeneratePlanRequest, Locale } from '@diet-app/shared';
import { AppModule } from './app.module.js';
import type { Env } from './config/env.js';
import { MealPlansService } from './meal-plans/meal-plans.service.js';
import { WeightReminderService } from './notifications/weight-reminder.service.js';

/** Name of the BullMQ queue meal-plan generation jobs are enqueued on. */
export const PLAN_QUEUE = 'plan-generation';

export interface PlanGenerationJob {
  userId: string;
  /** Locale to render the resulting plan in. The user's locale at queue time
   *  is captured here so the response strings match the UI they came from. */
  locale: Locale;
  request: GeneratePlanRequest;
}

/**
 * Background worker process. Long-running, ingredient-reuse-heavy plan
 * generation is offloaded here so the API stays responsive. Runs as a separate
 * container (`npm run start:worker`) sharing the same modules as the API.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService) as ConfigService<Env, true>;
  const mealPlans = app.get(MealPlansService);
  const weightReminders = app.get(WeightReminderService);
  const logger = new Logger('Worker');

  const connection = parseRedisUrl(config.get('REDIS_URL', { infer: true }));

  const worker = new Worker<PlanGenerationJob, { planId: string }>(
    PLAN_QUEUE,
    async (job) => {
      logger.log(`Generating plan for profile ${job.data.request.profileId}`);
      const plan = await mealPlans.generate(job.data.userId, job.data.locale ?? 'en', job.data.request);
      return { planId: plan.id };
    },
    { connection, concurrency: 4 },
  );

  worker.on('failed', (job, err) => logger.error(`Job ${job?.id} failed: ${err.message}`));
  worker.on('completed', (job) => logger.log(`Job ${job.id} completed`));
  logger.log(`Worker listening on queue "${PLAN_QUEUE}"`);

  // F19 — periodic weight-reminder scan. Hourly granularity is enough: the
  // service debounces per-profile against `lastWeightReminderAt`, so the
  // user is never re-notified within their own cadence window. Running in
  // the worker (not the API) means a multi-replica API deployment can't
  // double-fire reminders.
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

  const shutdown = async (): Promise<void> => {
    clearInterval(tick);
    await worker.close();
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

function parseRedisUrl(url: string): { host: string; port: number } {
  const parsed = new URL(url);
  return { host: parsed.hostname, port: Number(parsed.port) || 6379 };
}

void bootstrap();
