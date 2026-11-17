// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/*
 * The custom diet's protein per kilogram, worked out in the form as the API
 * works it out (`ownSplit` of its engine): the grams of the weight, fat's
 * share and carbohydrate the rest, every share inside the limits of a split.
 */
import {
  KCAL_PER_GRAM,
  proteinPerKgThatFits,
  proteinShareBounds,
  type MacroSplit,
} from '@diet-app/shared';

/** Protein, fat and carbohydrate: per cent or shares of one. */
export interface Parts {
  protein: number;
  fat: number;
  carbs: number;
}

const PARTS = ['protein', 'fat', 'carbs'] as const;

/** Shares of one as whole per cent that add up to a hundred, each rounded the way that misses its share least. */
export function wholePercent(shares: Parts): MacroSplit {
  const parts = PARTS.map((part) => {
    const exact = shares[part] * 100;
    return { part, whole: Math.floor(exact), rest: exact - Math.floor(exact) };
  });
  let left = 100 - parts.reduce((sum, one) => sum + one.whole, 0);
  for (const one of [...parts].sort((a, b) => b.rest - a.rest)) {
    if (left <= 0) break;
    one.whole += 1;
    left -= 1;
  }
  return Object.fromEntries(parts.map((one) => [one.part, one.whole])) as unknown as MacroSplit;
}

/** What protein per kilogram comes to at a target and a weight. */
export interface PerKgSplit {
  /** The split it comes to, in whole per cent, protein held inside the limits. */
  split: MacroSplit;
  /** Grams of protein a day, as the weight gives them before any limit. */
  protein: number;
  /** Protein's share went past a limit, its own or carbohydrate's, and is held there. */
  held: boolean;
  /** The grams a kilogram that keep every share inside its limits here, to a tenth inward; null where none do. */
  fits: { from: number; to: number } | null;
}

/**
 * The way of protein per kilogram at `target` kcal and `weightKg`: protein the
 * energy of its grams, fat its `fatPercent`, carbohydrate the rest; protein
 * held at the limit where a share would go past one, as the API holds it.
 */
export function perKgSplit(
  perKg: number,
  fatPercent: number,
  weightKg: number,
  target: number,
): PerKgSplit {
  const protein = perKg * weightKg;
  const fat = fatPercent / 100;
  const { least, most } = proteinShareBounds(fat);
  const asked = (protein * KCAL_PER_GRAM.protein) / target;
  const kept = Math.min(most, Math.max(least, asked));
  return {
    split: wholePercent({ protein: kept, fat, carbs: 1 - kept - fat }),
    protein,
    held: Math.abs(kept - asked) > 1e-9,
    fits: proteinPerKgThatFits(fat, target, weightKg),
  };
}
