// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readRoutes } from '../../scripts/contract/routes.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
}

describe('the routes the running application answers', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it('are the routes the published contract is written from, no more and no fewer', async () => {
    // What the framework registered with the server: every path with its methods.
    const server = t.app.getHttpAdapter().getInstance() as { router: { stack: Layer[] } };
    // A middleware that is bound to a controller's routes is registered beside them, under the same path with a slash at its end: one route, not two.
    const answered = [
      ...new Set(
        server.router.stack
          .flatMap((layer) =>
            layer.route
              ? Object.keys(layer.route.methods).map(
                  (method) =>
                    `${method.toUpperCase()} ${layer.route!.path.replace(/(?<=.)\/$/, '')}`,
                )
              : [],
          )
          .filter((route) => /^(GET|POST|PUT|PATCH|DELETE) \/api(\/|$)/.test(route)),
      ),
    ].sort();
    const written = (await readRoutes()).map((route) => `${route.method} ${route.path}`).sort();

    expect(answered.length).toBeGreaterThan(150);
    expect(answered).toEqual(written);
  });
});
