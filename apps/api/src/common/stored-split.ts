// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { KCAL_PER_GRAM, MacroSplit } from '@diet-app/shared';
import { ownSplit, proteinKcalOf, sharesOf, wholePercent } from '../engine/index.js';

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

/**
 * What a plan keeps of the split it aims at: the split in whole per cent and,
 * for one made by the custom diet's protein per kilogram, the grams of protein
 * a day each of its days aims at (`storedProteinGrams`). Clients never read it.
 */
export type PlanSplit = MacroSplit & { proteinGrams?: number };

/** The split a plan keeps, with the protein of one made by protein per kilogram; null where it keeps none. */
export function storedPlanSplit(kept: unknown): PlanSplit | null {
  const split = storedSplit(kept);
  if (!split) return null;
  const proteinGrams = storedProteinGrams(kept);
  return proteinGrams === null ? split : { ...split, proteinGrams };
}

/**
 * The split a plan of the custom diet takes of this profile at its base `target`: the profile's own, and where the
 * profile sets its protein per kilogram, the grams of the body's weight now and the split they come to. Null where the
 * profile says no split.
 */
export function customSplitOf(
  profile: { customMacroSplit: unknown; customProteinPerKg: number | null; weightKg: number },
  target: number,
): PlanSplit | null {
  const split = storedSplit(profile.customMacroSplit);
  if (!split) return null;
  if (profile.customProteinPerKg == null) return split;
  const proteinKcal = proteinKcalOf(profile.customProteinPerKg, profile.weightKg);
  return {
    ...(wholePercent(ownSplit(sharesOf(split)!, proteinKcal, target).shares) as MacroSplit),
    proteinGrams: proteinKcal / KCAL_PER_GRAM.protein,
  };
}
