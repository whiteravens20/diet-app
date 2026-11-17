// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { MacroSplit } from '@diet-app/shared';

/** The split a row keeps as JSON, as the contract has it; null where the row keeps none, or keeps something that is no split. */
export function storedSplit(kept: unknown): MacroSplit | null {
  return MacroSplit.safeParse(kept).data ?? null;
}

/**
 * The protein a plan made by the custom diet's protein per kilogram keeps
 * beside its split, in grams a day: each of its days aims at these grams, fat
 * at the split's share and carbohydrate at the rest (`ownSplit`). Null for any
 * other plan, whose JSON holds the split alone.
 */
export function storedProteinGrams(kept: unknown): number | null {
  const grams = (kept as { proteinGrams?: unknown } | null | undefined)?.proteinGrams;
  return typeof grams === 'number' && Number.isFinite(grams) && grams > 0 ? grams : null;
}
