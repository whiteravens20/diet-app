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
import { fitsDiet, type DietType, type Macros, type MealType, type Unit } from '@diet-app/shared';
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
  difficulty: 'easy' | 'medium' | 'hard';
  isFavorite: boolean;
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
}

export interface OptimizerInput {
  recipes: OptimizerRecipe[];
  /** One descriptor per day (length = plan duration). See {@link OptimizerDay}. */
  days: OptimizerDay[];
  targetMacros: Macros;
  dietType: DietType;
  mealPrepFriendly: boolean;
  /**
   * Ingredients the user has marked as favourites — recipes containing them
   * receive a small scoring bonus. Empty / omitted disables the bias.
   */
  favoriteIngredientIds?: ReadonlySet<string>;
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
   * The limits that may give way when no recipe is left for a meal inside
   * them. `all` (the default) lets any of them; an empty set lets none, and
   * the plan is refused instead, with what stood in the way.
   */
  allowRelaxations?: ReadonlySet<Relaxation> | 'all';
  /** Changes the deterministic tie-break order so "regenerate" yields a new plan. */
  seed: number;
}

/**
 * A limit that can give way, in the order in which they do: the most a recipe
 * appears in the plan first, then the day's cooking time, then a recipe twice
 * on one day, then days in a row, and the limit for seven days last.
 */
export const RELAXATION_ORDER = ['variety_floor', 'cook_time', 'same_day', 'consecutive_days', 'weekly_cap'] as const;
export type Relaxation = (typeof RELAXATION_ORDER)[number];

/** What a run had to do to fill the plan, for whoever made it to read. */
export interface OptimizerReport {
  /** Meals for which a limit gave way, and which. */
  relaxations: { dayIndex: number; slot: MealType; gaveWay: Relaxation[] }[];
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

export interface OptimizerAssignment {
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

const SCORE_WEIGHTS = {
  calorieFit: 0.45,
  reuse: 0.25,
  variety: 0.15,
  favorite: 0.1,
  favoriteIngredient: 0.08,
  // Weighted equal to favorite (0.10) so a 100%-covered recipe and a
  // favourited recipe weigh comparably. Lower would let day-to-day variety
  // overrule the pantry; higher would risk monotony before the anti-monotony
  // reset triggers.
  inventoryCoverage: 0.1,
  complexity: 0.05,
} as const;

export const SERVING_MIN = 0.5;
export const SERVING_MAX = 3;

export class OptimizerError extends Error {
  constructor(
    message: string,
    /** The meal no recipe could fill and the diet it was wanted for, when that is what went wrong. */
    readonly gap?: { slot: MealType; dietType: DietType },
    /** The meal that could only be filled by letting limits give way that may not, and which. */
    readonly blocked?: { dayIndex: number; slot: MealType; needs: Relaxation[] },
  ) {
    super(message);
  }
}

/** A meal inside this share of its budget, either way, costs nothing. */
export const CALORIE_WINDOW = 0.1;
/** A recipe that cannot reach this share of a meal's budget at the largest serving is no candidate for it. */
const MIN_REACH = 0.7;

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

/**
 * Generate a plan. Throws `OptimizerError` when a meal has no recipe for the
 * diet at all (`gap`), or only by letting a limit give way that may not
 * (`blocked`).
 */
export function optimisePlan(input: OptimizerInput): OptimizerResult {
  const recipeById = new Map(input.recipes.map((r) => [r.id, r]));
  const assignments: OptimizerAssignment[] = [];
  const report: OptimizerReport = { relaxations: [], singleCandidate: [] };
  const planIngredients = new Set<string>(); // ingredients already "purchased"
  const recentUse = new Map<string, number>(); // recipeId → last dayIndex used
  const uses: Use[] = [];
  const useCount = new Map<string, number>();
  // Without a limit of the caller's a recipe may fill a week.
  const limits = {
    consecutive: input.maxConsecutiveDaysSameMeal ?? 7,
    perWeek: input.maxTimesPerWeekSameMeal ?? 7,
    perPlan: input.maxRepeatsPerRecipe,
    twiceADay: input.mealPrepFriendly,
  };
  const mayGiveWay = (kind: Relaxation): boolean => {
    const allowed = input.allowRelaxations ?? 'all';
    return allowed === 'all' || allowed.has(kind);
  };

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

  for (let day = 0; day < input.days.length; day++) {
    const spec = input.days[day]!;
    if (spec.skip) continue;

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

    let left = spec.dailyCalorieTarget;
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
        // A recipe that stays far under the budget even at the largest serving
        // is left out, unless nothing else is there.
        const reaching = candidates.filter((r) => r.caloriesPerServing * SERVING_MAX >= MIN_REACH * budget);
        const pool = withinLimits(reaching.length > 0 ? reaching : candidates, { day, slot, uses, useCount, limits, cookTimeBudget: spec.cookTimeBudgetMinutes, mayGiveWay });
        if (pool.gaveWay.length > 0) report.relaxations.push({ dayIndex: day, slot, gaveWay: pool.gaveWay });
        recipe = pickBest(pool.recipes, {
          budget,
          day,
          planIngredients,
          recentUse,
          mealPrepFriendly: input.mealPrepFriendly,
          favoriteIngredientIds: input.favoriteIngredientIds,
          inventoryCoverage: coverage,
          seed: input.seed,
        });
      }

      const servings = fitServings(recipe.caloriesPerServing, budget);
      assignments.push({ dayIndex: day, slot, recipeId: recipe.id, servings });
      left -= recipe.caloriesPerServing * servings;
      uses.push({ day, recipeId: recipe.id });
      useCount.set(recipe.id, (useCount.get(recipe.id) ?? 0) + 1);
      recentUse.set(recipe.id, day);
      recipe.ingredientIds.forEach((id) => planIngredients.add(id));
    }
  }

  // In the order of the day's meals, whatever order they were filled in.
  const position = (a: OptimizerAssignment) => input.days[a.dayIndex]!.mealSlots.indexOf(a.slot);
  assignments.sort((a, b) => a.dayIndex - b.dayIndex || position(a) - position(b));
  return { assignments, ingredientReuseScore: reuseScore(assignments, input.recipes), report };
}

/** The limits a recipe would break if it were placed at this meal. */
function broken(
  recipe: OptimizerRecipe,
  at: { day: number; uses: readonly Use[]; useCount: ReadonlyMap<string, number>; limits: { consecutive: number; perWeek: number; perPlan?: number; twiceADay: boolean }; cookTimeBudget?: number },
): Relaxation[] {
  const { day, uses, limits } = at;
  const mine = uses.filter((use) => use.recipeId === recipe.id);
  const out: Relaxation[] = [];
  if (limits.perPlan !== undefined && (at.useCount.get(recipe.id) ?? 0) >= limits.perPlan) out.push('variety_floor');
  if (at.cookTimeBudget != null && recipe.totalMinutes > at.cookTimeBudget) out.push('cook_time');
  if (!limits.twiceADay && mine.some((use) => use.day === day)) out.push('same_day');
  // The days in a row that end yesterday, on each of which the recipe was eaten at some meal.
  let streak = 0;
  for (let d = day - 1; d >= 0 && mine.some((use) => use.day === d); d--) streak += 1;
  if (streak + 1 > limits.consecutive) out.push('consecutive_days');
  // Seven days that end today, over all meals.
  if (mine.filter((use) => use.day >= day - 6).length + 1 > limits.perWeek) out.push('weekly_cap');
  return out;
}

/**
 * The recipes that may fill a meal: those inside every limit, or, when there
 * are none, those that are inside once the fewest limits have given way, in
 * the fixed order. Of recipes let in that way, only the least used so far.
 */
function withinLimits(
  candidates: OptimizerRecipe[],
  at: Parameters<typeof broken>[1] & { slot: MealType; mayGiveWay: (kind: Relaxation) => boolean },
): { recipes: OptimizerRecipe[]; gaveWay: Relaxation[] } {
  const breaks = new Map(candidates.map((recipe) => [recipe.id, broken(recipe, at)]));
  const inside = candidates.filter((recipe) => breaks.get(recipe.id)!.length === 0);
  if (inside.length > 0) return { recipes: inside, gaveWay: [] };

  for (let step = 1; step <= RELAXATION_ORDER.length; step += 1) {
    const given = RELAXATION_ORDER.slice(0, step);
    const let_in = candidates.filter((recipe) => breaks.get(recipe.id)!.every((kind) => given.includes(kind)));
    if (let_in.length === 0) continue;
    const fewest = Math.min(...let_in.map((recipe) => at.useCount.get(recipe.id) ?? 0));
    const recipes = let_in.filter((recipe) => (at.useCount.get(recipe.id) ?? 0) === fewest);
    const gaveWay = RELAXATION_ORDER.filter((kind) => recipes.some((recipe) => breaks.get(recipe.id)!.includes(kind)));
    const refused = gaveWay.filter((kind) => !at.mayGiveWay(kind));
    if (refused.length > 0) {
      throw new OptimizerError(`no recipe for ${at.slot} on day ${at.day + 1} inside the limits`, undefined, { dayIndex: at.day, slot: at.slot, needs: gaveWay });
    }
    return { recipes, gaveWay };
  }
  // Unreachable: with every limit given way, every candidate is let in.
  return { recipes: candidates, gaveWay: [...RELAXATION_ORDER] };
}

interface PickContext {
  budget: number;
  day: number;
  planIngredients: Set<string>;
  recentUse: Map<string, number>;
  mealPrepFriendly: boolean;
  favoriteIngredientIds?: ReadonlySet<string>;
  inventoryCoverage?: ReadonlyMap<string, number>;
  seed: number;
}

function pickBest(candidates: OptimizerRecipe[], ctx: PickContext): OptimizerRecipe {
  let best: OptimizerRecipe | null = null;
  let bestScore = -Infinity;
  for (const recipe of candidates) {
    // Seed jitter lets "regenerate" explore alternative near-optimal plans
    // without breaking determinism for a fixed seed.
    const score = scoreRecipe(recipe, ctx) + seededJitter(recipe.id, ctx.seed);
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
export function scoreRecipe(recipe: OptimizerRecipe, ctx: PickContext): number {
  const servings = fitServings(recipe.caloriesPerServing, ctx.budget);
  const fit = calorieFit(recipe.caloriesPerServing * servings, ctx.budget);

  // A recipe that's already been picked contributes nothing new to the
  // shopping list, so its reuse score should not reward re-picking it. Without
  // this, the first pick at a slot dominates the whole plan because all its
  // ingredients are in `planIngredients` thanks to itself → reuse = 1.0.
  const reuse =
    recipe.ingredientIds.length === 0 || ctx.recentUse.has(recipe.id)
      ? 0
      : recipe.ingredientIds.filter((id) => ctx.planIngredients.has(id)).length /
        recipe.ingredientIds.length;

  // A recipe used recently is discouraged, the more the more recently; the
  // limits above are what forbids.
  const lastUsed = ctx.recentUse.get(recipe.id);
  const variety = lastUsed === undefined ? 1 : 1 - 1 / (ctx.day - lastUsed + 1);

  const favorite = recipe.isFavorite ? 1 : 0;

  const favIngs = ctx.favoriteIngredientIds;
  const favoriteIngredient =
    !favIngs || favIngs.size === 0 || recipe.ingredientIds.length === 0
      ? 0
      : recipe.ingredientIds.filter((id) => favIngs.has(id)).length / recipe.ingredientIds.length;

  const complexityPenalty =
    ctx.mealPrepFriendly && recipe.difficulty === 'hard' ? 1 : recipe.difficulty === 'hard' ? 0.4 : 0;

  // Pantry coverage. Pre-computed by the caller; omitted/empty map → 0.
  const inventoryCoverage = ctx.inventoryCoverage?.get(recipe.id) ?? 0;

  return (
    SCORE_WEIGHTS.calorieFit * fit +
    SCORE_WEIGHTS.reuse * reuse +
    SCORE_WEIGHTS.variety * variety +
    SCORE_WEIGHTS.favorite * favorite +
    SCORE_WEIGHTS.favoriteIngredient * favoriteIngredient +
    SCORE_WEIGHTS.inventoryCoverage * inventoryCoverage -
    SCORE_WEIGHTS.complexity * complexityPenalty
  );
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
  assignments: OptimizerAssignment[],
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
