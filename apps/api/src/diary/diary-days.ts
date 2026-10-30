// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/** Energy and the three macronutrients, in kcal and grams. */
interface Amounts {
  calories: number;
  protein: number;
  fat: number;
  carbs: number;
}

/** Figures as a person reads them: whole kilocalories and grams. */
export function wholeFigures(figures: Amounts): Amounts {
  return {
    calories: Math.round(figures.calories),
    protein: Math.round(figures.protein),
    fat: Math.round(figures.fat),
    carbs: Math.round(figures.carbs),
  };
}
