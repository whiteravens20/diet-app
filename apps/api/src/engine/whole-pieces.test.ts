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

  it('leave a meal that was eaten with the share it was eaten with, the rest of the pot taking what is left of its pieces', () => {
    // 2.5 eggs are 3: his 1.8 eaten (a factor of 1.2 kept), hers resized afterwards to 0.5 exactly.
    const factors = wholePieceFactors([
      [
        { meal: 'his', ingredient: 'egg', pieces: 1.5, kept: 1.2 },
        { meal: 'hers', ingredient: 'egg', pieces: 0.5 },
      ],
    ]);

    expect(factors.get('his')!.get('egg')).toBe(1.2);
    // 1.8 and 0.5 are 2.3, so 2 eggs: what is left of them after his 1.8 is hers.
    expect(factors.get('hers')!.get('egg')! * 0.5).toBeCloseTo(0.2);
  });

  it('give the rest of a pot its own whole pieces where what was eaten took every piece there was', () => {
    const factors = wholePieceFactors([
      [
        { meal: 'his', ingredient: 'egg', pieces: 1, kept: 1 },
        { meal: 'hers', ingredient: 'egg', pieces: 0.3 },
      ],
    ]);

    expect(factors.get('his')!.get('egg')).toBe(1);
    expect(factors.get('hers')!.get('egg')! * 0.3).toBeCloseTo(1);
  });

  it('keep the share of each meal that was eaten, however many of the pot were', () => {
    const factors = wholePieceFactors([
      [
        { meal: 'a', ingredient: 'egg', pieces: 0.6, kept: 0.8 },
        { meal: 'b', ingredient: 'egg', pieces: 0.6, kept: 0.9 },
      ],
    ]);

    expect(factors.get('a')!.get('egg')).toBe(0.8);
    expect(factors.get('b')!.get('egg')).toBe(0.9);
  });

  it('give the meal not eaten the factor it had once the other meal of its pot is eaten with the share it had', () => {
    const before = wholePieceFactors([
      [
        { meal: 'eaten', ingredient: 'egg', pieces: 0.67 },
        { meal: 'left', ingredient: 'egg', pieces: 0.67 },
      ],
    ]);
    const share = before.get('eaten')!.get('egg')!;
    const after = wholePieceFactors([
      [
        { meal: 'eaten', ingredient: 'egg', pieces: 0.67, kept: share },
        { meal: 'left', ingredient: 'egg', pieces: 0.67 },
      ],
    ]);

    expect(after.get('left')!.get('egg')).toBeCloseTo(before.get('left')!.get('egg')!);
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
