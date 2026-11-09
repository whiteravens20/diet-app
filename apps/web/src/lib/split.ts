// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Each portion's share of a dish, from the energy each is planned to hold, as
 * parts of one. Where no portion's energy is known they share it equally; a
 * portion of unknown energy beside known ones gets nothing.
 */
export function sharesOf(kcal: readonly (number | null)[]): number[] {
  const known = kcal.map((one) => (one !== null && Number.isFinite(one) && one > 0 ? one : 0));
  const total = known.reduce((sum, one) => sum + one, 0);
  if (total <= 0) return kcal.map(() => 1 / kcal.length);
  return known.map((one) => one / total);
}

/**
 * `whole` grams or pieces split by `shares` into whole ones that add up to it:
 * a portion is its rounded running total less the one before, so that each
 * stays within one of its exact part and the last takes what is left.
 */
export function splitWhole(whole: number, shares: readonly number[]): number[] {
  const total = Math.max(0, Math.round(whole));
  let running = 0;
  let before = 0;
  return shares.map((share, index) => {
    running += share;
    const upTo = index === shares.length - 1 ? total : Math.min(total, Math.round(total * running));
    const portion = upTo - before;
    before = upTo;
    return portion;
  });
}

/** What the food alone weighs: the scale's weight, less the empty pot's where it was weighed in it; null where that leaves nothing. */
export function foodWeight(onScale: number, emptyPot: number | null): number | null {
  const food = emptyPot === null ? onScale : onScale - emptyPot;
  return Number.isFinite(food) && food > 0 ? food : null;
}
