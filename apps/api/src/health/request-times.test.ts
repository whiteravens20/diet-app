// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { RequestTimes } from './request-times.js';

describe('the times of the latest requests', () => {
  it('say nothing before there is a request', () => {
    expect(new RequestTimes().summary()).toEqual({
      counted: 0,
      medianMs: null,
      p95Ms: null,
      serverErrors: 0,
    });
  });

  it('give the half and the 95 in a hundred of what was counted, whole milliseconds', () => {
    const times = new RequestTimes();
    for (let ms = 1; ms <= 100; ms += 1) times.note(ms + 0.4, 200);

    expect(times.summary()).toEqual({ counted: 100, medianMs: 50, p95Ms: 95, serverErrors: 0 });
  });

  it('read the one request there is as both', () => {
    const times = new RequestTimes();
    times.note(7, 200);

    expect(times.summary()).toMatchObject({ counted: 1, medianMs: 7, p95Ms: 7 });
  });

  it('count what the server failed, and no refusal of a request as a failure', () => {
    const times = new RequestTimes();
    for (const status of [200, 201, 304, 400, 401, 404, 429, 500, 503]) times.note(1, status);

    expect(times.summary()).toMatchObject({ counted: 9, serverErrors: 2 });
  });

  it('keep the latest thousand and take no more room for more: old ones fall out', () => {
    const times = new RequestTimes();
    for (let i = 0; i < 1000; i += 1) times.note(5000, 500);
    for (let i = 0; i < 1000; i += 1) times.note(10, 200);

    expect(times.summary()).toEqual({ counted: 1000, medianMs: 10, p95Ms: 10, serverErrors: 0 });
  });
});
