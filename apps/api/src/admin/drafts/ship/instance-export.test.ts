// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { namesOfTheInstance, readableBy } from './instance-export.js';

describe("the names of the instance's own file", () => {
  it("leave out what the catalogue's data gives as it is, and keep what the instance gave", () => {
    const held = {
      tomato: { name: { pl: 'Pomidor' } },
      'chicken-breast': { name: { pl: 'Filet z kurczaka', en: 'Chicken breast' } },
      salmon: { name: { pl: 'Łosoś' }, storageHint: { pl: 'W lodówce' } },
      leek: { name: { pl: 'Por' } },
    };
    const catalogue = {
      tomato: { name: { pl: 'Pomidor' } },
      'chicken-breast': { name: { pl: 'Pierś z kurczaka', en: 'Chicken breast' } },
      salmon: { name: { pl: 'Łosoś' }, storageHint: { pl: 'W zamrażarce' } },
    };

    expect(namesOfTheInstance(held, catalogue)).toEqual({
      'chicken-breast': { name: { pl: 'Filet z kurczaka' } },
      salmon: { name: { pl: 'Łosoś' }, storageHint: { pl: 'W lodówce' } },
      leek: { name: { pl: 'Por' } },
    });
  });
});

describe('which version may read the files another wrote', () => {
  it('reads what an older or the same version wrote, and not what a newer one did', () => {
    expect(readableBy('0.77.0', '0.76.3')).toBe(true);
    expect(readableBy('0.77.0', '0.77.0')).toBe(true);
    expect(readableBy('1.0.0', '0.99.9')).toBe(true);
    expect(readableBy('0.77.0', '0.77.1')).toBe(false);
    expect(readableBy('0.77.0', '0.78.0')).toBe(false);
    expect(readableBy('0.77.0', '1.0.0')).toBe(false);
  });

  it('cannot tell versions apart that are not three numbers, and does not stand in their way', () => {
    expect(readableBy('unknown', '0.78.0')).toBe(true);
    expect(readableBy('0.77.0', 'dev-10367d8')).toBe(true);
  });
});
