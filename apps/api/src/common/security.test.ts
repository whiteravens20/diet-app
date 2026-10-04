// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import express from 'express';
import helmet from 'helmet';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { helmetOptions } from './security.js';

// `applySecurityHeaders(app)` is `app.use(helmet(helmetOptions))`. NestJS sits
// on Express, so asserting the headers `helmet(helmetOptions)` emits on a bare
// Express app exercises the exact policy the API ships — without dragging the
// Nest DI container (and a DB connection) into a unit test.
function probeApp(): express.Express {
  const app = express();
  app.use(helmet(helmetOptions));
  app.get('/probe', (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('API security headers (WI-F1)', () => {
  it('sets the defence-in-depth headers on responses', async () => {
    const res = await request(probeApp()).get('/probe').expect(200);

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toMatch(/max-age=\d+/);
    expect(res.headers['referrer-policy']).toBeDefined();
    expect(res.headers['x-frame-options']).toBeDefined();
    // helmet strips the framework banner.
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('does not set a Content-Security-Policy on the API (owned by the web layer)', async () => {
    const res = await request(probeApp()).get('/probe').expect(200);
    expect(res.headers['content-security-policy']).toBeUndefined();
  });
});
