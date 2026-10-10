// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resetDatabase } from '../../testing/database.js';
import { createTestApp, type TestApp } from '../../testing/test-app.js';
import { UsdaImportRunner } from './runner.js';

describe('starting an import of foods', () => {
  let t: TestApp;
  const basic = { Authorization: `Basic ${Buffer.from('admin:integration-test-admin-password').toString('base64')}` };
  /** Start the import without letting it run: no test asks the real source. */
  const started = () => vi.spyOn(t.app.get(UsdaImportRunner), 'start').mockReturnValue(true);

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

    await t.http().post('/api/admin/db/import-usda?dataTypes=Foundation,SR%20Legacy').set(basic).expect(202);
    await t.http().post('/api/admin/db/import-usda?dataTypes=Foundation&dataTypes=SR%20Legacy').set(basic).expect(202);
    await t.http().post('/api/admin/db/import-usda').set(basic).expect(202);

    expect(start.mock.calls).toEqual([['Foundation,SR Legacy'], ['Foundation,SR Legacy'], [undefined]]);
  });

  it.each(['Branded', 'Foundation,Branded', '', 'Foundation,Foundation'])('refuses "%s" before anything is started', async (dataTypes) => {
    const start = started();

    const res = await t.http().post(`/api/admin/db/import-usda?dataTypes=${encodeURIComponent(dataTypes)}`).set(basic);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_FAILED');
    expect(start).not.toHaveBeenCalled();
  });
});
