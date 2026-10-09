// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { securityHeaders, type SecurityHeadersOptions } from './security.js';

// `applySecurityHeaders(app, options)` is `app.use(securityHeaders(options))`.
// NestJS sits on Express, so asserting the headers that middleware emits on a
// bare Express app exercises the exact policy the API ships — without dragging
// the Nest DI container (and a DB connection) into a unit test.
function probeApp(options?: SecurityHeadersOptions): express.Express {
  const app = express();
  app.use(securityHeaders(options));
  app.use((_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

const STRICT_CSP = "default-src 'none';frame-ancestors 'none'";

describe('API security headers', () => {
  it('sets the defence-in-depth headers on responses', async () => {
    const res = await request(probeApp()).get('/api/probe').expect(200);

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toMatch(/max-age=\d+/);
    expect(res.headers['referrer-policy']).toBeDefined();
    expect(res.headers['x-frame-options']).toBeDefined();
    // helmet strips the framework banner.
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('lets nothing load from, or frame, an API response', async () => {
    const res = await request(probeApp()).get('/api/probe').expect(200);
    expect(res.headers['content-security-policy']).toBe(STRICT_CSP);
  });

  it('keeps the strict policy on the Swagger routes while Swagger is off', async () => {
    const res = await request(probeApp()).get('/api/docs').expect(200);
    expect(res.headers['content-security-policy']).toBe(STRICT_CSP);
  });

  describe('with Swagger UI enabled', () => {
    const app = probeApp({ swaggerPath: '/api/docs' });

    it.each(['/api/docs', '/api/docs/', '/api/docs/swagger-ui-bundle.js'])(
      'lets %s load its own scripts and styles, and nothing else',
      async (path) => {
        const res = await request(app).get(path).expect(200);
        const csp = res.headers['content-security-policy'];

        expect(csp).toContain("default-src 'none'");
        expect(csp).toContain("script-src 'self'");
        expect(csp).toContain("style-src 'self' 'unsafe-inline'");
        expect(csp).toContain("connect-src 'self'");
        expect(csp).toContain("frame-ancestors 'none'");
        expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
        expect(csp).not.toContain('unsafe-eval');
      },
    );

    it.each(['/api/probe', '/api/docs-json', '/api/docsearch'])(
      'keeps the strict policy on %s',
      async (path) => {
        const res = await request(app).get(path).expect(200);
        expect(res.headers['content-security-policy']).toBe(STRICT_CSP);
      },
    );
  });
});
