// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { LESS_WASTE, NO_WASTE } from './waste-levels.js';

describe('the days an opened pack is to be eaten within', () => {
  it('are its own in a plan that wastes less', () => {
    expect(LESS_WASTE.keepDays({ keepDays: 7, category: 'dairy' })).toBe(7);
    expect(LESS_WASTE.keepDays({ keepDays: 30, category: 'pantry' })).toBe(30);
  });

  it('are at most 3 for meat and fish and 5 for anything else in a plan that wastes nothing, and never more than its own', () => {
    expect(NO_WASTE.keepDays({ keepDays: 2, category: 'meat' })).toBe(2);
    expect(NO_WASTE.keepDays({ keepDays: 5, category: 'meat' })).toBe(3);
    expect(NO_WASTE.keepDays({ keepDays: 3, category: 'fish' })).toBe(3);
    expect(NO_WASTE.keepDays({ keepDays: 7, category: 'dairy' })).toBe(5);
    expect(NO_WASTE.keepDays({ keepDays: 30, category: 'pantry' })).toBe(5);
    expect(NO_WASTE.keepDays({ keepDays: 3, category: 'vegetables' })).toBe(3);
    // Where the database has no keep days yet: the fallback of its kind, within the level's.
    expect(NO_WASTE.keepDays({ keepDays: null, category: 'meat' })).toBe(2);
  });
});
