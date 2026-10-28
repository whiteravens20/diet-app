// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { boundsIn, shownToOne, shownWeight, toKilograms, unitOfRegion } from './weight-unit';

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
