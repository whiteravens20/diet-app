// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import type { AiSwapMealRequest, AiSwapMealResponse, Locale, MealType, RebalanceResult, SwapMealRequest } from '@diet-app/shared';
import { AiRouterService, withUnusableAnswer } from '../ai/ai-router.service.js';
import { modelText, readModelReply } from '../ai/model-json.js';
import { MEAL_SWAP } from '../ai/operations.js';
import { fitServings, recipeCoverage, requirementsPerServing, slotBudgets } from '../engine/index.js';
import { stockByIngredient } from '../inventory/pantry-store.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertMayEnter, CANDIDATE, pickIndex, poolWhere, restrictionsFor, type Candidate, type Waived } from './eligibility.js';
import { MealPlansService } from './meal-plans.service.js';
import { writePlan } from './plan-write.js';
import { AI_SWAP_POOL, LANGUAGE, MAX_REASON_CHARS, swappableRecipeOf } from './swap-shared.js';

// What the prompt asks the model to answer with. A reason is welcome and
// never required: a pick without one is still a pick.
const RecipePick = z.object({ recipeId: z.string().min(1), reason: z.unknown() });

/**
 * Putting another recipe in the place of a planned meal: one the engine
 * picks, one of the profile's favourites, or one a model picks from what the
 * engine offers it.
 */
@Injectable()
export class MealSwapService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiRouterService,
    private readonly plans: MealPlansService,
  ) {}

  /** Swap a planned meal for a random / favorite alternative; applies immediately. */
  async swapMeal(userId: string, locale: Locale, req: SwapMealRequest): Promise<RebalanceResult> {
    const meal = await this.plans.loadPlannedMeal(userId, req.planId, req.plannedMealId);
    const currentRecipeId = swappableRecipeOf(meal);
    const restrictions = await restrictionsFor(this.prisma, meal.day.plan);

    // History of recipes already shown for THIS slot (across previous swaps),
    // plus the currently displayed recipe. The picker leaves them out so
    // repeated clicks advance through fresh candidates instead of cycling
    // between two.
    const prevHistory = meal.swapHistory ?? [];
    const shown = new Set<string>([currentRecipeId, ...prevHistory]);
    // What the user waived by asking: "show all my favourites" drops the diet
    // for the pools, and for one favourite picked by hand the meal as well.
    // Allergens, skipped ingredients and the avoid mark are never waived.
    const waived: Waived =
      req.strategy === 'favorite'
        ? { diet: req.allowOffDiet, meal: req.allowOffDiet }
        : { diet: req.allowOffDiet };

    let replacement: Candidate & { caloriesPerServing: number };
    // Whether the pick came from recipes not yet shown in this slot.
    let fromFresh = true;

    if (req.strategy === 'favorite') {
      if (!req.favoriteRecipeId) {
        throw new NotFoundException({ error: 'NO_FAVORITE', message: 'favoriteRecipeId required.' });
      }
      const picked = await this.prisma.recipe.findUnique({
        where: { id: req.favoriteRecipeId },
        select: { ...CANDIDATE, caloriesPerServing: true },
      });
      if (!picked) {
        throw new BadRequestException({
          error: 'OFF_DIET_FAVORITE_NOT_ALLOWED',
          message: 'That favourite is not available.',
        });
      }
      replacement = picked;
    } else {
      // One pool for both automatic strategies, in a fixed order.
      const pool = await this.prisma.recipe.findMany({
        where: poolWhere(restrictions, meal.mealType, waived, [currentRecipeId]),
        select: { ...CANDIDATE, caloriesPerServing: true },
        orderBy: { id: 'asc' },
      });
      let ranked = pool;
      if (req.strategy === 'favorite_ingredients') {
        const favIngs = new Set(meal.day.plan.profile.preferences?.favoriteIngredientIds ?? []);
        if (favIngs.size === 0) {
          throw new BadRequestException({
            error: 'NO_FAVORITE_INGREDIENTS',
            message: 'Add favourite ingredients on the profile before swapping by them.',
          });
        }
        const hits = (recipe: Candidate): number => recipe.ingredients.filter((i) => favIngs.has(i.ingredientId)).length;
        const best = Math.max(0, ...pool.map(hits));
        if (best === 0) {
          throw new NotFoundException({
            error: 'NO_FAVORITE_INGREDIENT_MATCH',
            message: 'No recipe in this slot uses any of your favourite ingredients.',
          });
        }
        // Only the recipes that use the most favourite ingredients compete.
        ranked = pool.filter((recipe) => hits(recipe) === best);
      } else if (pool.length === 0) {
        throw new NotFoundException({ error: 'NO_ALTERNATIVE', message: 'No alternative recipe found.' });
      }

      const fresh = ranked.filter((recipe) => !shown.has(recipe.id));
      fromFresh = fresh.length > 0;
      let candidates = fromFresh ? fresh : ranked;
      if (req.strategy === 'random') {
        // Re-rank by pantry coverage descending so an inventory-friendly swap is
        // picked first when the user opted in; the pick below still rotates.
        const coverage = await this.recipeCoverageMap(
          meal.day.plan.profileId,
          candidates.map((c) => c.id),
          req.respectInventory !== false,
        );
        if (coverage) {
          candidates = [...candidates].sort((a, b) => {
            const diff = (coverage.get(b.id) ?? 0) - (coverage.get(a.id) ?? 0);
            return diff !== 0 ? diff : a.id.localeCompare(b.id);
          });
        }
      }
      // The history length advances the key, so consecutive picks vary even
      // when the candidates stay the same.
      replacement = candidates[pickIndex(`${req.plannedMealId}:${prevHistory.length}`, candidates.length)]!;
    }

    // The gate: whatever chose the recipe, it is judged once more before it is written.
    assertMayEnter(
      replacement,
      restrictions,
      meal.mealType,
      req.strategy === 'favorite' ? 'OFF_DIET_FAVORITE_NOT_ALLOWED' : 'RECIPE_NOT_ELIGIBLE',
      waived,
    );
    const replacementId = replacement.id;
    const nextHistory = nextSwapHistory(prevHistory, currentRecipeId, fromFresh);

    // Rescale servings so the swap stays close to the slot's calorie budget.
    // Without this, swapping a 100 kcal/serving recipe for a 200 kcal one
    // would double the meal's calories at the same servings count.
    const daySlots = await this.prisma.plannedMeal.findMany({
      where: { dayId: meal.dayId },
      select: { mealType: true },
    });
    const budgets = slotBudgets(
      daySlots.map((d) => d.mealType as MealType),
      meal.day.calorieTarget,
    );
    const budget = budgets.get(meal.mealType as MealType) ?? meal.day.calorieTarget;
    const servings = fitServings(replacement.caloriesPerServing, budget);

    const summary = await writePlan(this.prisma, req.planId, meal.day.plan.revision, async (tx) => {
      await tx.plannedMeal.update({
        where: { id: req.plannedMealId },
        data: {
          recipeId: replacementId,
          servings,
          swapHistory: nextHistory,
          // A fresh recipe is a new baseline for the rebalancer.
          quantityScale: 1,
        },
      });
      // The swap changed the day total — pull it back toward target.
      return this.plans.rebalanceDayInternal(meal.dayId, tx);
    });
    return this.plans.buildRebalanceResult(userId, locale, req.planId, 'day', summary);
  }

  /**
   * AI-ranked meal swap. The engine builds a deterministic candidate pool
   * (same diet+slot filter as the random strategy) and AI picks one. If AI is
   * unavailable (quota / no provider / total provider failure) OR the model
   * returns an id that isn't in the pool, the engine falls back to the same
   * hash-indexed pick the random strategy uses — so the user always gets a
   * swap. `aiMeta` says which of the two happened: the engine's pick with the
   * reason AI did not decide, or the model's pick with its own reason for it.
   */
  async aiSwapMeal(
    userId: string,
    locale: Locale,
    req: AiSwapMealRequest,
  ): Promise<AiSwapMealResponse> {
    const meal = await this.plans.loadPlannedMeal(userId, req.planId, req.plannedMealId);
    const currentRecipeId = swappableRecipeOf(meal);
    const restrictions = await restrictionsFor(this.prisma, meal.day.plan);
    const prevHistory = meal.swapHistory ?? [];
    const shown = new Set<string>([currentRecipeId, ...prevHistory]);

    // The same pool as the deterministic swap: everything the profile may be
    // given for this meal, in a fixed order. The model is never shown a
    // recipe it must not pick.
    const candidates = await this.prisma.recipe.findMany({
      where: poolWhere(restrictions, meal.mealType, {}, [currentRecipeId]),
      select: {
        ...CANDIDATE,
        title: true,
        caloriesPerServing: true,
        proteinPerServing: true,
        fatPerServing: true,
        carbsPerServing: true,
        ingredients: { select: { ingredientId: true, ingredient: { select: { name: true } } } },
      },
      orderBy: { id: 'asc' },
    });
    if (candidates.length === 0) {
      throw new NotFoundException({ error: 'NO_ALTERNATIVE', message: 'No alternative recipe found.' });
    }

    const freshCandidates = candidates.filter((c) => !shown.has(c.id));
    let pool = freshCandidates.length > 0 ? freshCandidates : candidates;
    // Sort the pool by pantry coverage descending so the AI sees pantry-
    // friendly recipes first AND the engine's own pick prefers them. Coverage
    // is null when the toggle is off or the pantry is empty — pool stays in
    // its original order.
    const aiSwapCoverage = await this.recipeCoverageMap(
      meal.day.plan.profileId,
      pool.map((c) => c.id),
      req.respectInventory !== false,
    );
    if (aiSwapCoverage) {
      pool = [...pool].sort((a, b) => {
        const diff = (aiSwapCoverage.get(b.id) ?? 0) - (aiSwapCoverage.get(a.id) ?? 0);
        return diff !== 0 ? diff : a.id.localeCompare(b.id);
      });
    }
    // Cut after filtering and ordering, so the cut never hides what was not
    // shown yet. Twenty-five keeps the prompt small enough for cheap models.
    pool = pool.slice(0, AI_SWAP_POOL);

    const daySlots = await this.prisma.plannedMeal.findMany({
      where: { dayId: meal.dayId },
      select: { mealType: true },
    });
    const budgets = slotBudgets(
      daySlots.map((d) => d.mealType as MealType),
      meal.day.calorieTarget,
    );
    const budget = budgets.get(meal.mealType as MealType) ?? meal.day.calorieTarget;

    const current = await this.prisma.recipe.findUniqueOrThrow({
      where: { id: currentRecipeId },
      select: { title: true, caloriesPerServing: true },
    });

    const prompt = buildSwapPrompt({
      slot: meal.mealType as MealType,
      budget,
      currentTitle: current.title,
      currentKcal: Math.round(current.caloriesPerServing),
      candidates: pool,
      hint: req.hint,
      locale,
    });
    const { text, meta } = await this.ai.chat(
      userId,
      [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      MEAL_SWAP,
      true,
    );

    // Only one of the candidates counts as a pick. When the model answered with
    // anything else the engine picks, and the response says that it did.
    const offered = text === null ? null : parseAiRecipePick(text);
    const pick = offered && pool.some((c) => c.id === offered.id) ? offered : null;
    const replacement =
      pool.find((c) => c.id === pick?.id) ?? pool[pickIndex(`${req.plannedMealId}:${prevHistory.length}`, pool.length)]!;
    const aiMeta = pick ? { ...meta, reason: pick.reason } : text === null ? meta : withUnusableAnswer(meta);

    // The gate: the model's pick and the engine's are judged alike before the write.
    assertMayEnter(replacement, restrictions, meal.mealType, 'RECIPE_NOT_ELIGIBLE');
    const replacementId = replacement.id;
    const nextHistory = nextSwapHistory(prevHistory, currentRecipeId, freshCandidates.length > 0);
    const servings = fitServings(replacement.caloriesPerServing, budget);

    // The revision was read before the model was asked: if the plan changed
    // while the model was answering, the pick is not written.
    const summary = await writePlan(this.prisma, req.planId, meal.day.plan.revision, async (tx) => {
      await tx.plannedMeal.update({
        where: { id: req.plannedMealId },
        data: { recipeId: replacementId, servings, swapHistory: nextHistory, quantityScale: 1 },
      });
      // The swap changed the day total — rebalance before returning.
      return this.plans.rebalanceDayInternal(meal.dayId, tx);
    });
    const result = await this.plans.buildRebalanceResult(userId, locale, req.planId, 'day', summary);
    return { ...result, aiMeta };
  }

  /**
   * Batch-score an arbitrary recipe-id list by pantry coverage. Used by
   * the swap paths (deterministic + AI) to re-rank candidates before picking
   * / before sending to the model. Returns null when respectInventory is off
   * or the pantry is empty — callers leave their pool ordering untouched.
   */
  private async recipeCoverageMap(
    profileId: string,
    recipeIds: string[],
    respectInventory: boolean,
  ): Promise<Map<string, number> | null> {
    if (!respectInventory || recipeIds.length === 0) return null;

    const stock = await stockByIngredient(this.prisma, profileId);
    if (stock.size === 0) return null;

    const recipes = await this.prisma.recipe.findMany({
      where: { id: { in: recipeIds } },
      include: {
        ingredients: {
          include: {
            ingredient: { select: { canonicalUnit: true, gramsPerPiece: true, density: true } },
          },
        },
      },
    });
    const result = new Map<string, number>();
    for (const r of recipes) result.set(r.id, recipeCoverage(requirementsPerServing(r), stock));
    return result;
  }
}

/**
 * The recipes already shown in a slot, after a swap replaced `leaving`. While
 * the pick came from recipes not shown yet, the one leaving joins the list.
 * Once every candidate has been shown the list starts again with it alone, so
 * the next swap sees the earlier ones as fresh.
 */
function nextSwapHistory(previous: readonly string[], leaving: string, fromFresh: boolean): string[] {
  if (!fromFresh) return [leaving];
  return previous.includes(leaving) ? [...previous] : [...previous, leaving];
}

interface SwapPromptCandidate {
  id: string;
  title: string;
  caloriesPerServing: number;
  proteinPerServing: number;
  fatPerServing: number;
  carbsPerServing: number;
  ingredients: { ingredient: { name: string } }[];
}

/**
 * Build the system + user prompt for the meal-swap ranker. Nutrition values
 * are rounded server-side and pinned into the prompt so the model can't move
 * them; the deterministic engine recomputes everything anyway after the pick.
 */
function buildSwapPrompt(input: {
  slot: MealType;
  budget: number;
  currentTitle: string;
  currentKcal: number;
  candidates: SwapPromptCandidate[];
  hint?: string;
  locale: Locale;
}): { system: string; user: string } {
  const lines = input.candidates.map((c) => {
    const mains = c.ingredients
      .map((x) => x.ingredient.name)
      .slice(0, 4)
      .join(', ');
    return `- id=${c.id} | ${c.title} | ${Math.round(c.caloriesPerServing)} kcal · ${Math.round(c.proteinPerServing)}P/${Math.round(c.fatPerServing)}F/${Math.round(c.carbsPerServing)}C | ${mains}`;
  });

  const system =
    'You rank meal-swap candidates for a deterministic meal-planning app. ' +
    'You never invent ingredients or calories — your only job is to pick the ' +
    'best id from the list provided. ' +
    'Respond with valid JSON exactly matching ' +
    '{"recipeId":"<id>","reason":"<one short sentence>"} — no prose, no ' +
    'markdown, no other keys. The reason tells the person who will eat the ' +
    `meal why you picked it; write it in ${LANGUAGE[input.locale]}.`;

  const user = [
    `Slot: ${input.slot}`,
    `Slot calorie budget: ~${Math.round(input.budget)} kcal`,
    `Currently planned: ${input.currentTitle} (${input.currentKcal} kcal per serving)`,
    input.hint ? `User hint: ${input.hint}` : null,
    '',
    'Pick the candidate that:',
    '1. stays closest to the slot calorie budget at one serving,',
    '2. honours the user hint if any,',
    '3. is meaningfully different from the currently planned meal.',
    '',
    'Candidates:',
    ...lines,
    '',
    'Respond with the JSON object only.',
  ]
    .filter((s): s is string => s !== null)
    .join('\n');

  return { system, user };
}

/**
 * The recipe the model picked and why, as far as its answer says. Null when
 * the answer holds no id, so the service can fall back deterministically.
 */
function parseAiRecipePick(text: string): { id: string; reason: string | null } | null {
  const reply = readModelReply(text, RecipePick);
  if (!reply.ok) return null;
  return { id: reply.value.recipeId, reason: modelText(reply.value.reason, MAX_REASON_CHARS) };
}
