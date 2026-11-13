// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { rerollBody } from './reroll';

describe('what a re-roll sends', () => {
  it('is nothing at all when it asks for nothing of its own', () => {
    expect(rerollBody({ planId: 'p' })).toBeUndefined();
    expect(rerollBody({ planId: 'p', dayId: 'd' })).toBeUndefined();
  });

  it('is what was chosen, and nothing that was not', () => {
    expect(
      rerollBody({
        planId: 'p',
        from: '2026-01-06',
        to: '2026-01-07',
        includePast: true,
        replaceEaten: true,
        replaceCustom: false,
        allowRelaxations: [],
      }),
    ).toEqual({
      from: '2026-01-06',
      to: '2026-01-07',
      includePast: true,
      replaceEaten: true,
      allowRelaxations: [],
    });
  });

  it('says a level of waste given, a level turned off included, and leaves out one not given', () => {
    expect(rerollBody({ planId: 'p', lessWaste: true, noWaste: true })).toEqual({
      lessWaste: true,
      noWaste: true,
    });
    expect(rerollBody({ planId: 'p', lessWaste: false, noWaste: false })).toEqual({
      lessWaste: false,
      noWaste: false,
    });
    expect(rerollBody({ planId: 'p', lessWaste: true })).toEqual({ lessWaste: true });
  });
});
