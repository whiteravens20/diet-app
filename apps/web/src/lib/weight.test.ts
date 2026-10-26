// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import type { WeightEntry } from '@diet-app/shared';
import { weightSeries } from './weight-series';
import { boundsIn, shownToOne, shownWeight, toKilograms, unitOfRegion } from './weight-unit';

/** An entry of `kg` at noon of `day`, by the clock of the machine the test runs on. */
const logged = (day: string, kg: number, hour = 12): WeightEntry =>
  ({
    id: `${day}-${hour}`,
    profileId: 'profile',
    kg,
    recordedAt: new Date(`${day}T${String(hour).padStart(2, '0')}:00:00`).toISOString(),
    createdAt: '2026-01-01T00:00:00.000Z',
  }) satisfies WeightEntry;

describe('the weights of a profile, as a chart draws them', () => {
  it('are one point a day, oldest first, the last entry of a day standing for it', () => {
    const series = weightSeries([
      logged('2026-01-07', 80.4),
      logged('2026-01-05', 81),
      logged('2026-01-07', 80.1, 20),
      logged('2026-01-06', 80.6),
    ]);

    expect(series.map((point) => [point.date, point.kg])).toEqual([
      ['2026-01-05', 81],
      ['2026-01-06', 80.6],
      ['2026-01-07', 80.1],
    ]);
  });

  it('carry the mean of the seven days that end with each, not of the last seven entries', () => {
    // Once a week for three weeks, then three days in a row.
    const series = weightSeries([
      logged('2026-01-01', 84),
      logged('2026-01-08', 83),
      logged('2026-01-15', 82),
      logged('2026-01-16', 81),
      logged('2026-01-17', 80),
    ]);

    // A week holds one entry of somebody who weighs weekly: the mean is that entry.
    expect(series.slice(0, 3).map((point) => point.ma7)).toEqual([84, 83, 82]);
    expect(series[3]!.ma7).toBe(81.5);
    expect(series[4]!.ma7).toBe(81);
  });

  it('count the day seven days back as outside the week, and the day six days back as inside', () => {
    const series = weightSeries([
      logged('2026-01-01', 90),
      logged('2026-01-02', 80),
      logged('2026-01-08', 70),
    ]);

    // The week that ends on the 8th begins on the 2nd.
    expect(series[2]!.ma7).toBe(75);
  });

  it('are nothing while nothing was logged', () => {
    expect(weightSeries([])).toEqual([]);
  });
});

describe('the unit a weight is shown and typed in', () => {
  it('is pounds for a reader in a country that weighs in them, and kilograms for every other', () => {
    expect(unitOfRegion(['en-US', 'en'])).toBe('lb');
    expect(unitOfRegion(['en-GB'])).toBe('kg');
    expect(unitOfRegion(['pl-PL'])).toBe('kg');
    // A language without a country says nothing of where its reader is.
    expect(unitOfRegion(['en'])).toBe('kg');
    expect(unitOfRegion(['en', 'en-US'])).toBe('lb');
    expect(unitOfRegion([])).toBe('kg');
    expect(unitOfRegion(['not a tag'])).toBe('kg');
    expect(unitOfRegion(['zh-Hant-TW'])).toBe('kg');
    expect(unitOfRegion(['es-Latn-US'])).toBe('lb');
  });

  it('turns kilograms into pounds for showing and pounds back into kilograms for the API', () => {
    expect(shownWeight(80, 'kg')).toBe(80);
    expect(shownToOne(80, 'lb')).toBe(176.4);
    expect(toKilograms(176.4, 'lb')).toBe(80.01);
    expect(toKilograms(80.126, 'kg')).toBe(80.13);
  });

  it('gives the bounds of a weight in the unit it is typed in, so that what it lets through the API takes', () => {
    expect(boundsIn('kg')).toEqual({ min: 30, max: 400 });
    const pounds = boundsIn('lb');
    expect(pounds).toEqual({ min: 66.2, max: 881.8 });
    expect(toKilograms(pounds.min, 'lb')).toBeGreaterThanOrEqual(30);
    expect(toKilograms(pounds.max, 'lb')).toBeLessThanOrEqual(400);
  });
});
