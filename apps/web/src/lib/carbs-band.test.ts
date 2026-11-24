// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { bandValues, carbsBandOf, carbsStandingOf } from './carbs-band';

describe("how a day's carbohydrate reads against what it aims at", () => {
  it('is a band from its floor on low-carb, a ceiling alone on keto, and a target elsewhere', () => {
    expect(carbsBandOf({ carbsFloor: 54 })).toBe('range');
    expect(carbsBandOf({ carbsFloor: 0 })).toBe('ceiling');
    expect(carbsBandOf({ carbsFloor: null })).toBe('none');
  });

  it('says an amount is over the ceiling, under the floor or in the band, in the whole grams it is shown in', () => {
    const lowCarb = { carbs: 120, carbsFloor: 60 };
    expect(carbsStandingOf(140, lowCarb)).toBe('over');
    expect(carbsStandingOf(120.4, lowCarb)).toBe('in');
    expect(carbsStandingOf(120.6, lowCarb)).toBe('over');
    expect(carbsStandingOf(59.6, lowCarb)).toBe('in');
    expect(carbsStandingOf(59.4, lowCarb)).toBe('under');
    expect(carbsStandingOf(90, lowCarb)).toBe('in');
    // Keto's band is a ceiling alone: nothing is under it.
    const keto = { carbs: 30, carbsFloor: 0 };
    expect(carbsStandingOf(0, keto)).toBe('in');
    expect(carbsStandingOf(31, keto)).toBe('over');
    // A diet without a band says the target, not a standing.
    expect(carbsStandingOf(400, { carbs: 250, carbsFloor: null })).toBe('in');
  });

  it('gives a message its band and a floor of none where there is no band', () => {
    expect(bandValues({ carbsFloor: 54 })).toEqual({ band: 'range', carbsFloor: 54 });
    expect(bandValues({ carbsFloor: null })).toEqual({ band: 'none', carbsFloor: 0 });
  });
});
