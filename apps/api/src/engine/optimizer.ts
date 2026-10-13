// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Deterministic meal-plan optimiser.
 *
 * A plan is filled day by day, and a day meal by meal. For each meal the
 * recipes that may go there are scored, and the best one is placed. Given the
 * same input the result is the same plan; another `seed` gives another.
 *
 * How a day keeps to its target. A meal has a budget: its share of what is
 * still left of the day. After every meal that is placed, the meals still to
 * come share what is left, so one meal that runs over is made up for by the
 * next. A recipe costs nothing while its meal is inside a tenth of the
 * budget, and more the further outside it is: a dish is not trimmed to hit a
 * number. The snack is placed last and takes what the day has left.
 *
 * How a plan stays varied. Limits that hold across the whole plan: a recipe
 * is used at most so many days in a row and so many times in any seven days,
 * counted over all meals; not twice on one day unless the plan is for
 * cooking ahead; at most so many times in the plan; within the day's cooking
 * time. When no recipe is left for a meal inside the limits, one limit after
 * another gives way in a fixed order, if the caller allows it; what gave way
 * is reported, and the recipe used least so far is preferred. When it may
 * not give way, the plan is not made and the caller is told what stood in
 * the way.
 */
import { fitsDiet, PLAN_RELAXATIONS, type DietType, type Macros, type MealType, type PlanRelaxation, type Unit } from '@diet-app/shared';
import { energyShares, splitDistance } from './nutrition.js';
import { packPull } from './packs.js';
import { toCanonical, UnitConversionError, type ConvertibleIngredient } from './units.js';

export interface OptimizerRecipe {
  id: string;
  mealTypes: MealType[];
  /** The diets the recipe qualifies for; see `fitsDiet` for the ones that need no tag. */
  dietTags: string[];
  caloriesPerServing: number;
  proteinPerServing: number;
  fatPerServing: number;
  carbsPerServing: number;
  ingredientIds: string[];
  /**
   * What one serving takes of each ingredient, in the ingredient's own unit
   * (grams or millilitres). Left out: the limit on one ingredient in seven
   * days does not see the recipe.
   */
  amounts?: ReadonlyMap<string, number>;
  difficulty: 'easy' | 'medium' | 'hard';
  isFavorite: boolean;
  /** The user marked the recipe as one they eat often: it counts on top of being a favourite. */
  eatenOften?: boolean;
  /** The cuisine the recipe belongs to, when it belongs to one. */
  cuisine?: string | null;
  /** Total prep + cook minutes — used by the per-day cook-time budget. */
  totalMinutes: number;
}

/**
 * What one day asks for: its meals and its calorie target, and what the user
 * set for it. Ingredient reuse, variety and the limits are counted across all
 * days of the plan. A day with `skip` gets no meals.
 */
export interface OptimizerDay {
  mealSlots: MealType[];
  dailyCalorieTarget: number;
  /** The most minutes of preparing and cooking a recipe of this day may take. */
  cookTimeBudgetMinutes?: number;
  /** Recipes pinned to slots before the greedy fill (the rest fills around them). */
  lockedSlots?: Array<{ slot: MealType; recipeId: string }>;
  /** Per-day inventory-coverage map (use-up-by); falls back to the plan map. */
  inventoryCoverage?: ReadonlyMap<string, number>;
  /** Produce no meals for this day. */
  skip?: boolean;
  /**
   * Recipes that fill a meal of this day only where the limits leave no
   * other: what the day holds already, when another way to fill it is asked
   * for. They order the choice and rule nothing out.
   */
  avoid?: ReadonlySet<string>;
  /**
   * Meals that are on this day already and stay there. They are not chosen
   * again: `mealSlots` names the meals to fill. They count for the limits of
   * the plan, on the days before them and after, and what they hold is taken
   * from the day's target before the meals to fill are budgeted.
   */
  kept?: KeptMeal[];
}

export interface KeptMeal {
  /** Left out for a meal of the user's own, which is no recipe. */
  recipeId?: string;
  calories: number;
  /** How many servings of the recipe the meal is; one when left out. */
  servings?: number;
  /** The protein, fat and carbohydrate the meal holds, in grams; left out when that is not known. */
  macros?: Macros;
}

export interface OptimizerInput {
  recipes: OptimizerRecipe[];
  /** One descriptor per day (length = plan duration). See {@link OptimizerDay}. */
  days: OptimizerDay[];
  /**
   * The split of a day's energy between protein, fat and carbohydrate that
   * the plan aims at, as shares that add up to one. Omitted: the split plays
   * no part in the choice of recipes.
   */
  macroSplit?: Macros;
  dietType: DietType;
  mealPrepFriendly: boolean;
  /**
   * Ingredients the user has marked as favourites — recipes containing them
   * receive a small scoring bonus. Empty / omitted disables the bias.
   */
  favoriteIngredientIds?: ReadonlySet<string>;
  /**
   * Ingredients the user would rather not eat. A recipe that holds one fills
   * a meal only where every recipe the limits leave for it holds one: it
   * orders the choice and rules nothing out. Empty or omitted: no part in it.
   */
  dislikedIngredientIds?: ReadonlySet<string>;
  /**
   * Cuisines the user prefers: a recipe of one of them scores a little
   * higher. Empty or omitted: no part in the choice.
   */
  preferredCuisines?: ReadonlySet<string>;
  /**
   * Pantry-coverage map: `recipeId → [0..1]` share of the recipe's
   * required ingredient mass already covered by the profile's inventory.
   * Caller pre-computes this from the inventory snapshot + recipe
   * requirements (the optimiser stays pure / unit-test friendly). Omitted or
   * empty disables the bias — users with an empty pantry see no change.
   */
  inventoryCoverage?: ReadonlyMap<string, number>;
  /**
   * The most days in a row, and the most times in any seven days, that one
   * recipe is eaten, at whichever meal. Omitted: seven of each, which is no
   * limit within a week.
   */
  maxConsecutiveDaysSameMeal?: number;
  maxTimesPerWeekSameMeal?: number;
  /**
   * The most times one recipe may appear in the whole plan, over all days and
   * meals. Omitted: no such limit.
   */
  maxRepeatsPerRecipe?: number;
  /**
   * The most of one ingredient, in its own unit (grams or millilitres), that
   * the meals of any seven days may hold together. Omitted: no such limit.
   */
  maxIngredientPerWeek?: number;
  /**
   * The pack of each ingredient whose opened pack does not keep, in the
   * ingredient's own unit. A recipe that takes from a pack the plan has
   * opened and mostly left scores higher, and one that would open a pack
   * with little of the plan left to use it in scores lower (`packs.ts`).
   * Omitted or empty: packs play no part in the choice.
   */
  perishablePacks?: ReadonlyMap<string, number>;
  /**
   * The limits that may give way when no recipe is left for a meal inside
   * them. `all` (the default) lets any of them. A limit that may give way
   * does so before one that may not; a plan in which one that may not had to
   * is refused, with what stood in the way.
   */
  allowRelaxations?: ReadonlySet<Relaxation> | 'all';
  /** Changes the deterministic tie-break order so "regenerate" yields a new plan. */
  seed: number;
}

/**
 * A limit that can give way, in the order in which they do: the most a recipe
 * appears in the plan first, then the day's cooking time, then a recipe twice
 * on one day, then days in a row, then the times a recipe is eaten in seven
 * days, and the most of one ingredient in seven days last.
 */
const RELAXATION_ORDER = PLAN_RELAXATIONS;
export type Relaxation = PlanRelaxation;

/** A meal whose recipe is outside limits of the plan, and which. */
export interface RelaxedSlot {
  dayIndex: number;
  slot: MealType;
  gaveWay: Relaxation[];
}

/** What a run had to do to fill the plan, for whoever made it to read. */
interface OptimizerReport {
  /** Meals for which a limit gave way, and which. */
  relaxations: RelaxedSlot[];
  /** Meals for which the diet and the meal left one recipe to choose from. */
  singleCandidate: { dayIndex: number; slot: MealType }[];
}

/** Build a uniform per-day descriptor list (the basic, no-overrides flow). */
export function uniformDays(
  days: number,
  mealSlots: MealType[],
  dailyCalorieTarget: number,
): OptimizerDay[] {
  return Array.from({ length: days }, () => ({ mealSlots, dailyCalorieTarget }));
}

interface OptimizerAssignment {
  dayIndex: number;
  slot: MealType;
  recipeId: string;
  servings: number;
}

export interface OptimizerResult {
  assignments: OptimizerAssignment[];
  /** 0-1 — share of ingredients that more than one recipe of the plan uses. */
  ingredientReuseScore: number;
  report: OptimizerReport;
}

/** Fraction of daily calories nominally allocated to each meal slot. */
const SLOT_WEIGHT: Record<MealType, number> = {
  breakfast: 0.25,
  second_breakfast: 0.1,
  lunch: 0.35,
  dinner: 0.3,
  snack: 0.1,
};

export const SCORE_WEIGHTS = {
  calorieFit: 0.45,
  // How near the day comes to the split it aims at. Chosen with
  // `scripts/tune-macro-weight.ts`: the least weight at which the days of a
  // plan stop getting nearer their split, so that it costs variety no more
  // than it has to.
  macroFit: 0.6,
  reuse: 0.25,
  variety: 0.15,
  favorite: 0.1,
  // On top of `favorite`, for a recipe marked as eaten often: together as much as the pull of the pantry and of a favourite.
  often: 0.1,
  favoriteIngredient: 0.08,
  // As much as a recipe made of favourite ingredients: a lean, not a rule.
  cuisine: 0.08,
  // Weighted equal to favorite (0.10) so a 100%-covered recipe and a
  // favourited recipe weigh comparably. Lower would let day-to-day variety
  // overrule the pantry; higher would risk monotony before the anti-monotony
  // reset triggers.
  inventoryCoverage: 0.1,
  complexity: 0.05,
  // What a meal does to the packs of the plan, from -1 to 1. Chosen with
  // `scripts/tune-pack-weight.ts`: at this weight a week leaves about a third
  // fewer packs more than three tenths full where the catalogue gives it a
  // choice, and a day is at most a point further from its split. More weight
  // goes on taking from the split and from the variety of a week.
  packs: 0.15,
  // In a plan made for cooking ahead: the recipe that was cooked the day
  // before, eaten a second time. More than what a recipe eaten again loses
  // on reuse and variety, so that it happens; the limits keep it to days.
  cookOnce: 0.4,
};
export type ScoreWeights = typeof SCORE_WEIGHTS;

/** A day that is this far from its split, or further, gets nothing for it. */
const MACRO_REACH = 0.5;

export const SERVING_MIN = 0.5;
export const SERVING_MAX = 3;

export class OptimizerError extends Error {
  constructor(
    message: string,
    /** The meal no recipe could fill and the diet it was wanted for, when that is what went wrong. */
    readonly gap?: { slot: MealType; dietType: DietType },
    /**
     * The meals that could only be filled by letting limits give way that may
     * not, with everything that gave way at each, and the limits that may not.
     */
    readonly blocked?: { meals: RelaxedSlot[]; needs: Relaxation[] },
  ) {
    super(message);
  }
}

/** A meal inside this share of its budget, either way, costs nothing. */
const CALORIE_WINDOW = 0.1;
/** A recipe that cannot reach this share of a meal's budget at the largest serving is no candidate for it. */
const MIN_REACH = 0.7;
/** How many draws a plan is tried with before limits are taken to have to give way. */
const ATTEMPTS = 12;

/** Per-slot calorie budgets that sum to the daily target. */
export function slotBudgets(slots: MealType[], dailyTarget: number): Map<MealType, number> {
  const totalWeight = slots.reduce((s, slot) => s + SLOT_WEIGHT[slot], 0);
  const budgets = new Map<MealType, number>();
  for (const slot of slots) {
    budgets.set(slot, (SLOT_WEIGHT[slot] / totalWeight) * dailyTarget);
  }
  return budgets;
}

/** Servings (quarter increments) that bring a recipe closest to a budget. */
export function fitServings(caloriesPerServing: number, budget: number): number {
  if (caloriesPerServing <= 0) return 1;
  const raw = budget / caloriesPerServing;
  const quantised = Math.round(raw * 4) / 4;
  return Math.min(SERVING_MAX, Math.max(SERVING_MIN, quantised));
}

function eligible(recipe: OptimizerRecipe, slot: MealType, dietType: DietType): boolean {
  return recipe.mealTypes.includes(slot) && fitsDiet(recipe.dietTags, dietType);
}

/** One meal that was placed: what the limits across the plan are counted from. */
interface Use {
  day: number;
  recipeId: string;
}

/** How much of one ingredient the meals of a day hold. */
interface Held {
  day: number;
  amount: number;
}

/** What a recipe that is on no day of the plan has for meals, and what the plan holds of an ingredient no meal of it takes. */
const NO_USES: readonly Use[] = [];
const NOTHING_HELD: readonly Held[] = [];

/**
 * Generate a plan. Throws `OptimizerError` when a meal has no recipe for the
 * diet at all (`gap`), or when the plan could only be filled by letting
 * limits give way that may not (`blocked`).
 *
 * Meals are filled one after another, and what one takes narrows what the
 * next may: a run can leave a meal without a recipe inside the limits where
 * other choices would not have. A run in which a limit gave way is therefore
 * tried again with other draws, and of the runs the one stands in which the
 * fewest meals are outside a limit, counting first the limits that may not
 * give way.
 */
export function optimisePlan(input: OptimizerInput, weights: ScoreWeights = SCORE_WEIGHTS): OptimizerResult {
  const mayGiveWay = (kind: Relaxation): boolean => {
    const allowed = input.allowRelaxations ?? 'all';
    return allowed === 'all' || allowed.has(kind);
  };
  const refusedIn = (run: Filled): RelaxedSlot[] => run.report.relaxations.filter((entry) => !entry.gaveWay.every(mayGiveWay));

  let best = fill(input, input.seed, mayGiveWay, weights);
  for (let attempt = 1; attempt < ATTEMPTS && best.report.relaxations.length > 0; attempt += 1) {
    const other = fill(input, input.seed + attempt, mayGiveWay, weights);
    const fewer = refusedIn(other).length - refusedIn(best).length || other.report.relaxations.length - best.report.relaxations.length;
    if (fewer < 0) best = other;
  }

  const refused = refusedIn(best);
  if (refused.length > 0) {
    const needs = RELAXATION_ORDER.filter((kind) => !mayGiveWay(kind) && refused.some((entry) => entry.gaveWay.includes(kind)));
    throw new OptimizerError(`limits that may not give way would have to: ${needs.join(', ')}`, undefined, { meals: refused, needs });
  }
  return { assignments: best.assignments, ingredientReuseScore: reuseScore(best.uses, input.recipes), report: best.report };
}

interface Filled {
  assignments: OptimizerAssignment[];
  report: OptimizerReport;
  /** Every meal of the plan that holds a recipe: those that stay and those the run placed. */
  uses: readonly Use[];
}

/** One run over the plan, with the draws of `seed`: every meal filled, whatever had to give way for it. */
function fill(input: OptimizerInput, seed: number, mayGiveWay: (kind: Relaxation) => boolean, weights: ScoreWeights): Filled {
  const recipeById = new Map(input.recipes.map((r) => [r.id, r]));
  const assignments: OptimizerAssignment[] = [];
  const report: OptimizerReport = { relaxations: [], singleCandidate: [] };
  const planIngredients = new Set<string>(); // ingredients already "purchased"
  const uses: Use[] = [];
  // The same meals by their recipe: a meal asks about each of some hundreds
  // of recipes, and all but a few of them are on no day of the plan yet.
  const usesByRecipe = new Map<string, Use[]>();
  const usesOf = (recipeId: string): readonly Use[] => usesByRecipe.get(recipeId) ?? NO_USES;
  const useCount = new Map<string, number>();
  const held = new Map<string, Held[]>(); // ingredientId → what the meals placed so far hold of it
  const heldInAll = new Map<string, number>(); // ingredientId → what they hold of it together
  const place = (day: number, recipeId: string, servings: number): void => {
    const use = { day, recipeId };
    uses.push(use);
    const mine = usesByRecipe.get(recipeId);
    if (mine) mine.push(use);
    else usesByRecipe.set(recipeId, [use]);
    useCount.set(recipeId, (useCount.get(recipeId) ?? 0) + 1);
    const recipe = recipeById.get(recipeId);
    recipe?.ingredientIds.forEach((id) => planIngredients.add(id));
    for (const [ingredientId, perServing] of recipe?.amounts ?? []) {
      const entries = held.get(ingredientId) ?? [];
      entries.push({ day, amount: perServing * servings });
      held.set(ingredientId, entries);
      heldInAll.set(ingredientId, (heldInAll.get(ingredientId) ?? 0) + perServing * servings);
    }
  };
  const heldOf = (ingredientId: string): number => heldInAll.get(ingredientId) ?? 0;
  // What the draw adds to a recipe's score is the same at every meal of the run.
  const jitters = new Map<string, number>();
  const jitterOf = (recipeId: string): number => {
    let jitter = jitters.get(recipeId);
    if (jitter === undefined) {
      jitter = seededJitter(recipeId, seed);
      jitters.set(recipeId, jitter);
    }
    return jitter;
  };
  // What stays in the plan is in it from the start, whichever day it is on.
  input.days.forEach((spec, day) => {
    for (const meal of spec.kept ?? []) if (meal.recipeId !== undefined) place(day, meal.recipeId, meal.servings ?? 1);
  });
  // Without a limit of the caller's a recipe may fill a week.
  const limits = {
    consecutive: input.maxConsecutiveDaysSameMeal ?? 7,
    perWeek: input.maxTimesPerWeekSameMeal ?? 7,
    perPlan: input.maxRepeatsPerRecipe,
    twiceADay: input.mealPrepFriendly,
    perIngredient: input.maxIngredientPerWeek,
  };

  const disliked = input.dislikedIngredientIds;
  const holdsDisliked = (recipe: OptimizerRecipe): boolean => disliked !== undefined && disliked.size > 0 && recipe.ingredientIds.some((id) => disliked.has(id));

  // The recipes of a meal are looked up once, however many days ask for them.
  const eligibleBySlot = new Map<MealType, OptimizerRecipe[]>();
  const eligibleFor = (slot: MealType): OptimizerRecipe[] => {
    let found = eligibleBySlot.get(slot);
    if (!found) {
      found = input.recipes.filter((r) => eligible(r, slot, input.dietType));
      eligibleBySlot.set(slot, found);
    }
    return found;
  };

  // The days the run fills: a pack that a meal opens can be used on those that come after the meal's own.
  const filled = input.days.map((spec) => !spec.skip && spec.mealSlots.length > 0);

  for (let day = 0; day < input.days.length; day++) {
    const spec = input.days[day]!;
    if (spec.skip) continue;
    const daysToCome = filled.slice(day + 1).filter(Boolean).length;

    const coverage = spec.inventoryCoverage ?? input.inventoryCoverage;
    const lockedBySlot = new Map((spec.lockedSlots ?? []).map((l) => [l.slot, l.recipeId] as const));
    // Locked meals first, so that the rest of the day is planned around them;
    // the snack last, so that it takes what the day has left.
    const open = spec.mealSlots.filter((slot) => !lockedBySlot.has(slot));
    const order = [
      ...spec.mealSlots.filter((slot) => lockedBySlot.has(slot)),
      ...open.filter((slot) => slot !== 'snack'),
      ...open.filter((slot) => slot === 'snack'),
    ];

    let left = spec.dailyCalorieTarget - (spec.kept ?? []).reduce((sum, meal) => sum + meal.calories, 0);
    // What the day holds so far of protein, fat and carbohydrate, in grams.
    const dayMacros: Macros = { protein: 0, fat: 0, carbs: 0 };
    const hold = (macros: Macros, servings: number): void => {
      dayMacros.protein += macros.protein * servings;
      dayMacros.fat += macros.fat * servings;
      dayMacros.carbs += macros.carbs * servings;
    };
    for (const meal of spec.kept ?? []) if (meal.macros) hold(meal.macros, 1);
    for (const [index, slot] of order.entries()) {
      // What is left of the day, shared among the meals still to come by their weights.
      const toCome = order.slice(index);
      const budget = Math.max(0, left) * (SLOT_WEIGHT[slot] / toCome.reduce((sum, other) => sum + SLOT_WEIGHT[other], 0));

      let recipe: OptimizerRecipe;
      const lockedId = lockedBySlot.get(slot);
      if (lockedId !== undefined) {
        const locked = recipeById.get(lockedId);
        if (!locked) throw new OptimizerError(`locked recipe ${lockedId} not in candidate set`);
        recipe = locked;
      } else {
        const candidates = eligibleFor(slot);
        if (candidates.length === 0) {
          throw new OptimizerError(`no eligible recipe for ${slot} (diet ${input.dietType})`, { slot, dietType: input.dietType });
        }
        if (candidates.length === 1) report.singleCandidate.push({ dayIndex: day, slot });
        const pool = withinLimits(candidates, { day, budget, usesOf, useCount, held, limits, cookTimeBudget: spec.cookTimeBudgetMinutes, mayGiveWay });
        // Of the recipes the limits leave, those the day is to do without
        // come after every other.
        const others = spec.avoid ? pool.recipes.filter((r) => !spec.avoid!.has(r.id)) : pool.recipes;
        const offered = others.length > 0 ? others : pool.recipes;
        // Of those, the ones that hold nothing the user would rather not eat
        // come before any that does, however well the others score.
        const welcome = offered.filter((r) => !holdsDisliked(r));
        const liked = welcome.length > 0 ? welcome : offered;
        // Of those, one that stays far under the budget even at the largest
        // serving is left out, unless nothing else is there.
        const reaching = liked.filter((r) => r.caloriesPerServing * SERVING_MAX >= MIN_REACH * budget);
        recipe = pickBest(reaching.length > 0 ? reaching : liked, {
          budget,
          day,
          planIngredients,
          usesOf,
          packs: input.perishablePacks,
          daysToCome,
          heldOf,
          dayMacros,
          macroSplit: input.macroSplit,
          weights,
          mealPrepFriendly: input.mealPrepFriendly,
          favoriteIngredientIds: input.favoriteIngredientIds,
          preferredCuisines: input.preferredCuisines,
          inventoryCoverage: coverage,
          jitterOf,
        });
        const gaveWay = pool.outside(recipe);
        if (gaveWay.length > 0) report.relaxations.push({ dayIndex: day, slot, gaveWay: [...gaveWay] });
      }

      const servings = fitServings(recipe.caloriesPerServing, budget);
      assignments.push({ dayIndex: day, slot, recipeId: recipe.id, servings });
      left -= recipe.caloriesPerServing * servings;
      hold({ protein: recipe.proteinPerServing, fat: recipe.fatPerServing, carbs: recipe.carbsPerServing }, servings);
      place(day, recipe.id, servings);
    }
  }

  // In the order of the day's meals, whatever order they were filled in.
  const position = (a: OptimizerAssignment) => input.days[a.dayIndex]!.mealSlots.indexOf(a.slot);
  assignments.sort((a, b) => a.dayIndex - b.dayIndex || position(a) - position(b));
  return { assignments, report, uses };
}

/** The limits a recipe would break if it were placed at this meal. */
function broken(
  recipe: OptimizerRecipe,
  at: {
    day: number;
    /** What the meal has to spend: it decides the servings, and with them how much of each ingredient the meal holds. */
    budget: number;
    /** The meals of the plan so far that hold a recipe. */
    usesOf: (recipeId: string) => readonly Use[];
    useCount: ReadonlyMap<string, number>;
    /** The most the meals of any seven days that hold this one hold of an ingredient, in its own unit. */
    mostHeldInSevenDays: (ingredientId: string) => number;
    limits: { consecutive: number; perWeek: number; perPlan?: number; twiceADay: boolean; perIngredient?: number };
    cookTimeBudget?: number;
  },
): readonly Relaxation[] {
  const { day, limits } = at;
  const mine = at.usesOf(recipe.id);
  let out = WITHIN_EVERY_LIMIT;
  if (limits.perPlan !== undefined && (at.useCount.get(recipe.id) ?? 0) >= limits.perPlan) out = outside(out, 'variety_floor');
  if (at.cookTimeBudget != null && recipe.totalMinutes > at.cookTimeBudget) out = outside(out, 'cook_time');
  // With this meal the recipe is on one day in a row and once in seven days, and on more where the plan holds it already.
  let streak = 1;
  let mostInSevenDays = 1;
  if (mine.length > 0) {
    const on = (d: number): boolean => mine.some((use) => use.day === d);
    if (!limits.twiceADay && on(day)) out = outside(out, 'same_day');
    // The days in a row around this one, before it and after, on each of which the recipe is eaten at some meal.
    for (let d = day - 1; on(d); d--) streak += 1;
    for (let d = day + 1; on(d); d++) streak += 1;
    // Every seven days that hold this one, over all meals.
    for (let first = day - 6; first <= day; first += 1) {
      let times = 1;
      for (const use of mine) if (use.day >= first && use.day <= first + 6) times += 1;
      mostInSevenDays = Math.max(mostInSevenDays, times);
    }
  }
  if (streak > limits.consecutive) out = outside(out, 'consecutive_days');
  if (mostInSevenDays > limits.perWeek) out = outside(out, 'weekly_cap');
  // The same seven days, for each ingredient of the recipe: what the meals in them hold of it, and this meal on top.
  const { perIngredient } = limits;
  if (perIngredient !== undefined && recipe.amounts) {
    const servings = fitServings(recipe.caloriesPerServing, at.budget);
    let over = false;
    for (const [ingredientId, perServing] of recipe.amounts) {
      // Over in some seven days is over in the seven days that hold the most.
      over = at.mostHeldInSevenDays(ingredientId) + perServing * servings > perIngredient;
      if (over) break;
    }
    if (over) out = outside(out, 'ingredient_cap');
  }
  return out;
}

/** What a recipe inside every limit breaks: the same list for all of them, which nobody adds to. */
const WITHIN_EVERY_LIMIT: readonly Relaxation[] = [];

/** `broken` with one more limit: a list of its own from the first on. */
function outside(broken: readonly Relaxation[], kind: Relaxation): readonly Relaxation[] {
  return broken === WITHIN_EVERY_LIMIT ? [kind] : [...broken, kind];
}

/**
 * The recipes that may fill a meal: those inside every limit, or, when there
 * are none, those that are outside the least. Limits are weighed in the fixed
 * order: a recipe outside a later limit is worse than one outside any number
 * of earlier ones, and of two that differ only in earlier limits the one
 * outside fewer is better. Limits that may give way do so before any that may
 * not. Of the recipes that are equally far outside, only the least used so
 * far. `outside` says which limits a recipe is outside.
 */
function withinLimits(
  candidates: OptimizerRecipe[],
  where: Omit<Parameters<typeof broken>[1], 'mostHeldInSevenDays'> & { held: ReadonlyMap<string, readonly Held[]>; mayGiveWay: (kind: Relaxation) => boolean },
): { recipes: OptimizerRecipe[]; outside: (recipe: OptimizerRecipe) => readonly Relaxation[] } {
  // The plan does not change while a meal is chosen: what it holds of an ingredient around the day is worked
  // out once for all the recipes that take the ingredient, and what a recipe breaks is the same asked twice.
  const most = new Map<string, number>();
  const mostHeldInSevenDays = (ingredientId: string): number => {
    let found = most.get(ingredientId);
    if (found === undefined) {
      const entries = where.held.get(ingredientId) ?? NOTHING_HELD;
      found = 0;
      for (let first = where.day - 6; first <= where.day; first += 1) {
        let inThem = 0;
        for (const entry of entries) if (entry.day >= first && entry.day <= first + 6) inThem += entry.amount;
        found = Math.max(found, inThem);
      }
      most.set(ingredientId, found);
    }
    return found;
  };
  const at = { ...where, mostHeldInSevenDays };
  // What each candidate breaks, in the order of the candidates.
  const breaks = candidates.map((recipe) => broken(recipe, at));
  const brokenBy = (recipe: OptimizerRecipe): readonly Relaxation[] => broken(recipe, at);
  const inside = candidates.filter((_, index) => breaks[index]!.length === 0);
  if (inside.length > 0) return { recipes: inside, outside: brokenBy };

  const some = candidates.map((recipe, index) => ({ recipe, breaks: breaks[index]! }));
  const permitted = some.filter((candidate) => candidate.breaks.every(at.mayGiveWay));
  const pool = permitted.length > 0 ? permitted : some;
  // One bit for each limit, the later the limit the higher the bit: the smaller number is the less far outside.
  const weight = (candidate: (typeof some)[number]): number => candidate.breaks.reduce((bits, kind) => bits | (1 << RELAXATION_ORDER.indexOf(kind)), 0);
  const least = Math.min(...pool.map(weight));
  return { recipes: leastUsed(pool.filter((candidate) => weight(candidate) === least).map((candidate) => candidate.recipe), at.useCount), outside: brokenBy };
}

function leastUsed(recipes: OptimizerRecipe[], useCount: ReadonlyMap<string, number>): OptimizerRecipe[] {
  const fewest = Math.min(...recipes.map((recipe) => useCount.get(recipe.id) ?? 0));
  return recipes.filter((recipe) => (useCount.get(recipe.id) ?? 0) === fewest);
}

interface PickContext {
  budget: number;
  day: number;
  planIngredients: Set<string>;
  /** The meals of the plan so far that hold a recipe: those that stay and those already placed. */
  usesOf: (recipeId: string) => readonly Use[];
  /** The pack of each ingredient whose opened pack does not keep, what the plan holds of an ingredient so far, and the days still to be filled after this one. */
  packs?: ReadonlyMap<string, number>;
  heldOf?: (ingredientId: string) => number;
  daysToCome?: number;
  /** What the meals of the day hold so far, in grams. */
  dayMacros: Macros;
  macroSplit?: Macros;
  weights: ScoreWeights;
  mealPrepFriendly: boolean;
  favoriteIngredientIds?: ReadonlySet<string>;
  preferredCuisines?: ReadonlySet<string>;
  inventoryCoverage?: ReadonlyMap<string, number>;
  /** What the draw of the run adds to a recipe's score, so that another draw gives another plan. */
  jitterOf: (recipeId: string) => number;
}

function pickBest(candidates: OptimizerRecipe[], ctx: PickContext): OptimizerRecipe {
  let best: OptimizerRecipe | null = null;
  let bestScore = -Infinity;
  for (const recipe of candidates) {
    // Seed jitter lets "regenerate" explore alternative near-optimal plans
    // without breaking determinism for a fixed seed.
    const score = scoreRecipe(recipe, ctx) + ctx.jitterOf(recipe.id);
    if (score > bestScore || (score === bestScore && best !== null && recipe.id < best.id)) {
      best = recipe;
      bestScore = score;
    }
  }
  return best!;
}

/** Deterministic pseudo-random offset in [0, 0.12) from (recipeId, seed), all in 32-bit integers. */
export function seededJitter(recipeId: string, seed: number): number {
  let h = (seed | 0) ^ 0x9e3779b9;
  for (let i = 0; i < recipeId.length; i++) h = Math.imul(h ^ recipeId.charCodeAt(i), 0x01000193);
  // The finishing steps of a 32-bit mix: every bit of the seed and of the id reaches every bit of the result.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return ((h >>> 0) / 0x1_0000_0000) * 0.12;
}

/**
 * How well a meal of `calories` fits its budget, from 1 (inside the window:
 * no cost at all) down to 0 (as far off as the budget is large).
 */
export function calorieFit(calories: number, budget: number): number {
  if (budget <= 0) return 0;
  const off = Math.abs(calories - budget) / budget;
  return 1 - Math.min(1, Math.max(0, off - CALORIE_WINDOW) / (1 - CALORIE_WINDOW));
}

/** Multi-factor score in [0, 1]. */
function scoreRecipe(recipe: OptimizerRecipe, ctx: PickContext): number {
  const servings = fitServings(recipe.caloriesPerServing, ctx.budget);
  const fit = calorieFit(recipe.caloriesPerServing * servings, ctx.budget);

  // A recipe that's already been picked contributes nothing new to the
  // shopping list, so its reuse score should not reward re-picking it. Without
  // this, the first pick at a slot dominates the whole plan because all its
  // ingredients are in `planIngredients` thanks to itself → reuse = 1.0.
  const mine = ctx.usesOf(recipe.id);
  let reuse = 0;
  if (recipe.ingredientIds.length > 0 && mine.length === 0) {
    let inThePlan = 0;
    for (const id of recipe.ingredientIds) if (ctx.planIngredients.has(id)) inThePlan += 1;
    reuse = inThePlan / recipe.ingredientIds.length;
  }

  // A recipe eaten on a day near this one is discouraged, the more the nearer,
  // whether that day is before or after; the limits above are what forbids.
  let variety = 1;
  if (mine.length > 0) {
    let nearest = Infinity;
    for (const use of mine) nearest = Math.min(nearest, Math.abs(ctx.day - use.day));
    variety = 1 - 1 / (nearest + 1);
  }

  const favorite = recipe.isFavorite ? 1 : 0;
  const often = recipe.eatenOften ? 1 : 0;

  const favIngs = ctx.favoriteIngredientIds;
  const favoriteIngredient =
    !favIngs || favIngs.size === 0 || recipe.ingredientIds.length === 0
      ? 0
      : recipe.ingredientIds.filter((id) => favIngs.has(id)).length / recipe.ingredientIds.length;

  const preferredCuisine = recipe.cuisine != null && ctx.preferredCuisines?.has(recipe.cuisine) ? 1 : 0;

  const complexityPenalty =
    ctx.mealPrepFriendly && recipe.difficulty === 'hard' ? 1 : recipe.difficulty === 'hard' ? 0.4 : 0;

  // Pantry coverage. Pre-computed by the caller; omitted/empty map → 0.
  const inventoryCoverage = ctx.inventoryCoverage?.get(recipe.id) ?? 0;

  // What the meal would do to the packs of the plan as it stands: nothing,
  // when none of what it takes comes in a pack that does not keep.
  let packs = 0;
  if (ctx.packs && ctx.packs.size > 0 && ctx.heldOf && recipe.amounts) {
    let takesFromAPack = false;
    for (const ingredientId of recipe.amounts.keys()) {
      if (ctx.packs.has(ingredientId)) {
        takesFromAPack = true;
        break;
      }
    }
    if (takesFromAPack) packs = packPull(recipe.amounts, ctx.heldOf, ctx.packs, ctx.daysToCome ?? 0, servings);
  }

  // Cooking ahead: a recipe is cooked for two days, and then another. The day
  // after it was cooked speaks for it; the day after that speaks for nothing.
  let daysRunning = 0;
  while (mine.some((use) => use.day === ctx.day - 1 - daysRunning)) daysRunning += 1;
  const cookOnce = ctx.mealPrepFriendly && daysRunning % 2 === 1 && !mine.some((use) => use.day === ctx.day) ? 1 : 0;

  const { weights } = ctx;
  return (
    weights.calorieFit * fit +
    weights.macroFit * macroFit(recipe, servings, ctx) +
    weights.reuse * reuse +
    weights.variety * variety +
    weights.favorite * favorite +
    weights.often * often +
    weights.favoriteIngredient * favoriteIngredient +
    weights.cuisine * preferredCuisine +
    weights.inventoryCoverage * inventoryCoverage +
    weights.packs * packs +
    weights.cookOnce * cookOnce -
    weights.complexity * complexityPenalty
  );
}

/**
 * How near the day would be to the split it aims at with this meal on it,
 * from 1 (on it) down to 0 (`MACRO_REACH` away or further). It looks at the
 * day so far and the meal together, so a meal can make up for the ones before
 * it. Nothing where the plan aims at no split.
 */
function macroFit(recipe: OptimizerRecipe, servings: number, ctx: Pick<PickContext, 'dayMacros' | 'macroSplit'>): number {
  if (!ctx.macroSplit) return 0;
  const shares = energyShares({
    protein: ctx.dayMacros.protein + recipe.proteinPerServing * servings,
    fat: ctx.dayMacros.fat + recipe.fatPerServing * servings,
    carbs: ctx.dayMacros.carbs + recipe.carbsPerServing * servings,
  });
  return shares ? 1 - Math.min(1, splitDistance(shares, ctx.macroSplit) / MACRO_REACH) : 0;
}

/**
 * What one serving of a recipe needs of each ingredient, in the ingredient's
 * canonical unit. A plan places about one serving of a recipe, so this, not
 * the whole recipe, is what the pantry is compared with: 150 g of chicken at
 * home cover a serving of a two-serving recipe that takes 300 g in all. A
 * line that cannot be converted is left out, and so counts as not covered.
 */
export function requirementsPerServing(recipe: {
  servings: number;
  ingredients: readonly { ingredientId: string; quantity: number; unit: Unit; ingredient: ConvertibleIngredient }[];
}): { ingredientId: string; canonicalQuantity: number }[] {
  const servings = Math.max(1, recipe.servings);
  const needs: { ingredientId: string; canonicalQuantity: number }[] = [];
  for (const line of recipe.ingredients) {
    try {
      const canonical = toCanonical(line.quantity, line.unit, line.ingredient) / servings;
      if (canonical > 0) needs.push({ ingredientId: line.ingredientId, canonicalQuantity: canonical });
    } catch (err) {
      if (!(err instanceof UnitConversionError)) throw err;
    }
  }
  return needs;
}

/** What one serving of a recipe takes of each ingredient, in the ingredient's own unit: `requirementsPerServing`, with an ingredient that is on two lines added up. */
export function amountsPerServing(requirements: readonly { ingredientId: string; canonicalQuantity: number }[]): Map<string, number> {
  const amounts = new Map<string, number>();
  for (const line of requirements) amounts.set(line.ingredientId, (amounts.get(line.ingredientId) ?? 0) + line.canonicalQuantity);
  return amounts;
}

/**
 * Per-recipe coverage. Given the recipe's required mass per ingredient
 * (in any unit the caller normalises to a single comparable scalar — usually
 * the ingredient's canonical unit) and the pantry's available mass for each
 * ingredient, returns the share of the recipe's required mass already on
 * hand, clamped to [0, 1]. Recipes with no requirements (defensive) → 0.
 */
export function recipeCoverage(
  requirements: ReadonlyArray<{ ingredientId: string; canonicalQuantity: number }>,
  pantryStock: ReadonlyMap<string, number>,
): number {
  if (requirements.length === 0) return 0;
  let required = 0;
  let covered = 0;
  for (const req of requirements) {
    if (req.canonicalQuantity <= 0) continue;
    required += req.canonicalQuantity;
    const available = pantryStock.get(req.ingredientId) ?? 0;
    covered += Math.min(req.canonicalQuantity, available);
  }
  if (required === 0) return 0;
  return Math.min(1, covered / required);
}

/**
 * The share of the plan's ingredients that more than one of its recipes uses.
 * A recipe that is eaten on several days is one recipe: eating it again buys
 * the same things again, which is no reuse.
 */
export function reuseScore(
  assignments: readonly { recipeId: string }[],
  recipes: OptimizerRecipe[],
): number {
  const byId = new Map(recipes.map((r) => [r.id, r]));
  const counts = new Map<string, number>();
  for (const recipeId of new Set(assignments.map((a) => a.recipeId))) {
    for (const ing of byId.get(recipeId)?.ingredientIds ?? []) {
      counts.set(ing, (counts.get(ing) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return 0;
  const reused = [...counts.values()].filter((c) => c > 1).length;
  return reused / counts.size;
}
