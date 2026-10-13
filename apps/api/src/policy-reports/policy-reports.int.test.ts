// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Logger } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { PolicyReportsService } from './policy-reports.service.js';

const APP = 'http://localhost:3000';
const A_REPORT = {
  'csp-report': {
    'document-uri': `${APP}/meal-plans?profile=0b1f`,
    'effective-directive': 'script-src-elem',
    'blocked-uri': 'inline',
    disposition: 'enforce',
    'original-policy': "default-src 'self'",
  },
};

describe('the route browsers send their reports against the content security policy to', () => {
  let t: TestApp;
  let warned: MockInstance<Logger['warn']>;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  afterEach(() => {
    // Each test begins with nothing counted.
    t.app.get(PolicyReportsService).summarise();
    vi.restoreAllMocks();
  });

  const watched = (): void => {
    warned = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  };
  const post = (type: string, body: string) => t.http().post('/api/csp-reports').set('content-type', type).send(body);

  it('takes a report as a browser posts it, from anybody, and answers with nothing', async () => {
    watched();

    const res = await post('application/csp-report', JSON.stringify(A_REPORT));

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(warned.mock.calls.map(([line]) => line)).toEqual(['script-src-elem blocked inline on /meal-plans']);
  });

  it('takes the reports a browser had waiting', async () => {
    watched();
    const queued = [
      { type: 'csp-violation', age: 3, url: `${APP}/login`, user_agent: 'A browser', body: { documentURL: `${APP}/login`, effectiveDirective: 'frame-src', blockedURL: 'https://challenges.cloudflare.com/turnstile/x', disposition: 'report' } },
      { type: 'deprecation', age: 9, url: `${APP}/login`, user_agent: 'A browser', body: { id: 'Something', message: 'old' } },
    ];

    const res = await post('application/reports+json', JSON.stringify(queued));

    expect(res.status).toBe(204);
    expect(warned.mock.calls.map(([line]) => line)).toEqual(['frame-src would block https://challenges.cloudflare.com on /login']);
  });

  it('takes one sent as plain JSON too', async () => {
    watched();

    expect((await post('application/json', JSON.stringify(A_REPORT))).status).toBe(204);
    expect(warned).toHaveBeenCalledTimes(1);
  });

  it('refuses a body that is no report, and counts nothing', async () => {
    watched();

    const other = await post('application/csp-report', JSON.stringify({ something: 'else' }));
    expect(other.status).toBe(400);
    expect(other.body.error).toBe('VALIDATION_FAILED');
    expect((await post('text/plain', 'hello')).status).toBe(400);
    expect((await post('application/csp-report', JSON.stringify({ 'csp-report': { 'document-uri': `${APP}/${'a'.repeat(5000)}` } }))).status).toBe(400);
    // A queue with nothing in it is a queue.
    expect((await post('application/reports+json', '[]')).status).toBe(204);
    expect(warned).not.toHaveBeenCalled();
  });

  it('refuses a body that is not JSON, and one that is larger than any report', async () => {
    watched();

    const broken = await post('application/csp-report', '{"csp-report": ');
    expect(broken.status).toBe(400);
    const large = await post('application/csp-report', JSON.stringify({ 'csp-report': { 'original-policy': 'x'.repeat(70_000) } }));
    expect(large.status).toBe(413);
    expect(warned).not.toHaveBeenCalled();
  });

  it('is there for sending only', async () => {
    expect((await t.http().get('/api/csp-reports')).status).toBe(404);
  });

  it('takes sixty a minute from a sender, and loses the rest without a word in the log', async () => {
    watched();
    const statuses: number[] = [];
    // The tests above have used a few of the sixty.
    for (let sent = 0; sent < 70; sent += 1) statuses.push((await post('application/csp-report', JSON.stringify(A_REPORT))).status);

    expect(statuses.filter((status) => status === 204).length).toBeGreaterThan(40);
    expect(statuses.filter((status) => status === 204).length).toBeLessThanOrEqual(60);
    expect(statuses.at(-1)).toBe(429);
    expect(new Set(statuses)).toEqual(new Set([204, 429]));
    // One kind of violation: one line, however many reports.
    expect(warned).toHaveBeenCalledTimes(1);
  });
});
