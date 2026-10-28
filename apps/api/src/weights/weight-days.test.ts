// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { dayIn, weightDays } from './weight-days.js';

/** An entry of `kg` at `moment`, a moment in UTC. */
const logged = (moment: string, kg: number) => ({ kg, recordedAt: new Date(moment) });

/** An entry of `kg` at noon in UTC of `day`. */
const atNoon = (day: string, kg: number) => logged(`${day}T12:00:00Z`, kg);

describe('the weights of a profile, as a chart draws them', () => {
  it('are one point a day, oldest first, the last entry of a day standing for it', () => {
    const days = weightDays(
      [
        atNoon('2026-01-07', 80.4),
        atNoon('2026-01-05', 81),
        logged('2026-01-07T20:00:00Z', 80.1),
        atNoon('2026-01-06', 80.6),
      ],
      'UTC',
    );

    expect(days.map((day) => [day.date, day.kg])).toEqual([
      ['2026-01-05', 81],
      ['2026-01-06', 80.6],
      ['2026-01-07', 80.1],
    ]);
  });

  it('carry the mean of the seven days that end with each, not of the last seven entries', () => {
    // Once a week for three weeks, then three days in a row.
    const days = weightDays(
      [
        atNoon('2026-01-01', 84),
        atNoon('2026-01-08', 83),
        atNoon('2026-01-15', 82),
        atNoon('2026-01-16', 81),
        atNoon('2026-01-17', 80),
      ],
      'UTC',
    );

    // A week holds one entry of somebody who weighs weekly: the mean is that entry.
    expect(days.slice(0, 3).map((day) => day.mean)).toEqual([84, 83, 82]);
    expect(days[3]!.mean).toBe(81.5);
    expect(days[4]!.mean).toBe(81);
  });

  it('count the day seven days back as outside the week, and the day six days back as inside', () => {
    const days = weightDays(
      [atNoon('2026-01-01', 90), atNoon('2026-01-02', 80), atNoon('2026-01-08', 70)],
      'UTC',
    );

    // The week that ends on the 8th begins on the 2nd.
    expect(days[2]!.mean).toBe(75);
  });

  it('count a day of the week by its last entry, as the point of that day', () => {
    const days = weightDays(
      [atNoon('2026-01-01', 90), logged('2026-01-01T21:00:00Z', 80), atNoon('2026-01-02', 70)],
      'UTC',
    );

    expect(days[1]!.mean).toBe(75);
  });

  it('give kilograms to the hundredth', () => {
    const days = weightDays(
      [atNoon('2026-01-01', 80.123), atNoon('2026-01-02', 80.1), atNoon('2026-01-03', 80.2)],
      'UTC',
    );

    expect(days[0]!.kg).toBe(80.12);
    expect(days[2]!.mean).toBe(80.14);
  });

  it('are days of the time zone named: an entry late in the evening belongs to that evening', () => {
    // Half past eleven in the evening in Warsaw, and half past midnight there.
    const evening = logged('2026-01-05T22:30:00Z', 80);
    const night = logged('2026-01-05T23:30:00Z', 81);

    expect(weightDays([evening, night], 'Europe/Warsaw').map((day) => day.date)).toEqual([
      '2026-01-05',
      '2026-01-06',
    ]);
    expect(weightDays([evening, night], 'UTC').map((day) => day.date)).toEqual(['2026-01-05']);
    // Ten at night in New York is the next day in UTC.
    expect(weightDays([logged('2026-01-06T03:00:00Z', 80)], 'America/New_York')[0]!.date).toBe(
      '2026-01-05',
    );
  });

  it('follow the clocks of the zone when they change', () => {
    // In Warsaw the clocks went forward on the night to 29 March 2026: 22:30 in
    // UTC is half past eleven in the evening before, and half past midnight after.
    const days = weightDays(
      [logged('2026-03-28T22:30:00Z', 80), logged('2026-03-29T22:30:00Z', 79)],
      'Europe/Warsaw',
    );

    expect(days.map((day) => day.date)).toEqual(['2026-03-28', '2026-03-30']);
  });

  it('are nothing while nothing was logged', () => {
    expect(weightDays([], 'Europe/Warsaw')).toEqual([]);
  });
});

describe('the day a moment falls on', () => {
  it('is the day of the time zone named', () => {
    expect(dayIn('Europe/Warsaw')(new Date('2026-01-05T23:30:00Z'))).toBe('2026-01-06');
    expect(dayIn('America/New_York')(new Date('2026-01-05T23:30:00Z'))).toBe('2026-01-05');
    expect(dayIn('Asia/Tokyo')(new Date('2026-01-05T15:30:00Z'))).toBe('2026-01-06');
  });
});
