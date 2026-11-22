// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { kitchenAmount } from './kitchen-amounts.js';

describe('an amount a cook measures', () => {
  it('is grams and millilitres in fives from 20 up', () => {
    expect(kitchenAmount(34.4, 'ml')).toBe(35);
    expect(kitchenAmount(94.3, 'g')).toBe(95);
    expect(kitchenAmount(22.4, 'g')).toBe(20);
    expect(kitchenAmount(22.5, 'g')).toBe(25);
    expect(kitchenAmount(20, 'g')).toBe(20);
    expect(kitchenAmount(3000, 'g')).toBe(3000);
  });

  it('is whole grams and millilitres below 20, and never none', () => {
    expect(kitchenAmount(17.6, 'g')).toBe(18);
    expect(kitchenAmount(19.6, 'ml')).toBe(20);
    expect(kitchenAmount(2.43, 'ml')).toBe(2);
    expect(kitchenAmount(1.35, 'g')).toBe(1);
    expect(kitchenAmount(0.3, 'g')).toBe(1);
  });

  it('is pieces in halves, and never under a half', () => {
    expect(kitchenAmount(1.3, 'piece')).toBe(1.5);
    expect(kitchenAmount(1.2, 'piece')).toBe(1);
    expect(kitchenAmount(2.75, 'piece')).toBe(3);
    expect(kitchenAmount(0.1, 'piece')).toBe(0.5);
  });
});
