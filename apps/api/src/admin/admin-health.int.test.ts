// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { recordWorkerPass } from '../common/worker-pass.js';
import { RequestTimes } from '../health/request-times.js';
import { resetDatabase } from '../testing/database.js';
import { asAdmin } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

describe('how the instance stands, for its administrator', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await resetDatabase(t.prisma);
  });

  const read = async () => (await t.http().get('/api/admin/health').set(asAdmin).expect(200)).body;

  it("is the administrator's alone", async () => {
    await t.http().get('/api/admin/health').expect(401);
  });

  it('says the database answers, and how much it holds', async () => {
    const { database } = await read();

    expect(database.up).toBe(true);
    expect(database.pingMs).toBeGreaterThanOrEqual(0);
    expect(database.bytes).toBeGreaterThan(1_000_000);
  });

  it('says which version of the API this is, since when it runs, and how much memory it takes', async () => {
    const { api, checkedAt } = await read();

    expect(api.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(Date.parse(api.startedAt)).toBeLessThanOrEqual(Date.parse(checkedAt));
    expect(api.memoryBytes).toBeGreaterThan(10_000_000);
  });

  describe('the scheduled tasks', () => {
    const lastPass = (at: Date, failed = 0) =>
      t.prisma.jobState.upsert({
        where: { name: 'worker pass' },
        create: { name: 'worker pass', state: { failed }, heartbeatAt: at },
        update: { state: { failed }, heartbeatAt: at },
      });

    it('have not reported where no pass has ended', async () => {
      expect((await read()).worker).toEqual({ state: 'none', lastPassAt: null, failedJobs: 0 });
    });

    it('are well after a pass in which every job ran', async () => {
      await recordWorkerPass(t.prisma, 0);

      expect((await read()).worker).toMatchObject({ state: 'ok', failedJobs: 0 });
    });

    it('say how many jobs failed in their last pass', async () => {
      await recordWorkerPass(t.prisma, 2);

      expect((await read()).worker).toMatchObject({ state: 'failing', failedJobs: 2 });
    });

    it('have gone quiet after three hours without a pass, whatever the last one said', async () => {
      const longAgo = new Date(Date.now() - 3 * 60 * 60_000 - 60_000);
      await lastPass(longAgo);

      expect((await read()).worker).toEqual({
        state: 'silent',
        lastPassAt: longAgo.toISOString(),
        failedJobs: 0,
      });
    });

    it('are well just inside the three hours', async () => {
      await lastPass(new Date(Date.now() - 2 * 60 * 60_000));

      expect((await read()).worker.state).toBe('ok');
    });
  });

  describe('the requests', () => {
    it('are timed, and the health checks are left out', async () => {
      const times = t.app.get(RequestTimes);
      const before = times.summary().counted;

      await t.http().get('/api/health').expect(200);
      await t.http().get('/api/health').expect(200);
      expect(times.summary().counted).toBe(before);

      await t.http().get('/api/config').expect(200);
      await expect.poll(() => times.summary().counted).toBe(Math.min(before + 1, 1000));
    });

    it('count no refusal of a request as a failure of the server', async () => {
      const times = t.app.get(RequestTimes);
      const before = times.summary().serverErrors;

      await t.http().get('/api/no-such-route').expect(404);

      expect(times.summary().serverErrors).toBe(before);
      expect((await read()).requests.counted).toBeGreaterThan(0);
    });
  });

  it('says what the instance may ask of its AI provider, and that no mail is set up', async () => {
    const { ai, mail } = await read();

    expect(ai).toMatchObject({ used: 0 });
    expect(ai.limit).toBeGreaterThan(0);
    expect(mail).toEqual({ configured: false });
  });
});
