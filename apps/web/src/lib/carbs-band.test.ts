// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { bandValues, carbsBandOf } from './carbs-band';

describe("how a day's carbohydrate reads against what it aims at", () => {
  it('is a band from its floor on low-carb, a ceiling alone on keto, and a target elsewhere', () => {
    expect(carbsBandOf({ carbsFloor: 54 })).toBe('range');
    expect(carbsBandOf({ carbsFloor: 0 })).toBe('ceiling');
    expect(carbsBandOf({ carbsFloor: null })).toBe('none');
  });

  it('gives a message its band and a floor of none where there is no band', () => {
    expect(bandValues({ carbsFloor: 54 })).toEqual({ band: 'range', carbsFloor: 54 });
    expect(bandValues({ carbsFloor: null })).toEqual({ band: 'none', carbsFloor: 0 });
  });
});
