// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { JobState } from './job-state.js';

interface Run {
  status: 'idle' | 'running' | 'done' | 'error';
  finishedAt: string | null;
  error: string | null;
  written: number;
}

const idle = (): Run => ({ status: 'idle', finishedAt: null, error: null, written: 0 });
const running = (written = 0): Run => ({
  status: 'running',
  finishedAt: null,
  error: null,
  written,
});

describe('where a background job stands, for an API of several processes', () => {
  let t: TestApp;
  /** The same job as two processes of the API have it. */
  let here: JobState<Run>;
  let there: JobState<Run>;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await t.prisma.jobState.deleteMany();
    here = new JobState(t.prisma, 'a run', idle);
    there = new JobState(t.prisma, 'a run', idle);
  });

  /** A run in `process` that goes on until it is let go, then ends with `last`. */
  function begunIn(
    process: JobState<Run>,
    last: Run = { status: 'done', finishedAt: '2026-01-01T00:00:00.000Z', error: null, written: 3 },
  ) {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const over = process.during(async () => {
      await gate;
      process.local = last;
    });
    return { release, over };
  }

  /** Let a run that was begun in `process` come to its end. */
  async function ended(process: JobState<Run>): Promise<void> {
    const run = begunIn(process);
    run.release();
    await run.over;
  }

  it('is idle before the job ever ran', async () => {
    expect(await here.read()).toEqual(idle());
  });

  it('is begun by one process, and the other is told that it runs', async () => {
    here.local = running();
    there.local = running();

    expect(await here.begin()).toBe(true);
    const run = begunIn(here);
    expect(await there.begin()).toBe(false);
    // What the process that lost had set is nobody's.
    expect(there.local).toEqual(idle());
    expect(await there.read()).toEqual(running());

    run.release();
    await run.over;
  });

  it('is begun by one of two processes that begin together', async () => {
    here.local = running();
    there.local = running();

    const begun = await Promise.all([here.begin(), there.begin()]);

    expect([...begun].sort()).toEqual([false, true]);
    await ended(begun[0] ? here : there);
  });

  it('is read the same from every process once the job is over, and the job can run again', async () => {
    here.local = running();
    await here.begin();
    const run = begunIn(here);
    run.release();
    await run.over;

    expect(await there.read()).toEqual({
      status: 'done',
      finishedAt: '2026-01-01T00:00:00.000Z',
      error: null,
      written: 3,
    });
    there.local = running();
    expect(await there.begin()).toBe(true);
    await ended(there);
  });

  it('is told to stop from another process than the one that runs it', async () => {
    here.local = running();
    await here.begin();
    const run = begunIn(here);
    expect(here.stopRequested).toBe(false);

    expect(await there.requestStop()).toBe(true);
    // The process that runs the job hears of it when it next writes its state down.
    await expect.poll(() => here.stopRequested, { timeout: 5000 }).toBe(true);

    run.release();
    await run.over;
    expect(await there.requestStop()).toBe(false);
  });

  it('is seen as failed when the process that ran it has been silent, and can then be begun again', async () => {
    // A run whose process died a minute ago: it says that it runs, and nothing writes its state down any more.
    await t.prisma.jobState.create({
      data: { name: 'a run', state: { ...running(7) }, heartbeatAt: new Date(Date.now() - 60_000) },
    });

    const seen = await there.read();
    expect(seen).toMatchObject({
      status: 'error',
      written: 7,
      error: expect.stringContaining('stopped with the process'),
    });
    expect(seen.finishedAt).not.toBeNull();

    there.local = running();
    expect(await there.begin()).toBe(true);
    await ended(there);
  });

  it('keeps a state that no run led to, for the panel to show', async () => {
    here.local = {
      status: 'error',
      finishedAt: '2026-01-01T00:00:00.000Z',
      error: 'not configured',
      written: 0,
    };
    await here.settle();

    expect(await there.read()).toMatchObject({ status: 'error', error: 'not configured' });
  });
});
