// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * The real application, started for a test: every module, guard, pipe and
 * filter of the API, on the test database, with a scripted model behind the
 * Ollama adapter. Nothing is read from an env file.
 */
import 'reflect-metadata';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaService } from '../prisma/prisma.service.js';
import { AnswersCheck, answersAreHeld } from './answers-check.js';
import { catalogueDirectory } from './catalogue.js';
import { testDatabaseUrl } from './database.js';
import { startFakeModel, type FakeModel } from './fake-model.js';
import { nextSeed } from './seeds.js';

/** The date the application under test takes for today, unless a test sets another. */
export const TEST_TODAY = '2026-01-01';

export interface TestApp {
  readonly app: INestApplication;
  readonly prisma: PrismaService;
  readonly model: FakeModel;
  /** A request against the running application; paths start with `/api`. */
  http(): ReturnType<typeof request>;
  close(): Promise<void>;
}

/** The complete environment of a test application. Values a test may override. */
function environment(modelUrl: string): Record<string, string> {
  return {
    NODE_ENV: 'test',
    APP_URL: 'http://localhost:3000',
    DATABASE_URL: testDatabaseUrl(),
    JWT_ACCESS_SECRET: 'integration-test-access-secret-0123456789',
    AI_KEY_ENCRYPTION_SECRET: 'a1'.repeat(32),
    DATA_ENCRYPTION_SECRET: 'b2'.repeat(32),
    // The lowest cost the schema accepts: hashing speed is not under test.
    PASSWORD_HASH_ROUNDS: '8',
    AI_DEFAULT_PROVIDER: 'ollama',
    AI_DEFAULT_MODEL: 'test-model',
    OLLAMA_BASE_URL: modelUrl,
    TURNSTILE_ENABLED: 'false',
    // High enough that a test never meets the global limit by accident.
    RATE_LIMIT_MAX: '100000',
    ADMIN_USER: 'admin',
    ADMIN_PASSWORD: 'integration-test-admin-password',
    SEED_DATA_DIR: catalogueDirectory(),
    INSTANCE_DATA_DIR: mkdtempSync(join(tmpdir(), 'diet-app-instance-')),
  };
}

let started: string | undefined;

/**
 * Start the application. The configuration module reads the environment when
 * it is first imported, so one test file gets one environment: a test that
 * needs other settings lives in a file of its own.
 */
export async function createTestApp(overrides: Record<string, string> = {}): Promise<TestApp> {
  const signature = JSON.stringify(overrides);
  if (started !== undefined && started !== signature) {
    throw new Error('A test file can start the application with one set of settings only.');
  }
  started = signature;

  const model = await startFakeModel();
  Object.assign(process.env, environment(model.url), overrides);

  // Imported here, after the environment is in place.
  const { NestFactory, Reflector } = await import('@nestjs/core');
  const { AppModule } = await import('../app.module.js');
  const { configureApp } = await import('../app.setup.js');
  const { PrismaService: Prisma } = await import('../prisma/prisma.service.js');
  const { PlanGenerationService } = await import('../meal-plans/plan-generation.service.js');

  const app = await NestFactory.create(AppModule, { logger: process.env.TEST_LOG ? ['error', 'warn'] : false });
  configureApp(app);
  // The integration tests hold every answer to what its route declares; a measurement does not pay for that.
  if (answersAreHeld()) app.useGlobalInterceptors(new AnswersCheck(app.get(Reflector)));
  await app.init();
  // The plans of the tests start on fixed days of January 2026. For the
  // application under test it is the first of that month, so those days are
  // ahead of it; a test about days that have passed sets another date.
  app.get(PlanGenerationService).today = () => TEST_TODAY;
  // A plan is made with a seed of its own. Here the seeds are 1, 2, 3 and on
  // from the start of every test, so that a test makes the same plans each run.
  app.get(PlanGenerationService).nextSeed = nextSeed;

  return {
    app,
    prisma: app.get(Prisma),
    model,
    http: () => request(app.getHttpServer()),
    async close() {
      await app.close();
      await model.close();
    },
  };
}
