// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Deterministic quantity rebalancer.
 *
 * After a plan edit changes a day's total (a swap, a custom meal, an ingredient
 * substitution), the day may drift away from its calorie target. This module
 * brings it back **by changing the portions of the unchecked, non-custom meals
 * only** — it never swaps a meal and never invents macros, so the menu the user
 * approved stays intact (product invariant). Custom meals (user-entered macros)
 * and eaten meals are pinned.
 *
 * `sizeDay` sizes the meals of one day, apart from each other where that brings
 * the day nearer its macros. `rebalanceDays` shares what days are off by among
 * the days of a plan.
 *
 * Pure and deterministic: same inputs → same scales. No randomness, no I/O.
 */
import { KCAL_PER_GRAM, type Macros } from '@diet-app/shared';
import {
  SERVING_MAX,
  SERVING_MIN,
  type OptimizerAssignment,
  type OptimizerDay,
  type OptimizerRecipe,
} from './optimizer.js';

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
  /** Grams of protein, fat and carbohydrate in a baseline serving. Left out: the meal is not sized for them. */
  macros?: Macros;
}

type Feasibility = 'in-window' | 'best-effort';

export interface RebalanceResult {
  /** New quantityScale per meal id (unchanged meals keep their current scale). */
  scales: Map<string, number>;
  feasibility: Feasibility;
}

/** The window a plan holds a day to: within ±10% of its target it is on target. */
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

/** How far a meal may go from the portion that shares the day evenly, either way, to bring the day nearer its macros. */
const MACRO_BAND = 0.25;
/** The moves between two meals that are tried, as shares of the day's target: the larger first. */
const MACRO_STEPS = [0.04, 0.02, 0.01, 0.005] as const;
/** What a move has to bring the day nearer its macros, as a share of its target: less is not worth an odder portion. */
const MACRO_GAIN = 0.002;

/**
 * A day this near its target, as a share of it, is on it, and stays as it is
 * unless sizing would bring its macros nearer by more than `NOTHING_MUCH`: the
 * portions of a plan are rounded, and a meal is not moved for what rounding does.
 */
const ON_TARGET = 0.02;
const NOTHING_MUCH = 0.01;

/** How far what a day holds is from what it aims at, in kcal of protein, fat and carbohydrate. */
export const energyAway = (held: Macros, aim: Macros): number =>
  KCAL_PER_GRAM.protein * Math.abs(held.protein - aim.protein) +
  KCAL_PER_GRAM.fat * Math.abs(held.fat - aim.fat) +
  KCAL_PER_GRAM.carbs * Math.abs(held.carbs - aim.carbs);

/** What a day holds of protein, fat and carbohydrate at these portions. */
function heldBy(meals: RebalanceMeal[], scales: Map<string, number>): Macros {
  const held: Macros = { protein: 0, fat: 0, carbs: 0 };
  for (const m of meals) {
    if (!m.macros) continue;
    const amount = m.servings * scales.get(m.id)!;
    held.protein += m.macros.protein * amount;
    held.fat += m.macros.fat * amount;
    held.carbs += m.macros.carbs * amount;
  }
  return held;
}

/**
 * From portions that share the day evenly, move energy from one meal to another
 * while that brings the day nearer `aim`. The day's energy stays what it was, a
 * meal stays within `MACRO_BAND` of where it began and within the bounds of a
 * serving, and a meal that is pinned, or that says nothing of its macros, stays.
 */
function evenOutMacros(
  meals: RebalanceMeal[],
  even: Map<string, number>,
  aim: Macros,
  target: number,
): Map<string, number> {
  const scales = new Map(even);
  const free = meals.filter((m) => !m.locked && m.calories > 0 && m.servings > 0 && m.macros);
  if (free.length < 2) return scales;
  const bounds = new Map(
    free.map((m) => {
      const start = even.get(m.id)!;
      return [
        m.id,
        {
          lowest: Math.max(SERVING_MIN / m.servings, start * (1 - MACRO_BAND)),
          highest: Math.min(SERVING_MAX / m.servings, start * (1 + MACRO_BAND)),
        },
      ];
    }),
  );
  const held = heldBy(meals, scales);
  /** What the day holds once `kcal` of energy moved from one meal to another. */
  const movedTo = (from: RebalanceMeal, to: RebalanceMeal, kcal: number): Macros => {
    const less = kcal / from.calories;
    const more = kcal / to.calories;
    return {
      protein: held.protein - from.macros!.protein * less + to.macros!.protein * more,
      fat: held.fat - from.macros!.fat * less + to.macros!.fat * more,
      carbs: held.carbs - from.macros!.carbs * less + to.macros!.carbs * more,
    };
  };
  for (const step of MACRO_STEPS) {
    const kcal = step * target;
    for (;;) {
      let best: { from: RebalanceMeal; to: RebalanceMeal; after: Macros } | null = null;
      let nearest = energyAway(held, aim) - MACRO_GAIN * target;
      for (const from of free) {
        const lower = scales.get(from.id)! - kcal / (from.calories * from.servings);
        if (lower < bounds.get(from.id)!.lowest) continue;
        for (const to of free) {
          if (to === from) continue;
          const higher = scales.get(to.id)! + kcal / (to.calories * to.servings);
          if (higher > bounds.get(to.id)!.highest) continue;
          const after = movedTo(from, to, kcal);
          const away = energyAway(after, aim);
          if (away < nearest) {
            nearest = away;
            best = { from, to, after };
          }
        }
      }
      if (best === null) break;
      scales.set(
        best.from.id,
        scales.get(best.from.id)! - kcal / (best.from.calories * best.from.servings),
      );
      scales.set(
        best.to.id,
        scales.get(best.to.id)! + kcal / (best.to.calories * best.to.servings),
      );
      Object.assign(held, best.after);
    }
  }
  return scales;
}

/**
 * Size the meals of a day that are not pinned: together they come to what is
 * left of `target`, and within that each takes the portion that brings the day
 * nearest `aim`. A day that is on its target already, with nothing much to gain
 * for its macros, stays as it is: a portion does not change for less, so a day
 * asked again stays. `best-effort` flags a day that the bounds of a serving keep
 * outside the window (e.g. a huge custom meal that overshoots the target alone).
 */
export function sizeDay(meals: RebalanceMeal[], target: number, aim: Macros): RebalanceResult {
  const sized = evenOutMacros(meals, solve(meals, target), aim, target);
  const now = new Map(meals.map((m) => [m.id, m.quantityScale]));
  const stays =
    within(totalKcal(meals, now), target, ON_TARGET) &&
    energyAway(heldBy(meals, now), aim) <=
      energyAway(heldBy(meals, sized), aim) + NOTHING_MUCH * target;
  const scales = stays ? now : sized;
  return {
    scales,
    feasibility: within(totalKcal(meals, scales), target, REBALANCE_TOLERANCE)
      ? 'in-window'
      : 'best-effort',
  };
}

/** A meal a run of the planner placed, with the factor that sizes it on its day. */
export type SizedAssignment = OptimizerAssignment & { quantityScale: number };

/**
 * What a run of the planner placed, with the meals of each day sized as
 * `sizeDay` sizes them: to what is left of the day's target once the meals that
 * stay on it are counted, and within that for the split the plan aims at. The
 * servings stay what the planner gave; the factor is what any later change of
 * the day starts from as well, so that a day sized again comes to the same.
 */
export function sizeAssignments(
  days: readonly OptimizerDay[],
  recipes: readonly OptimizerRecipe[],
  assignments: readonly OptimizerAssignment[],
  split: Macros,
): SizedAssignment[] {
  const recipeOf = new Map(recipes.map((recipe) => [recipe.id, recipe]));
  const sized = new Map<OptimizerAssignment, number>();
  days.forEach((day, dayIndex) => {
    const placed = assignments.filter((meal) => meal.dayIndex === dayIndex);
    if (placed.length === 0) return;
    const target = day.dailyCalorieTarget;
    const meals: RebalanceMeal[] = [
      ...(day.kept ?? []).map((meal, index) => ({
        id: `kept:${index}`,
        calories: meal.calories,
        servings: 1,
        quantityScale: 1,
        locked: true,
        ...(meal.macros ? { macros: meal.macros } : {}),
      })),
      ...placed.map((meal) => {
        const recipe = recipeOf.get(meal.recipeId)!;
        return {
          id: meal.slot,
          calories: recipe.caloriesPerServing,
          servings: meal.servings,
          quantityScale: 1,
          locked: false,
          macros: {
            protein: recipe.proteinPerServing,
            fat: recipe.fatPerServing,
            carbs: recipe.carbsPerServing,
          },
        };
      }),
    ];
    const { scales } = sizeDay(meals, target, {
      protein: (target * split.protein) / KCAL_PER_GRAM.protein,
      fat: (target * split.fat) / KCAL_PER_GRAM.fat,
      carbs: (target * split.carbs) / KCAL_PER_GRAM.carbs,
    });
    for (const meal of placed) sized.set(meal, scales.get(meal.slot)!);
  });
  // To two places: nobody weighs out the third, and what a meal shows is rounded anyway.
  return assignments.map((meal) => ({
    ...meal,
    quantityScale: Math.round((sized.get(meal) ?? 1) * 100) / 100,
  }));
}

export interface DayToRebalance {
  target: number;
  /** The day's meals; none for a day the user skips. */
  meals: RebalanceMeal[];
  /** What the day aims at of protein, fat and carbohydrate, in grams: what is moved on it keeps to that. */
  aim?: Macros;
}

export interface DaysRebalanceResult extends RebalanceResult {
  /**
   * The kcal the days are still off by after everything that can move has
   * moved: positive when more was eaten than the targets allow, negative when
   * less. Zero when the other days took it all.
   */
  unabsorbed: number;
}

/**
 * Rebalance a run of days together, in two steps.
 *
 *  1. A day that is outside its window is brought back with its own meals. A
 *     day inside its window is not touched.
 *  2. What such a day could not absorb itself (its meals were eaten, or would
 *     go under the smallest serving) is spread over the other days, each of
 *     which gives in proportion to the room it has inside its own window. So
 *     no day that was inside its window is taken out of it.
 *
 * A day without meals is one the user skips: it is neither a target to fill
 * nor a day to test. `in-window` says that every day with meals ended inside
 * its own window; `unabsorbed` is what the days could not make up for.
 */
export function rebalanceDays(
  days: DayToRebalance[],
  tolerance: number = REBALANCE_TOLERANCE,
): DaysRebalanceResult {
  const live = days.filter((d) => d.meals.length > 0);
  const scales = new Map(live.flatMap((d) => d.meals).map((m) => [m.id, m.quantityScale]));
  const total = (d: DayToRebalance) => totalKcal(d.meals, scales);
  const inside = (d: DayToRebalance) => within(total(d), d.target, tolerance);
  /** Solve one day against `target` with the scales it has now, and keep the result. */
  const settle = (d: DayToRebalance, target: number): void => {
    const now = d.meals.map((m) => ({ ...m, quantityScale: scales.get(m.id)! }));
    const even = solve(now, target);
    const sized = d.aim ? evenOutMacros(now, even, d.aim, target) : even;
    for (const [id, scale] of sized) scales.set(id, scale);
  };

  if (live.every(inside)) return { scales, feasibility: 'in-window', unabsorbed: 0 };

  const outside = live.filter((d) => !inside(d));
  for (const d of outside) settle(d, d.target);

  // What the days that are still outside could not make up for themselves.
  const stillOutside = outside.filter((d) => !inside(d));
  let left = stillOutside.reduce((sum, d) => sum + (total(d) - d.target), 0);
  if (stillOutside.length > 0 && Math.abs(left) > 1e-9) {
    const over = left > 0;
    // The room a day has: how far it can move towards the edge of its own window.
    const givers = live
      .filter(
        (d) =>
          !stillOutside.includes(d) &&
          d.meals.some((m) => !m.locked && m.calories > 0 && m.servings > 0),
      )
      .map((d) => ({
        day: d,
        room: over ? total(d) - d.target * (1 - tolerance) : d.target * (1 + tolerance) - total(d),
      }))
      .filter((giver) => giver.room > 1e-9);
    const room = givers.reduce((sum, giver) => sum + giver.room, 0);
    const taken = Math.min(Math.abs(left), room);
    for (const { day, room: own } of givers) {
      const before = total(day);
      settle(day, before - (over ? 1 : -1) * taken * (own / room));
      left -= before - total(day);
    }
  }

  return {
    scales,
    feasibility: live.every(inside) ? 'in-window' : 'best-effort',
    unabsorbed: Math.abs(left) < 1e-6 ? 0 : left,
  };
}
