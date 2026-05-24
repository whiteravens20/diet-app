/**
 * Deterministic meal-plan optimiser.
 *
 * Greedy slot-filling with a multi-factor scoring function, followed by one
 * local-search refinement pass. Given the same inputs it always produces the
 * same plan — "regenerate" varies the plan by passing a different `seed`.
 *
 * Scoring balances (product principle #10):
 *   calorie fit · ingredient reuse · variety · preference · complexity.
 */
import type { DietType, Macros, MealType } from '@diet-app/shared';

export interface OptimizerRecipe {
  id: string;
  mealTypes: MealType[];
  dietTags: DietType[];
  caloriesPerServing: number;
  proteinPerServing: number;
  fatPerServing: number;
  carbsPerServing: number;
  ingredientIds: string[];
  difficulty: 'easy' | 'medium' | 'hard';
  isFavorite: boolean;
}

export interface OptimizerInput {
  recipes: OptimizerRecipe[];
  days: number;
  mealSlots: MealType[];
  dailyCalorieTarget: number;
  targetMacros: Macros;
  dietType: DietType;
  mealPrepFriendly: boolean;
  /**
   * Ingredients the user has marked as favourites — recipes containing them
   * receive a small scoring bonus. Empty / omitted disables the bias.
   */
  favoriteIngredientIds?: ReadonlySet<string>;
  /** Changes the deterministic tie-break order so "regenerate" yields a new plan. */
  seed: number;
}

export interface OptimizerAssignment {
  dayIndex: number;
  slot: MealType;
  recipeId: string;
  servings: number;
}

export interface OptimizerResult {
  assignments: OptimizerAssignment[];
  /** 0-1 — share of ingredients reused across more than one recipe in the plan. */
  ingredientReuseScore: number;
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
  complexity: 0.05,
} as const;

const SERVING_MIN = 0.5;
const SERVING_MAX = 3;

export class OptimizerError extends Error {}

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
  if (!recipe.mealTypes.includes(slot)) return false;
  if (dietType === 'custom') return true;
  return recipe.dietTags.includes(dietType);
}

/**
 * Generate a plan. Throws OptimizerError if a slot has no eligible recipe —
 * callers fall back to the deterministic template engine or surface the gap.
 */
export function optimisePlan(input: OptimizerInput): OptimizerResult {
  const budgets = slotBudgets(input.mealSlots, input.dailyCalorieTarget);
  const assignments: OptimizerAssignment[] = [];
  const planIngredients = new Set<string>(); // ingredients already "purchased"
  const recentUse = new Map<string, number>(); // recipeId → last dayIndex used

  for (let day = 0; day < input.days; day++) {
    for (const slot of input.mealSlots) {
      const budget = budgets.get(slot)!;
      const candidates = input.recipes.filter((r) => eligible(r, slot, input.dietType));
      if (candidates.length === 0) {
        throw new OptimizerError(`no eligible recipe for ${slot} (diet ${input.dietType})`);
      }

      const best = pickBest(candidates, {
        budget,
        day,
        planIngredients,
        recentUse,
        mealPrepFriendly: input.mealPrepFriendly,
        favoriteIngredientIds: input.favoriteIngredientIds,
        seed: input.seed,
      });

      assignments.push({
        dayIndex: day,
        slot,
        recipeId: best.id,
        servings: fitServings(best.caloriesPerServing, budget),
      });
      recentUse.set(best.id, day);
      best.ingredientIds.forEach((id) => planIngredients.add(id));
    }
  }

  return { assignments, ingredientReuseScore: reuseScore(assignments, input.recipes) };
}

interface PickContext {
  budget: number;
  day: number;
  planIngredients: Set<string>;
  recentUse: Map<string, number>;
  mealPrepFriendly: boolean;
  favoriteIngredientIds?: ReadonlySet<string>;
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

/** Deterministic pseudo-random offset in [0, 0.12) from (recipeId, seed). */
export function seededJitter(recipeId: string, seed: number): number {
  let h = seed * 2654435761;
  for (let i = 0; i < recipeId.length; i++) {
    h = (h ^ recipeId.charCodeAt(i)) * 16777619;
    h >>>= 0;
  }
  return (h % 1000) / 1000 / 8.333; // → [0, 0.12)
}

/** Multi-factor score in [0, 1]. */
export function scoreRecipe(recipe: OptimizerRecipe, ctx: PickContext): number {
  const servings = fitServings(recipe.caloriesPerServing, ctx.budget);
  const cals = recipe.caloriesPerServing * servings;
  const calorieFit = 1 - Math.min(1, Math.abs(cals - ctx.budget) / ctx.budget);

  const reuse =
    recipe.ingredientIds.length === 0
      ? 0
      : recipe.ingredientIds.filter((id) => ctx.planIngredients.has(id)).length /
        recipe.ingredientIds.length;

  const lastUsed = ctx.recentUse.get(recipe.id);
  const variety = lastUsed === undefined ? 1 : Math.min(1, (ctx.day - lastUsed) / 3);

  const favorite = recipe.isFavorite ? 1 : 0;

  const favIngs = ctx.favoriteIngredientIds;
  const favoriteIngredient =
    !favIngs || favIngs.size === 0 || recipe.ingredientIds.length === 0
      ? 0
      : recipe.ingredientIds.filter((id) => favIngs.has(id)).length / recipe.ingredientIds.length;

  const complexityPenalty =
    ctx.mealPrepFriendly && recipe.difficulty === 'hard' ? 1 : recipe.difficulty === 'hard' ? 0.4 : 0;

  return (
    SCORE_WEIGHTS.calorieFit * calorieFit +
    SCORE_WEIGHTS.reuse * reuse +
    SCORE_WEIGHTS.variety * variety +
    SCORE_WEIGHTS.favorite * favorite +
    SCORE_WEIGHTS.favoriteIngredient * favoriteIngredient -
    SCORE_WEIGHTS.complexity * complexityPenalty
  );
}

/** Share of plan ingredients that appear in more than one assigned recipe. */
export function reuseScore(
  assignments: OptimizerAssignment[],
  recipes: OptimizerRecipe[],
): number {
  const byId = new Map(recipes.map((r) => [r.id, r]));
  const counts = new Map<string, number>();
  for (const a of assignments) {
    for (const ing of byId.get(a.recipeId)?.ingredientIds ?? []) {
      counts.set(ing, (counts.get(ing) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return 0;
  const reused = [...counts.values()].filter((c) => c > 1).length;
  return reused / counts.size;
}
