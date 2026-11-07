// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { weightLine } from './weight-line.js';

describe('the line weights lie closest to', () => {
  it('runs through weights that fall evenly, at their pace', () => {
    const line = weightLine([0, 7, 14, 21].map((day) => ({ day, kg: 91 - day / 14 })));
    expect(line!.perDay * 7).toBeCloseTo(-0.5, 6);
    expect(line!.at(28)).toBeCloseTo(89, 6);
  });

  it('is moved little by one weighing a kilogram off', () => {
    const steady = [0, 3, 6, 9, 12, 15].map((day) => ({ day, kg: 80 }));
    const line = weightLine([...steady, { day: 14, kg: 81.5 }]);
    expect(Math.abs(line!.perDay * 7)).toBeLessThan(0.4);
  });

  it('is none for fewer than two weighings, or for weighings of one day', () => {
    expect(weightLine([{ day: 0, kg: 80 }])).toBeNull();
    expect(
      weightLine([
        { day: 3, kg: 80 },
        { day: 3, kg: 81 },
      ]),
    ).toBeNull();
  });
});
