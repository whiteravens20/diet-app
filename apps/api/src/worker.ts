import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Worker } from 'bullmq';
import type { GeneratePlanRequest } from '@diet-app/shared';
import { AppModule } from './app.module.js';
import type { Env } from './config/env.js';
import { MealPlansService } from './meal-plans/meal-plans.service.js';

/** Name of the BullMQ queue meal-plan generation jobs are enqueued on. */
export const PLAN_QUEUE = 'plan-generation';

export interface PlanGenerationJob {
  userId: string;
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
  const logger = new Logger('Worker');

  const connection = parseRedisUrl(config.get('REDIS_URL', { infer: true }));

  const worker = new Worker<PlanGenerationJob, { planId: string }>(
    PLAN_QUEUE,
    async (job) => {
      logger.log(`Generating plan for profile ${job.data.request.profileId}`);
      const plan = await mealPlans.generate(job.data.userId, job.data.request);
      return { planId: plan.id };
    },
    { connection, concurrency: 4 },
  );

  worker.on('failed', (job, err) => logger.error(`Job ${job?.id} failed: ${err.message}`));
  worker.on('completed', (job) => logger.log(`Job ${job.id} completed`));
  logger.log(`Worker listening on queue "${PLAN_QUEUE}"`);

  const shutdown = async (): Promise<void> => {
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
