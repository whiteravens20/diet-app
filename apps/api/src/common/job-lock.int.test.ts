// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { runAlone } from './job-lock.js';

describe('a scheduled job', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  /** A job that runs until it is let go. */
  function held() {
    let release: () => void = () => undefined;
    let begun: () => void = () => undefined;
    const started = new Promise<void>((resolve) => (begun = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const job = async (): Promise<void> => {
      begun();
      await gate;
    };
    return { job, started, release };
  }

  it('runs, and says that it did', async () => {
    let ran = 0;

    expect(await runAlone(t.prisma, 'counting', async () => void (ran += 1))).toBe(true);
    expect(ran).toBe(1);
  });

  it('is left alone by whoever finds it running, and can be run again once it is over', async () => {
    const first = held();
    const running = runAlone(t.prisma, 'the scan', first.job);
    await first.started;
    let ranMeanwhile = false;

    expect(await runAlone(t.prisma, 'the scan', async () => void (ranMeanwhile = true))).toBe(
      false,
    );
    expect(ranMeanwhile).toBe(false);

    first.release();
    expect(await running).toBe(true);
    expect(await runAlone(t.prisma, 'the scan', async () => undefined)).toBe(true);
  });

  it('does not stand in the way of another job', async () => {
    const first = held();
    const running = runAlone(t.prisma, 'one job', first.job);
    await first.started;

    expect(await runAlone(t.prisma, 'another job', async () => undefined)).toBe(true);

    first.release();
    await running;
  });

  it('gives its lock back when it fails', async () => {
    await expect(
      runAlone(t.prisma, 'a job that fails', () => Promise.reject(new Error('no luck'))),
    ).rejects.toThrow('no luck');

    expect(await runAlone(t.prisma, 'a job that fails', async () => undefined)).toBe(true);
  });
});
