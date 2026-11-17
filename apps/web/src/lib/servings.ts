// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Whether a meal holds as many servings as its recipe makes, as the sentences that name both pick their words by:
 * `yes` where they are the same as shown (to the thousandth a number shows at most), `no` otherwise.
 */
export function sameServings(recipe: number, mine: number): 'yes' | 'no' {
  return Math.round(recipe * 1000) === Math.round(mine * 1000) ? 'yes' : 'no';
}
