// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Macros } from '@diet-app/shared';
import { KCAL_PER_GRAM } from '@diet-app/shared/units';

/** One macronutrient's part of the energy: its grams, the kcal they give and its whole-percent share. */
export interface EnergyPart {
  key: keyof Macros;
  grams: number;
  kcal: number;
  percent: number;
}

const KEYS = ['protein', 'fat', 'carbs'] as const;

/**
 * How the energy of `grams` splits between protein, fat and carbohydrate,
 * which is how a profile's split is set: a gram of fat gives more than twice
 * the energy of the others. The percents are whole and add up to a hundred,
 * the remainders going to the parts with the largest; null where the grams
 * give no energy.
 */
export function energySplit(grams: Macros): EnergyPart[] | null {
  const kcal = KEYS.map((key) => grams[key] * KCAL_PER_GRAM[key]);
  const total = kcal.reduce((sum, part) => sum + part, 0);
  if (total <= 0) return null;
  const exact = kcal.map((part) => (part * 100) / total);
  const percents = exact.map(Math.floor);
  const left = 100 - percents.reduce((sum, part) => sum + part, 0);
  const byRemainder = exact.map((share, index) => ({ index, remainder: share - Math.floor(share) })).sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const { index } of byRemainder.slice(0, left)) percents[index]! += 1;
  return KEYS.map((key, index) => ({ key, grams: grams[key], kcal: kcal[index]!, percent: percents[index]! }));
}
