// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * The pull-request ship mode while it is switched off: no test here starts
 * `git` or `gh`, and none can reach a remote.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedCatalogue } from '../../../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../../../testing/database.js';
import { asAdmin } from '../../../testing/factories.js';
import { createTestApp, type TestApp } from '../../../testing/test-app.js';

describe('shipping as a pull request', () => {
  let t: TestApp;
  let repoRoot: string;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await resetUserData(t.prisma);
    repoRoot = mkdtempSync(join(tmpdir(), 'diet-app-upstream-'));
  });

  describe('while it is switched off', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('answers the refusal it documents, for a ship and for a push of the current overrides', async () => {
      // As in a container: the process runs where there is no checkout at all.
      vi.spyOn(process, 'cwd').mockReturnValue(repoRoot);

      const ship = await t.http().post('/api/admin/drafts/ship').set(asAdmin).send({ kind: 'recipe', mode: 'upstream-pr' });
      const push = await t.http().post('/api/admin/drafts/ship/current-overrides/push').set(asAdmin);

      expect([ship.status, ship.body.error]).toEqual([409, 'SHIP_UPSTREAM_DISABLED']);
      expect([push.status, push.body.error]).toEqual([409, 'SHIP_UPSTREAM_DISABLED']);
      // The same reason the panel is given when it asks what is on offer.
      const offered = await t.http().get('/api/admin/drafts/ship/config').set(asAdmin).expect(200);
      expect(offered.body.modes.upstreamPr).toMatchObject({ available: false, reason: 'SHIP_UPSTREAM_DISABLED' });
    });
  });
});
