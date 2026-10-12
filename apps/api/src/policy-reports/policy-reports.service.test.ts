// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MOST_KINDS, PolicyReportsService, WINDOW_MINUTES } from './policy-reports.service.js';
import type { Violation } from './violation.js';

const inline: Violation = { disposition: 'enforce', directive: 'script-src-elem', blocked: 'inline', page: '/meal-plans', source: '' };
const evaluated: Violation = { disposition: 'enforce', directive: 'script-src', blocked: 'eval', page: '/login', source: '/_next/static/chunks/a.js:3:20249' };

describe('what the log says of the reports against the content security policy', () => {
  let warned: ReturnType<typeof vi.spyOn>;
  let logged: ReturnType<typeof vi.spyOn>;
  let reports: PolicyReportsService;

  beforeEach(() => {
    warned = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    logged = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    reports = new PolicyReportsService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('names a kind of violation at once when it is first seen, and not again for every report of it', () => {
    reports.record([inline]);
    reports.record([{ ...inline, page: '/recipes' }, inline, evaluated]);

    expect(warned.mock.calls.map(([line]) => line)).toEqual(['script-src-elem blocked inline on /meal-plans', 'script-src blocked eval on /login (/_next/static/chunks/a.js:3:20249)']);
    expect(logged).not.toHaveBeenCalled();
  });

  it('sums up how often each kind was reported, the most frequent first, and begins anew', () => {
    reports.record([evaluated, inline, inline, inline]);

    reports.summarise();

    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0]![0]).toBe(
      `4 report(s) in the last ${WINDOW_MINUTES} minutes: 3x script-src-elem blocked inline on /meal-plans; 1x script-src blocked eval on /login (/_next/static/chunks/a.js:3:20249)`,
    );

    reports.summarise();
    expect(logged).toHaveBeenCalledTimes(1);

    // A kind that was seen in the window before is new to the next one.
    reports.record([inline]);
    expect(warned).toHaveBeenCalledTimes(3);
  });

  it('says nothing for a window in which nothing was reported', () => {
    reports.summarise();

    expect(logged).not.toHaveBeenCalled();
    expect(warned).not.toHaveBeenCalled();
  });

  it('is not anybody\'s to fill: beyond the kinds it tells apart, reports are counted and not described', () => {
    const flood = Array.from({ length: MOST_KINDS + 500 }, (_, index): Violation => ({ ...inline, blocked: `https://host-${index}.example` }));

    reports.record(flood);
    reports.record(flood);

    expect(warned).toHaveBeenCalledTimes(MOST_KINDS);
    reports.summarise();
    const line = logged.mock.calls[0]![0] as string;
    expect(line.startsWith(`${2 * (MOST_KINDS + 500)} report(s)`)).toBe(true);
    expect(line.endsWith(`${2 * 500}x of kinds beyond the ${MOST_KINDS} that are told apart`)).toBe(true);
    expect(line).not.toContain(`host-${MOST_KINDS}.example`);
  });

  it('writes its sum every ten minutes while the application runs, and what is left when it stops', () => {
    vi.useFakeTimers();
    reports.onModuleInit();
    reports.record([inline]);

    vi.advanceTimersByTime(WINDOW_MINUTES * 60_000 - 1);
    expect(logged).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(logged).toHaveBeenCalledTimes(1);

    reports.record([evaluated]);
    reports.onModuleDestroy();
    expect(logged).toHaveBeenCalledTimes(2);

    // Stopped: nothing counts on.
    vi.advanceTimersByTime(WINDOW_MINUTES * 60_000 * 3);
    expect(logged).toHaveBeenCalledTimes(2);
  });
});
