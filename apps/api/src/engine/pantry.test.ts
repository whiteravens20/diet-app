// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import { netEffect, pantryStock, settle, stockUnit, type PantryIngredient, type PantryMove, type PantryRow } from './pantry.js';

/** A large egg: weighed in grams, counted in pieces of 55 g. */
const EGG: PantryIngredient = { canonicalUnit: 'g', gramsPerPiece: 55, density: null, displayUnit: 'piece' };
/** Rice: grams only. */
const RICE: PantryIngredient = { canonicalUnit: 'g', gramsPerPiece: null, density: null, displayUnit: null };
/** Milk: measured in millilitres, 1.03 g each. */
const MILK: PantryIngredient = { canonicalUnit: 'ml', gramsPerPiece: null, density: 1.03, displayUnit: null };

const row = (unit: PantryRow['unit'], quantity: number, bestBefore: string | null = null): PantryRow => ({
  unit,
  quantity,
  bestBefore: bestBefore ? new Date(bestBefore) : null,
});

/** Rows as plain text, in a fixed order, for comparing. */
const shown = (rows: readonly PantryRow[]): string[] =>
  rows
    .map((r) => `${r.quantity} ${r.unit}${r.bestBefore ? ` until ${r.bestBefore.toISOString().slice(0, 10)}` : ''}`)
    .sort();

describe('the stock of an ingredient', () => {
  it('is the sum of its rows, whatever unit each is in', () => {
    expect(pantryStock([row('piece', 8), row('g', 110)], EGG).quantity).toBe(550);
    expect(pantryStock([row('ml', 500), row('g', 103)], MILK).quantity).toBe(600);
  });

  it('counts a row it cannot convert as nothing', () => {
    expect(pantryStock([row('g', 200), row('piece', 3)], RICE)).toEqual({ quantity: 200, bestBefore: null });
  });

  it('names the earliest best-before date among the rows that count', () => {
    const rows = [row('g', 200, '2026-11-20'), row('piece', 2, '2026-11-05'), row('ml', 100, '2026-10-01')];

    expect(pantryStock(rows, EGG).bestBefore).toEqual(new Date('2026-11-05'));
  });

  it('is zero for no rows', () => {
    expect(pantryStock([], EGG)).toEqual({ quantity: 0, bestBefore: null });
  });
});

describe('the unit a new row is written in', () => {
  it('is pieces for an ingredient that is counted in pieces, and the canonical unit otherwise', () => {
    expect(stockUnit(EGG)).toBe('piece');
    expect(stockUnit(RICE)).toBe('g');
    expect(stockUnit(MILK)).toBe('ml');
    // Counted in pieces by name, but with no weight for one: it cannot be.
    expect(stockUnit({ ...RICE, displayUnit: 'piece' })).toBe('g');
  });
});

describe('taking out of the pantry', () => {
  it('takes eggs held in pieces for a need worked out in grams', () => {
    const taken = settle([row('piece', 8)], EGG, [], -220);

    expect(shown(taken.rows)).toEqual(['4 piece']);
    expect(taken.moves).toEqual([{ unit: 'piece', quantity: -4 }]);
    expect(taken.applied).toBe(-220);
  });

  it('gives back exactly what it took, to the row it took from, and makes no row of its own', () => {
    const taken = settle([row('piece', 8)], EGG, [], -220);

    const back = settle(taken.rows, EGG, taken.moves, 0);

    expect(shown(back.rows)).toEqual(['8 piece']);
    expect(back.moves).toEqual([]);
    expect(back.applied).toBe(220);
  });

  it('goes through the rows of every unit until the need is met', () => {
    const taken = settle([row('g', 110), row('piece', 4)], EGG, [], -275);

    expect(shown(taken.rows)).toEqual(['1 piece']);
    expect(taken.moves).toEqual([
      { unit: 'g', quantity: -110 },
      { unit: 'piece', quantity: -3 },
    ]);

    expect(shown(settle(taken.rows, EGG, taken.moves, 0).rows)).toEqual(['110 g', '4 piece']);
  });

  it('uses what expires first, first', () => {
    const rows = [row('g', 300, '2026-11-20'), row('piece', 4, '2026-10-20')];

    const taken = settle(rows, EGG, [], -110);

    expect(shown(taken.rows)).toEqual(['2 piece until 2026-10-20', '300 g until 2026-11-20']);
  });

  it('uses a dated row before one without a date', () => {
    const taken = settle([row('g', 300), row('piece', 4, '2026-10-20')], EGG, [], -110);

    expect(shown(taken.rows)).toEqual(['2 piece until 2026-10-20', '300 g']);
  });

  it('gives a row it emptied back with its best-before date', () => {
    const taken = settle([row('piece', 4, '2026-10-20')], EGG, [], -220);
    expect(taken.rows).toEqual([]);
    expect(taken.moves).toEqual([{ unit: 'piece', quantity: -4, bestBefore: '2026-10-20' }]);

    const back = settle(taken.rows, EGG, taken.moves, 0);

    expect(shown(back.rows)).toEqual(['4 piece until 2026-10-20']);
  });

  it('takes no more than there is, and says how much it took', () => {
    const taken = settle([row('g', 50)], RICE, [], -200);

    expect(taken.rows).toEqual([]);
    expect(taken.applied).toBe(-50);
    expect(taken.moves).toEqual([{ unit: 'g', quantity: -50 }]);

    // Undone, the pantry holds the 50 g it held, not the 200 g that were asked for.
    expect(shown(settle(taken.rows, RICE, taken.moves, 0).rows)).toEqual(['50 g']);
  });

  it('takes nothing from an empty pantry and records nothing', () => {
    expect(settle([], RICE, [], -200)).toEqual({ rows: [], moves: [], applied: 0 });
  });

  it('leaves a row it cannot convert alone', () => {
    const taken = settle([row('piece', 3), row('g', 100)], RICE, [], -500);

    expect(shown(taken.rows)).toEqual(['3 piece']);
    expect(taken.applied).toBe(-100);
  });

  it('leaves an empty row the owner of the pantry keeps', () => {
    const taken = settle([row('g', 0), row('piece', 4)], EGG, [], -55);

    expect(shown(taken.rows)).toEqual(['0 g', '3 piece']);
  });
});

describe('putting into the pantry', () => {
  it('adds what was bought beyond the need to the row that holds the most', () => {
    const banked = settle([row('piece', 2), row('g', 300)], EGG, [], 110);

    expect(shown(banked.rows)).toEqual(['2 piece', '410 g']);
    expect(banked.moves).toEqual([{ unit: 'g', quantity: 110 }]);
  });

  it('starts a row in pieces for an ingredient counted in pieces', () => {
    expect(shown(settle([], EGG, [], 330).rows)).toEqual(['6 piece']);
  });

  it('starts a row in the canonical unit for everything else', () => {
    expect(shown(settle([], RICE, [], 250).rows)).toEqual(['250 g']);
    expect(shown(settle([], MILK, [], 250).rows)).toEqual(['250 ml']);
  });

  it('takes back what it put in when the purchase is corrected', () => {
    const banked = settle([row('g', 300)], RICE, [], 200);
    expect(shown(banked.rows)).toEqual(['500 g']);

    const corrected = settle(banked.rows, RICE, banked.moves, 50);

    expect(shown(corrected.rows)).toEqual(['350 g']);
    expect(corrected.moves).toEqual([{ unit: 'g', quantity: 50 }]);
  });

  it('removes only what is still there of a surplus that was used up meanwhile', () => {
    const banked = settle([], RICE, [], 100);
    // The owner of the pantry cooked 70 g of it.
    const eaten = [row('g', 30)];

    const undone = settle(eaten, RICE, banked.moves, 0);

    expect(undone.rows).toEqual([]);
    expect(undone.applied).toBe(-30);
    // What could not be undone stays on the record, so ticking the row again
    // puts back the 30 g that were there, not the whole surplus a second time.
    expect(netEffect(undone.moves, RICE)).toBe(70);
    expect(shown(settle(undone.rows, RICE, undone.moves, 100).rows)).toEqual(['30 g']);
  });
});

describe('a purchase edited while its row is ticked', () => {
  it('returns to the row it took from before making new stock', () => {
    // Four eggs taken for the plan; then the user notes one egg more than needed.
    const taken = settle([row('piece', 8)], EGG, [], -220);

    const edited = settle(taken.rows, EGG, taken.moves, -165);

    expect(shown(edited.rows)).toEqual(['5 piece']);
    expect(edited.moves).toEqual([{ unit: 'piece', quantity: -3 }]);
  });

  it('crosses from taking to putting in one step', () => {
    const taken = settle([row('piece', 8)], EGG, [], -220);

    const banked = settle(taken.rows, EGG, taken.moves, 110);

    expect(shown(banked.rows)).toEqual(['10 piece']);
    expect(banked.moves).toEqual([{ unit: 'piece', quantity: 2 }]);
  });

  it('returns what keeps longest first, so that what expires soonest stays used', () => {
    const rows = [row('g', 110, '2026-10-20'), row('piece', 4, '2026-11-20')];
    const taken = settle(rows, EGG, [], -220);
    expect(shown(taken.rows)).toEqual(['2 piece until 2026-11-20']);

    const edited = settle(taken.rows, EGG, taken.moves, -110);

    expect(shown(edited.rows)).toEqual(['4 piece until 2026-11-20']);
    expect(edited.moves).toEqual([{ unit: 'g', quantity: -110, bestBefore: '2026-10-20' }]);
  });

  it('changes nothing when the target is where the ledger already is', () => {
    const taken = settle([row('piece', 8)], EGG, [], -220);

    const again = settle(taken.rows, EGG, taken.moves, -220);

    expect(again.applied).toBe(0);
    expect(again.moves).toEqual(taken.moves);
    expect(shown(again.rows)).toEqual(shown(taken.rows));
  });
});

/** A small generator of the same numbers for the same seed. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('any sequence of ticks, edits and unticks by several shopping rows', () => {
  const INGREDIENTS = [EGG, RICE, MILK];
  const DATES = [null, '2026-10-20', '2026-11-05', '2026-12-01'];

  /** Random rows of one ingredient: none, one unit, or several. */
  function pantry(random: () => number, ingredient: PantryIngredient): PantryRow[] {
    const units: PantryRow['unit'][] = ingredient === EGG ? ['g', 'piece'] : ingredient === MILK ? ['ml', 'g'] : ['g'];
    return units
      .filter(() => random() < 0.7)
      .map((unit) => row(unit, Math.round(random() * (unit === 'piece' ? 12 : 600) * 4) / 4, DATES[Math.floor(random() * DATES.length)]!));
  }

  it('never makes or loses stock: the pantry is what it was plus what the ledgers say', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const random = seeded(seed);
      const ingredient = INGREDIENTS[seed % INGREDIENTS.length]!;
      const initial = pantry(random, ingredient);
      let rows = initial;
      const ledgers: PantryMove[][] = [[], [], []];

      for (let step = 0; step < 12; step += 1) {
        const owner = Math.floor(random() * ledgers.length);
        // Mostly takes, sometimes a surplus, sometimes back to nothing.
        const kind = random();
        const target = kind < 0.25 ? 0 : kind < 0.8 ? -Math.round(random() * 500) : Math.round(random() * 300);
        const before = netEffect(ledgers[owner]!, ingredient);

        const result = settle(rows, ingredient, ledgers[owner]!, target);

        // Never beyond what was asked, never the other way.
        const asked = target - before;
        expect(Math.abs(result.applied)).toBeLessThanOrEqual(Math.abs(asked) + 1e-6);
        if (Math.abs(result.applied) > 1e-6) expect(Math.sign(result.applied)).toBe(Math.sign(asked));
        // The ledger says what was done.
        expect(netEffect(result.moves, ingredient)).toBeCloseTo(before + result.applied, 4);
        // No row below zero.
        for (const r of result.rows) expect(r.quantity).toBeGreaterThanOrEqual(0);
        // Putting in always succeeds in full.
        if (asked > 0) expect(result.applied).toBeCloseTo(asked, 4);

        rows = result.rows;
        ledgers[owner] = result.moves;

        const effects = ledgers.reduce((sum, ledger) => sum + netEffect(ledger, ingredient), 0);
        expect(pantryStock(rows, ingredient).quantity, `seed ${seed}, step ${step}`).toBeCloseTo(
          pantryStock(initial, ingredient).quantity + effects,
          3,
        );
      }
    }
  });

  it('ends where it began, row for row, when rows only took and all are unticked', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const random = seeded(seed * 7919);
      const ingredient = INGREDIENTS[seed % INGREDIENTS.length]!;
      const initial = pantry(random, ingredient);
      let rows = initial;
      const ledgers: PantryMove[][] = [[], [], []];

      for (let step = 0; step < 10; step += 1) {
        const owner = Math.floor(random() * ledgers.length);
        const target = random() < 0.3 ? 0 : -Math.round(random() * 500);
        const result = settle(rows, ingredient, ledgers[owner]!, target);
        rows = result.rows;
        ledgers[owner] = result.moves;
      }
      for (let owner = 0; owner < ledgers.length; owner += 1) {
        const result = settle(rows, ingredient, ledgers[owner]!, 0);
        rows = result.rows;
        expect(result.moves).toEqual([]);
      }

      // A row that was empty to begin with and never used may be gone or kept; what holds stock must match.
      const holding = (list: readonly PantryRow[]) => shown(list.filter((r) => r.quantity > 0));
      expect(holding(rows), `seed ${seed}`).toEqual(holding(initial));
    }
  });
});
