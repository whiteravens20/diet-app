// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { localClock } from './local-clock.js';

describe('the clock of a time zone', () => {
  it('shows the day, the hour and the minute there, whatever the server keeps', () => {
    const moment = new Date('2026-11-07T23:30:00.000Z');
    expect(localClock(moment, 'Europe/Warsaw')).toEqual({ day: '2026-11-08', hour: 0, minute: 30 });
    expect(localClock(moment, 'America/New_York')).toEqual({
      day: '2026-11-07',
      hour: 18,
      minute: 30,
    });
    expect(localClock(moment, 'UTC')).toEqual({ day: '2026-11-07', hour: 23, minute: 30 });
  });

  it('keeps summer time where the zone keeps it', () => {
    expect(localClock(new Date('2026-07-01T16:00:00.000Z'), 'Europe/Warsaw').hour).toBe(18);
    expect(localClock(new Date('2026-12-01T16:00:00.000Z'), 'Europe/Warsaw').hour).toBe(17);
  });
});
