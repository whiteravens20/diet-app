// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { linkedPots, wholePieceFactors, wholePieces } from './whole-pieces.js';

describe('whole pieces', () => {
  it('are the nearest number of what is taken exactly, and one where any is taken at all', () => {
    expect(wholePieces(0)).toBe(0);
    expect(wholePieces(0.2)).toBe(1);
    expect(wholePieces(1.4)).toBe(1);
    expect(wholePieces(1.5)).toBe(2);
    expect(wholePieces(2.49)).toBe(2);
    // The noise of a conversion moves no half.
    expect(wholePieces(1.4999999997)).toBe(2);
    expect(wholePieces(1.0000000004)).toBe(1);
  });
});

describe("a pot's factors", () => {
  it('make a meal cooked on its own take whole pieces', () => {
    const factors = wholePieceFactors([[{ meal: 'a', ingredient: 'egg', pieces: 1.5 }]]);

    expect(factors.get('a')!.get('egg')! * 1.5).toBeCloseTo(2);
  });

  it('round what the pot takes, each meal taking its share of it, where a share may be a part of a piece', () => {
    const factors = wholePieceFactors([
      [
        { meal: 'his', ingredient: 'egg', pieces: 1.5 },
        { meal: 'hers', ingredient: 'egg', pieces: 1 },
      ],
    ]);

    // 2.5 eggs in the pot are 3: his 1.8 and her 1.2.
    expect(factors.get('his')!.get('egg')! * 1.5).toBeCloseTo(1.8);
    expect(factors.get('hers')!.get('egg')! * 1).toBeCloseTo(1.2);
  });

  it('round each ingredient of a pot apart, and leave the meals of other pots as they are', () => {
    const factors = wholePieceFactors([
      [
        { meal: 'a', ingredient: 'egg', pieces: 0.75 },
        { meal: 'a', ingredient: 'tortilla', pieces: 2 },
      ],
      [{ meal: 'b', ingredient: 'egg', pieces: 2.25 }],
    ]);

    expect(factors.get('a')!.get('egg')! * 0.75).toBeCloseTo(1);
    expect(factors.get('a')!.get('tortilla')).toBe(1);
    expect(factors.get('b')!.get('egg')! * 2.25).toBeCloseTo(2);
    expect(factors.has('c')).toBe(false);
  });
});

describe('the pots of a set of meals', () => {
  it('are each meal on its own where no link joins it', () => {
    expect(linkedPots(['a', 'b'], [])).toEqual([['a'], ['b']]);
  });

  it('join the meals of every link, links that share a meal into one pot', () => {
    const pots = linkedPots(
      ['a', 'b', 'c', 'd', 'e'],
      [
        ['a', 'b'],
        ['c', 'b'],
        ['d', 'x'],
      ],
    );

    expect(pots.map((pot) => [...pot].sort())).toEqual([['a', 'b', 'c'], ['d'], ['e']]);
  });
});
