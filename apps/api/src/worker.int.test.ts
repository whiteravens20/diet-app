// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { INestApplicationContext, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SeedRunner } from './admin/seed/runner.js';
import { runAlone } from './common/job-lock.js';
import { PlanGenerationService } from './meal-plans/plan-generation.service.js';
import { PrismaService } from './prisma/prisma.service.js';
import { resetDatabase } from './testing/database.js';
import { aProfile, aUser } from './testing/factories.js';
import { createTestApp, type TestApp } from './testing/test-app.js';
import { type Job, runJobs, workerJobs } from './worker.jobs.js';

describe('the worker', () => {
  /** The API beside it: it gives the test its settings, its database and an account. */
  let t: TestApp;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let jobs: Job[];
  const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const logger = log as unknown as Logger;

  beforeAll(async () => {
    t = await createTestApp();
    const { WorkerModule } = await import('./worker.module.js');
    worker = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
    prisma = worker.get(PrismaService);
    jobs = workerJobs(worker, logger);
  });

  afterAll(async () => {
    await worker.close();
    await t.close();
  });

  beforeEach(async () => {
    await resetDatabase(t.prisma);
    vi.clearAllMocks();
  });

  it('starts with what its jobs need, and without the plans and the administrator\'s runners', () => {
    expect(jobs.length).toBeGreaterThan(0);
    expect(() => worker.get(PlanGenerationService, { strict: false })).toThrow();
    expect(() => worker.get(SeedRunner, { strict: false })).toThrow();
  });

  it('runs every job where none of them finds anything to do', async () => {
    await runJobs(prisma, jobs, logger);

    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('does what its jobs are for: a profile that is due is reminded', async () => {
    const profile = await aProfile(t, await aUser(t), { weightReminderCadence: 'daily' });

    await runJobs(prisma, jobs, logger);

    expect(log.error).not.toHaveBeenCalled();
    expect(await t.prisma.notification.count({ where: { profileId: profile.id, type: 'weight_reminder' } })).toBe(1);
  });

  it('leaves a job that runs elsewhere to whoever runs it, and runs the others', async () => {
    const ran = vi.fn().mockResolvedValue(undefined);
    const two: Job[] = [['a job that runs elsewhere', ran], ['the job after it', ran]];
    let done: () => void = () => undefined;
    const elsewhere = new Promise<void>((resolve) => (done = resolve));
    let held: Promise<boolean> = Promise.resolve(false);
    await new Promise<void>((taken) => {
      held = runAlone(t.prisma, 'a job that runs elsewhere', () => {
        taken();
        return elsewhere;
      });
    });

    await runJobs(prisma, two, logger);
    done();

    expect(await held).toBe(true);
    expect(ran).toHaveBeenCalledTimes(1);
    expect(log.log).toHaveBeenCalledWith('a job that runs elsewhere: running elsewhere, left alone this time.');
    expect(log.error).not.toHaveBeenCalled();
  });

  it('goes on with the next job when one fails, and says which one failed', async () => {
    const after = vi.fn().mockResolvedValue(undefined);

    await runJobs(prisma, [['a job that fails', () => Promise.reject(new Error('no'))], ['the job after it', after]], logger);

    expect(log.error).toHaveBeenCalledWith('a job that fails failed: no');
    expect(after).toHaveBeenCalledTimes(1);
  });
});
