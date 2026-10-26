// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { chmodSync, statSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { asAdmin } from '../../testing/factories.js';
import { catalogueDirectory } from '../../testing/catalogue.js';
import { resetDatabase } from '../../testing/database.js';
import { createTestApp, type TestApp } from '../../testing/test-app.js';
import { UsdaImportRunner } from './runner.js';

describe('starting an import of foods', () => {
  let t: TestApp;
  const basic = asAdmin;
  /** Start the import without letting it run: no test asks the real source. */
  const started = () => vi.spyOn(t.app.get(UsdaImportRunner), 'start').mockResolvedValue(true);

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await t.close();
  });

  it('takes the data sets as one list or as a repeated parameter', async () => {
    const start = started();

    await t
      .http()
      .post('/api/admin/db/import-usda?dataTypes=Foundation,SR%20Legacy')
      .set(basic)
      .expect(202);
    await t
      .http()
      .post('/api/admin/db/import-usda?dataTypes=Foundation&dataTypes=SR%20Legacy')
      .set(basic)
      .expect(202);
    await t.http().post('/api/admin/db/import-usda').set(basic).expect(202);

    expect(start.mock.calls).toEqual([
      ['Foundation,SR Legacy'],
      ['Foundation,SR Legacy'],
      [undefined],
    ]);
  });

  it.each(['Branded', 'Foundation,Branded', '', 'Foundation,Foundation'])(
    'refuses "%s" before anything is started',
    async (dataTypes) => {
      const start = started();

      const res = await t
        .http()
        .post(`/api/admin/db/import-usda?dataTypes=${encodeURIComponent(dataTypes)}`)
        .set(basic);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION_FAILED');
      expect(start).not.toHaveBeenCalled();
    },
  );

  // Root may write anywhere: the run would go on to ask the real source.
  it.skipIf(process.getuid?.() === 0)(
    'reports why a run failed and that nothing was asked of the source: a data directory closed to the API',
    async () => {
      const dataDir = catalogueDirectory();
      const asked = vi.spyOn(globalThis, 'fetch');
      const { mode } = statSync(dataDir);
      chmodSync(dataDir, 0o555);
      try {
        await t.http().post('/api/admin/db/import-usda').set(basic).expect(202);

        // The run is detached from the request that started it.
        let state = (await t.http().get('/api/admin/db/import-usda/status').set(basic).expect(200))
          .body;
        for (let i = 0; i < 100 && state.status === 'running'; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          state = (await t.http().get('/api/admin/db/import-usda/status').set(basic).expect(200))
            .body;
        }

        expect(state).toMatchObject({
          status: 'error',
          errorReason: 'not_writable',
          retryAfterSeconds: null,
          error: `Cannot write to ${dataDir}`,
        });
        expect(asked).not.toHaveBeenCalled();
      } finally {
        chmodSync(dataDir, mode);
      }
    },
  );
});
