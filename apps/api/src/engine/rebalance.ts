/**
 * F22 deterministic quantity rebalancer.
 *
 * After a plan edit changes a day's total (a swap, a custom meal, an ingredient
 * substitution), the day may drift away from its calorie target. This module
 * pulls it back **by scaling the per-serving quantities of the unchecked,
 * non-custom meals only** — it never swaps a meal and never invents macros, so
 * the menu the user approved stays intact (product invariant). Custom meals
 * (user-entered macros) and eaten meals are pinned.
 *
 * Pure and deterministic: same inputs → same scales. No randomness, no I/O.
 */
import { SERVING_MAX, SERVING_MIN } from './optimizer.js';

export interface RebalanceMeal {
  id: string;
  /** Calories per *baseline* serving (recipe.caloriesPerServing or custom kcal). */
  calories: number;
  /** The optimiser/swap baseline serving count. */
  servings: number;
  /** Current rebalancer multiplier (effective amount = servings * quantityScale). */
  quantityScale: number;
  /** Pinned out of the rebalance set: custom meal, eaten meal, or a locked day. */
  locked: boolean;
}

export type Feasibility = 'in-window' | 'best-effort';

export interface RebalanceResult {
  /** New quantityScale per meal id (unchanged meals keep their current scale). */
  scales: Map<string, number>;
  feasibility: Feasibility;
}

/** Default deviation window: a day within ±10% of its target needs no change. */
export const REBALANCE_TOLERANCE = 0.1;

const effectiveKcal = (m: RebalanceMeal, scale: number) => m.calories * m.servings * scale;

const totalKcal = (meals: RebalanceMeal[], scales: Map<string, number>) =>
  meals.reduce((s, m) => s + effectiveKcal(m, scales.get(m.id) ?? m.quantityScale), 0);

const within = (value: number, target: number, tolerance: number) =>
  Math.abs(value - target) <= tolerance * target;

/**
 * Water-filling solver: distribute `target` across `meals` by giving every
 * unlocked meal a single uniform scale factor, clamping any meal whose effective
 * servings would leave the [SERVING_MIN, SERVING_MAX] band and redistributing the
 * residual among the rest. Converges in at most `flex.length` passes. Locked
 * meals keep their current scale. Returns the closest feasible scale map.
 */
function solve(meals: RebalanceMeal[], target: number): Map<string, number> {
  const scales = new Map(meals.map((m) => [m.id, m.quantityScale]));
  const lockedKcal = meals
    .filter((m) => m.locked)
    .reduce((s, m) => s + effectiveKcal(m, scales.get(m.id)!), 0);

  let active = meals.filter((m) => !m.locked && m.calories > 0 && m.servings > 0);
  let remaining = target - lockedKcal;

  while (active.length > 0) {
    const base = active.reduce((s, m) => s + m.calories * m.servings, 0);
    if (base <= 0) break;
    const f = remaining / base;

    const clamped = active.filter((m) => {
      const lo = SERVING_MIN / m.servings;
      const hi = SERVING_MAX / m.servings;
      return f < lo || f > hi;
    });

    if (clamped.length === 0) {
      for (const m of active) scales.set(m.id, f);
      break;
    }

    const clampedIds = new Set(clamped.map((m) => m.id));
    for (const m of clamped) {
      const lo = SERVING_MIN / m.servings;
      const hi = SERVING_MAX / m.servings;
      const cs = Math.min(hi, Math.max(lo, f));
      scales.set(m.id, cs);
      remaining -= effectiveKcal(m, cs);
    }
    active = active.filter((m) => !clampedIds.has(m.id));
  }

  return scales;
}

/**
 * Rebalance a single day toward `target`. A day already inside the tolerance
 * window is left untouched (no churn). Otherwise the unlocked meals are scaled
 * to close the gap; `best-effort` flags a day that clamping couldn't bring back
 * into the window (e.g. a huge custom meal that overshoots the target alone).
 */
export function rebalanceDay(
  meals: RebalanceMeal[],
  target: number,
  tolerance: number = REBALANCE_TOLERANCE,
): RebalanceResult {
  const current = new Map(meals.map((m) => [m.id, m.quantityScale]));
  if (within(totalKcal(meals, current), target, tolerance)) {
    return { scales: current, feasibility: 'in-window' };
  }
  const scales = solve(meals, target);
  const feasible = within(totalKcal(meals, scales), target, tolerance);
  return { scales, feasibility: feasible ? 'in-window' : 'best-effort' };
}

export interface RebalanceWeekDay {
  target: number;
  meals: RebalanceMeal[];
}

/**
 * Week-aware rebalance: share the surplus/deficit proportionally across every
 * unlocked meal in the plan week by solving against the week's *total* target.
 * Each day still has its own target, so feasibility is `in-window` only when
 * every day lands inside its own window. Untouched when all days already do.
 */
export function rebalanceWeek(
  days: RebalanceWeekDay[],
  tolerance: number = REBALANCE_TOLERANCE,
): RebalanceResult {
  const allMeals = days.flatMap((d) => d.meals);
  const current = new Map(allMeals.map((m) => [m.id, m.quantityScale]));
  const allInWindow = days.every((d) => within(totalKcal(d.meals, current), d.target, tolerance));
  if (allInWindow) return { scales: current, feasibility: 'in-window' };

  const weekTarget = days.reduce((s, d) => s + d.target, 0);
  const scales = solve(allMeals, weekTarget);
  const feasible = days.every((d) => within(totalKcal(d.meals, scales), d.target, tolerance));
  return { scales, feasibility: feasible ? 'in-window' : 'best-effort' };
}
