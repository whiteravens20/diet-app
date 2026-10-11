// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  fitsDiet,
  Locale as LocaleEnum,
  PlanOptions,
  type AddCustomMealRequest,
  type AiGenerationMeta,
  type AiSuggestIngredientRequest,
  type AiSuggestIngredientResponse,
  type AiSwapMealRequest,
  type AiSwapMealResponse,
  type Locale,
  type MealPlan,
  type MealPlanDay,
  type MealType,
  type PlannedMeal,
  type RebalanceChange,
  type RebalanceRequest,
  type RebalanceResult,
  type SwapIngredientRequest,
  type SwapIngredientResponse,
  type SwapMealRequest,
  type SwapPreview,
} from '@diet-app/shared';
import {
  safetyFloor,
  fitServings,
  rebalanceDay,
  rebalanceWeek,
  recipeCoverage,
  recipeFacts,
  requirementsPerServing,
  slotBudgets,
  substituteIngredient,
  UnitConversionError,
  type EngineIngredient,
  type RebalanceMeal,
  type RecipeFacts,
} from '../engine/index.js';
import { AiRouterService, withUnusableAnswer } from '../ai/ai-router.service.js';
import { modelText, readModelReply } from '../ai/model-json.js';
import { INGREDIENT_SWAP, MEAL_SWAP, SWAP_REWRITE } from '../ai/operations.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { toIngredientDto } from '../ingredients/ingredients.service.js';
import { toPlannedIngredients, toRecipeDto } from '../recipes/recipes.service.js';
import { PersonalRecipesService } from '../recipes/personal-recipes.service.js';
import {
  rewriteSwapModeA,
  rewriteSwapModeB,
  validateModeBOutput,
  type RecipeLocaleSlice,
} from './swap-rewrite.js';
import { stockByIngredient } from '../inventory/pantry-store.js';
import { shownReport } from './generation-report.js';
import { customMacros, isoDate, parseDayOverrides } from './plan-days.js';
import { releasePlanLists } from '../shopping-lists/shopping-lists.service.js';
import { writePlan } from './plan-write.js';
import {
  assertMayEnter,
  CANDIDATE,
  pickIndex,
  poolWhere,
  restrictionsFor,
  violations,
  type Candidate,
  type Restrictions,
  type Waived,
} from './eligibility.js';

/** How many candidates an AI swap puts before the model. */
const AI_SWAP_POOL = 25;

// What each prompt asks the model to answer with. A reason is welcome and
// never required: a pick without one is still a pick.
const RecipePick = z.object({ recipeId: z.string().min(1), reason: z.unknown() });
const IngredientPick = z.object({ ingredientId: z.string().min(1), reason: z.unknown() });

/** The longest explanation of a pick that is passed on to the user. */
const MAX_REASON_CHARS = 200;

/** The language a model is asked to write in, by locale. */
const LANGUAGE: Record<Locale, string> = { en: 'English', pl: 'Polish' };
const SwapRewrite = z.object({
  description: z.string().trim().min(1),
  steps: z.array(z.string().trim().min(1)),
});

/**
 * Reading a plan and changing its meals: swaps, meals of the user's own, what
 * was eaten, the rebalance. Making a plan is `PlanGenerationService`.
 */
@Injectable()
export class MealPlansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiRouterService,
    private readonly personalRecipes: PersonalRecipesService,
  ) {}

  /** Delete a plan and everything under it (days, meals, shopping lists cascade). */
  async remove(userId: string, planId: string): Promise<void> {
    const plan = await this.prisma.mealPlan.findUnique({
      where: { id: planId },
      include: { profile: true },
    });
    if (!plan?.profile) throw new NotFoundException({ error: 'PLAN_NOT_FOUND', message: 'Meal plan not found.' });
    if (plan.profile.userId !== userId) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Plan belongs to another user.' });
    }
    const profileId = plan.profile.id;
    // The plan takes its shopping lists with it. What was obtained for the
    // days still ahead is in the kitchen and goes into the pantry first, by
    // the rule a list deleted on its own follows.
    await this.prisma.$transaction(
      async (tx) => {
        await releasePlanLists(tx, planId, profileId);
        await tx.mealPlan.deleteMany({ where: { id: planId } });
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
  }

  async list(
    userId: string,
    locale: Locale,
    profileId: string,
    filters: { from?: string; to?: string; status?: string } = {},
  ): Promise<MealPlan[]> {
    await this.loadProfile(userId, profileId);

    // `to` constrains startDate (`startDate <= to`). For `from` we need
    // `startDate + durationDays - 1 >= from`, which Prisma can't express as a
    // single column comparison — defer that check to a JS filter below.
    const where: { profileId: string; startDate?: { lte?: Date } } = { profileId };
    if (filters.to) where.startDate = { lte: new Date(filters.to) };

    let plans = await this.prisma.mealPlan.findMany({
      where,
      orderBy: { startDate: 'desc' },
    });

    const planEnd = (p: { startDate: Date; durationDays: number }): Date => {
      const end = new Date(p.startDate);
      end.setUTCDate(end.getUTCDate() + p.durationDays - 1);
      return end;
    };
    if (filters.from) {
      const fromDate = new Date(filters.from);
      plans = plans.filter((p) => planEnd(p) >= fromDate);
    }
    if (filters.status) {
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      plans = plans.filter((p) => {
        const start = new Date(p.startDate);
        const end = planEnd(p);
        if (filters.status === 'active') return start <= today && today <= end;
        if (filters.status === 'past') return end < today;
        if (filters.status === 'upcoming') return start > today;
        return true;
      });
    }

    return Promise.all(plans.map((p) => this.get(userId, locale, p.id)));
  }

  async get(userId: string, locale: Locale, planId: string): Promise<MealPlan> {
    const trWhere = locale === 'en' ? ['en'] : [locale, 'en'];
    const plan = await this.prisma.mealPlan.findUnique({
      where: { id: planId },
      include: {
        days: {
          orderBy: { date: 'asc' },
          include: {
            meals: {
              include: {
                recipe: {
                  include: {
                    ingredients: {
                      include: {
                        ingredient: { include: { translations: { where: { locale: { in: trWhere } } } } },
                      },
                    },
                    translations: { where: { locale: { in: trWhere } } },
                  },
                },
              },
            },
          },
        },
        profile: { include: { preferences: true } },
      },
    });
    if (!plan?.profile) throw new NotFoundException({ error: 'PLAN_NOT_FOUND', message: 'Meal plan not found.' });
    if (plan.profile.userId !== userId) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Plan belongs to another user.' });
    }
    return this.toDto(plan, locale, await restrictionsFor(this.prisma, plan));
  }

  /** Swap a planned meal for a random / favorite alternative; applies immediately. */
  async swapMeal(userId: string, locale: Locale, req: SwapMealRequest): Promise<RebalanceResult> {
    const meal = await this.loadPlannedMeal(userId, req.planId, req.plannedMealId);
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
      return this.rebalanceDayInternal(meal.dayId, tx);
    });
    return this.buildRebalanceResult(userId, locale, req.planId, 'day', summary);
  }

  /**
   * Add a user-authored custom meal to a day. The macros are frozen on
   * the row as the user entered them — the engine never recomputes them, because
   * a custom meal has no ingredient list. Adding it changes the day total, so a
   * day rebalance runs immediately.
   */
  async addCustomMeal(
    userId: string,
    locale: Locale,
    planId: string,
    date: string,
    req: AddCustomMealRequest,
  ): Promise<RebalanceResult> {
    const day = await this.loadDay(userId, planId, date);
    if (![req.nutrition.calories, req.nutrition.protein, req.nutrition.fat, req.nutrition.carbs].every(
      (v) => Number.isFinite(v) && v >= 0,
    )) {
      throw new BadRequestException({
        error: 'CUSTOM_MEAL_INVALID_MACROS',
        message: 'Custom meal macros must be non-negative numbers.',
      });
    }

    const overrides = parseDayOverrides(day.overrides);
    const summary = await writePlan(this.prisma, planId, day.plan.revision, async (tx) => {
      // Adding a meal to a previously-skipped day un-skips it (it now has content).
      if (overrides?.skip) {
        const rest: Record<string, unknown> = { ...(overrides as Record<string, unknown>) };
        delete rest.skip;
        await tx.mealPlanDay.update({
          where: { id: day.id },
          data: { overrides: Object.keys(rest).length > 0 ? (rest as Prisma.InputJsonValue) : Prisma.JsonNull },
        });
      }
      await tx.plannedMeal.create({
        data: {
          dayId: day.id,
          recipeId: null,
          mealType: req.mealType,
          servings: req.servings,
          quantityScale: 1,
          source: 'USER_CUSTOM',
          customName: req.name,
          customMacros: {
            calories: req.nutrition.calories,
            protein: req.nutrition.protein,
            fat: req.nutrition.fat,
            carbs: req.nutrition.carbs,
          },
        },
      });
      return this.rebalanceDayInternal(day.id, tx);
    });
    return this.buildRebalanceResult(userId, locale, planId, 'day', summary);
  }

  /**
   * Mark a planned meal eaten or not eaten. An eaten meal is pinned out of the
   * rebalance set (scaling an already-eaten portion is meaningless), so the day
   * is rebalanced after a change to redistribute among the rest. Asking for the
   * state the meal is already in changes nothing, so a repeated request is safe.
   */
  async setEaten(
    userId: string,
    locale: Locale,
    planId: string,
    mealId: string,
    eaten: boolean,
  ): Promise<RebalanceResult> {
    const meal = await this.loadPlannedMeal(userId, planId, mealId);
    if ((meal.eatenAt !== null) === eaten) {
      return this.buildRebalanceResult(userId, locale, planId, 'day', null);
    }
    const summary = await writePlan(this.prisma, planId, meal.day.plan.revision, async (tx) => {
      await tx.plannedMeal.update({
        where: { id: mealId },
        data: { eatenAt: eaten ? new Date() : null },
      });
      return this.rebalanceDayInternal(meal.dayId, tx);
    });
    return this.buildRebalanceResult(userId, locale, planId, 'day', summary);
  }

  /**
   * Explicit rebalance. `day` rebalances one date; `week` shares the
   * surplus/deficit across the plan week. `restore` is the undo path: it writes
   * the supplied scales verbatim (the toast's pre-edit `before` map) and skips
   * the solver.
   */
  async rebalance(
    userId: string,
    locale: Locale,
    planId: string,
    req: RebalanceRequest,
  ): Promise<RebalanceResult> {
    // Authorise the plan up front, and note the revision the request starts from.
    const { revision } = await this.planOf(userId, planId);

    const restore = req.restore;
    if (restore && restore.length > 0) {
      await writePlan(this.prisma, planId, revision, (tx) => this.restoreScales(planId, restore, tx));
      return this.buildRebalanceResult(userId, locale, planId, req.scope, null);
    }

    if (req.scope === 'week') {
      const summary = await writePlan(this.prisma, planId, revision, (tx) =>
        this.rebalanceWeekInternal(planId, tx, req.date ?? isoDate(new Date())),
      );
      return this.buildRebalanceResult(userId, locale, planId, 'week', summary);
    }

    if (!req.date) {
      throw new BadRequestException({
        error: 'REBALANCE_DAY_NOT_FOUND',
        message: 'A date is required to rebalance a single day.',
      });
    }
    const day = await this.loadDay(userId, planId, req.date);
    const summary = await writePlan(this.prisma, planId, revision, (tx) =>
      this.rebalanceDayInternal(day.id, tx),
    );
    return this.buildRebalanceResult(userId, locale, planId, 'day', summary);
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
    const meal = await this.loadPlannedMeal(userId, req.planId, req.plannedMealId);
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
      return this.rebalanceDayInternal(meal.dayId, tx);
    });
    const result = await this.buildRebalanceResult(userId, locale, req.planId, 'day', summary);
    return { ...result, aiMeta };
  }

  /**
   * Preview an ingredient substitution inside a planned meal's recipe. Returns
   * the calorie/macro delta; the caller confirms before persisting a variant.
   */
  async previewIngredientSwap(userId: string, req: SwapIngredientRequest): Promise<SwapPreview> {
    const meal = await this.loadPlannedMeal(userId, req.planId, req.plannedMealId);
    const mealRecipeId = swappableRecipeOf(meal);
    const recipe = await this.prisma.recipe.findUniqueOrThrow({
      where: { id: mealRecipeId },
      include: { ingredients: true },
    });
    const line = recipe.ingredients.find((i) => i.ingredientId === req.fromIngredientId);
    if (!line) throw new NotFoundException({ error: 'INGREDIENT_NOT_IN_RECIPE', message: 'Ingredient not in recipe.' });

    const [from, to] = await Promise.all([
      this.loadEngineIngredient(req.fromIngredientId),
      this.loadEngineIngredient(req.toIngredientId),
    ]);
    const prefs = meal.day.plan.profile.preferences;

    const r = substituteIngredient(from, to, line.quantity, line.unit, {
      dietType: meal.day.plan.dietType,
      allergens: (prefs?.allergens ?? []) as EngineIngredient['allergens'],
      excludedIngredientIds: prefs?.excludedIngredientIds ?? [],
    });

    return {
      before: r.before,
      after: r.after,
      calorieDelta: r.calorieDelta,
      macroDelta: r.macroDelta,
      adjustedQuantity: r.adjustedQuantity,
      explanation: r.explanation,
      valid: r.valid,
    };
  }

  /**
   * Persist an ingredient substitution. The original recipe stays canonical —
   * we clone it as a private `user`-origin variant with the new line in place,
   * recompute per-serving nutrition deterministically, and repoint the planned
   * meal at the clone. Servings are kept; the substitute is calorie-scaled.
   */
  async applyIngredientSwap(
    userId: string,
    locale: Locale,
    req: SwapIngredientRequest,
  ): Promise<SwapIngredientResponse> {
    const meal = await this.loadPlannedMeal(userId, req.planId, req.plannedMealId);
    const mealRecipeId = swappableRecipeOf(meal);
    const recipe = await this.prisma.recipe.findUniqueOrThrow({
      where: { id: mealRecipeId },
      include: {
        ingredients: { include: { ingredient: true } },
        translations: true,
      },
    });
    const line = recipe.ingredients.find((i) => i.ingredientId === req.fromIngredientId);
    if (!line) {
      throw new NotFoundException({
        error: 'INGREDIENT_NOT_IN_RECIPE',
        message: 'Ingredient not in recipe.',
      });
    }

    const [from, to] = await Promise.all([
      this.loadEngineIngredient(req.fromIngredientId),
      this.loadEngineIngredient(req.toIngredientId),
    ]);
    const prefs = meal.day.plan.profile.preferences;
    const sub = substituteIngredient(from, to, line.quantity, line.unit, {
      dietType: meal.day.plan.dietType,
      allergens: (prefs?.allergens ?? []) as EngineIngredient['allergens'],
      excludedIngredientIds: prefs?.excludedIngredientIds ?? [],
    });
    if (!sub.valid) {
      throw new BadRequestException({
        error: 'INVALID_SUBSTITUTION',
        message: sub.explanation,
      });
    }

    // Build the variant's ingredient lines + load full ingredient rows: those
    // of the variant for its nutrition, and the one swapped out as well, whose
    // names the text of the variant is searched for.
    const ingredientRows = await this.prisma.ingredient.findMany({
      where: { id: { in: [...recipe.ingredients.map((i) => i.ingredientId), req.toIngredientId] } },
      include: { translations: true },
    });
    const ingredientById = new Map(ingredientRows.map((i) => [i.id, i]));

    const variantIngredients = recipe.ingredients.map((i) => {
      if (i.ingredientId !== req.fromIngredientId) {
        return { ingredientId: i.ingredientId, quantity: i.quantity, unit: i.unit, note: i.note };
      }
      return {
        ingredientId: req.toIngredientId,
        quantity: sub.adjustedQuantity,
        unit: sub.adjustedUnit,
        note: i.note,
      };
    });

    // The variant's nutrition, allergens and diets follow from its own
    // ingredients: the one swapped out may have been the only source of an
    // allergen, and the one swapped in may not suit a diet the source did.
    let facts: RecipeFacts;
    try {
      facts = recipeFacts(
        variantIngredients.map((line) => ({
          quantity: line.quantity,
          unit: line.unit,
          ingredient: ingredientById.get(line.ingredientId)!,
        })),
        recipe.servings,
      );
    } catch (err) {
      if (!(err instanceof UnitConversionError)) throw err;
      throw new BadRequestException({
        error: 'UNIT_CONVERSION_FAILED',
        message: 'An ingredient of this recipe cannot be converted from the unit it is written in.',
      });
    }
    // The substitute was judged as an ingredient; the gate judges what the
    // meal becomes. A recipe can stop fitting a diet through quantities alone:
    // a low-carbohydrate dish with rice in place of chicken is no longer one.
    // What the meal already was by the user's own choice (an off-diet
    // favourite, a recipe of another meal) is not held against the swap.
    const restrictions = await restrictionsFor(this.prisma, meal.day.plan);
    assertMayEnter(
      {
        id: recipe.id,
        mealTypes: recipe.mealTypes,
        dietTags: facts.dietTags,
        allergens: facts.allergens,
        createdByUserId: userId,
        deletedAt: null,
        retiredAt: null,
        ingredients: variantIngredients,
      },
      // The variant is a new recipe: no avoid mark is on it yet.
      { ...restrictions, avoidedRecipeIds: [] },
      meal.mealType,
      'INVALID_SUBSTITUTION',
      {
        diet: !fitsDiet(recipe.dietTags, meal.day.plan.dietType),
        meal: !recipe.mealTypes.includes(meal.mealType),
      },
    );

    // The text of the variant: the substitute's name in place of the old one,
    // by plain replacement, or reworded by a model when the user asked for it.
    const variant = await this.buildVariantTranslations(
      userId,
      locale,
      recipe,
      ingredientById.get(req.fromIngredientId)!,
      ingredientById.get(req.toIngredientId)!,
      req.rewriteWithAi,
    );

    // Stored as the user's own recipe, or recognised as one that exists
    // already. A shared recipe the profile avoids is not handed back for it.
    const variantId = await this.personalRecipes.save(
      {
        userId,
        origin: 'user',
        text: variant.text,
        modelWrote: variant.modelWrote,
        servings: recipe.servings,
        mealTypes: recipe.mealTypes,
        prepMinutes: recipe.prepMinutes,
        cookMinutes: recipe.cookMinutes,
        difficulty: recipe.difficulty,
        reuseScore: recipe.reuseScore,
        ingredients: variantIngredients,
        facts,
      },
      restrictions.avoidedRecipeIds,
    );

    const summary = await writePlan(this.prisma, req.planId, meal.day.plan.revision, async (tx) => {
      await tx.plannedMeal.update({
        where: { id: req.plannedMealId },
        data: { recipeId: variantId },
      });
      // The substitution changed the meal's macros, so the day total moved —
      // run the same rebalance pipeline as every other edit.
      return this.rebalanceDayInternal(meal.dayId, tx);
    });
    return {
      ...(await this.buildRebalanceResult(userId, locale, req.planId, 'day', summary)),
      aiMeta: variant.aiMeta,
    };
  }

  /**
   * Resolve per-locale display name maps for old / new ingredient from their
   * `IngredientTranslation` rows + canonical `name` fallback, then run Mode A
   * substitution against every translation row that the source recipe carries.
   * The output is the per-locale slice we'll write into `RecipeTranslation`
   * for the variant.
   */
  private async buildVariantTranslations(
    userId: string,
    locale: Locale,
    source: { title: string; description: string; steps: string[]; translations: { locale: string; title: string; description: string; steps: string[] }[] },
    oldIngredient: { name: string; translations: { locale: string; name: string }[] },
    newIngredient: { name: string; translations: { locale: string; name: string }[] },
    rewriteWithAi: boolean,
  ): Promise<{ text: Map<Locale, RecipeLocaleSlice>; aiMeta: AiGenerationMeta | null; modelWrote: Set<Locale> }> {
    const localeOptions = LocaleEnum.options;
    // The recipe row itself holds the English text; a translation row for `en` wins over it.
    const sourceSlices = new Map<Locale, RecipeLocaleSlice>([
      ['en', { title: source.title, description: source.description, steps: source.steps }],
    ]);
    for (const tr of source.translations) {
      if (!localeOptions.includes(tr.locale as Locale)) continue;
      sourceSlices.set(tr.locale as Locale, {
        title: tr.title,
        description: tr.description,
        steps: tr.steps,
      });
    }
    const input = {
      source: sourceSlices,
      oldName: nameByLocale(oldIngredient),
      newName: nameByLocale(newIngredient),
    };

    // A model rewords the text only when the user asked for it in this
    // request: it costs them a call and time they did not otherwise spend.
    if (!rewriteWithAi) return { text: rewriteSwapModeA(input), aiMeta: null, modelWrote: new Set() };

    // One call, for the language the user reads the recipe in: their own, or
    // English when the recipe is not written in it. Where the model delivers
    // nothing usable the plain replacement stands, and the answer says why.
    let aiMeta: AiGenerationMeta | null = null;
    // The languages a model's rewording went into: stored as a model's text.
    const modelWrote = new Set<Locale>();
    const text = await rewriteSwapModeB({
      ...input,
      locale: sourceSlices.has(locale) ? locale : 'en',
      rewrite: async (rewritten, slice) => {
        const answer = await this.aiRewriteSwapSentences(userId, rewritten, slice);
        aiMeta = answer.aiMeta;
        if (answer.text) modelWrote.add(rewritten);
        return answer.text;
      },
    });
    return { text, aiMeta, modelWrote };
  }

  /**
   * Ask the model to rewrite `description + steps` in one language so the
   * prose matches the new ingredient. The model must return JSON in the shape
   * `{description, steps}`; everything is validated by `validateModeBOutput`
   * before the caller decides to splice. The text is null on any failure, and
   * `aiMeta` then says which.
   */
  private async aiRewriteSwapSentences(
    userId: string,
    locale: Locale,
    source: { description: string; steps: string[]; oldName: string; newName: string },
  ): Promise<{ text: { description: string; steps: string[] } | null; aiMeta: AiGenerationMeta }> {
    const system =
      'You polish cooking-recipe prose for an ingredient swap. ' +
      'You are given a description, a list of steps, the ingredient that was ' +
      'swapped out, and the ingredient that replaces it. ' +
      'Rewrite so the prose matches the new ingredient, keeping the technique ' +
      'verbs, every quantity, and every other ingredient unchanged. ' +
      'You must return EXACTLY the same number of steps. ' +
      `Write entirely in ${LANGUAGE[locale]}; do not switch language. ` +
      'Never invent calories, weights, temperatures, or times. ' +
      'Respond with valid JSON exactly matching this shape — no prose, no ' +
      'markdown fences, no extra keys:\n' +
      '{"description":string,"steps":string[]}';
    const user = JSON.stringify({
      description: source.description,
      steps: source.steps,
      swappedOut: source.oldName,
      swappedIn: source.newName,
    });

    const { text, meta } = await this.ai.chat(
      userId,
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      SWAP_REWRITE,
      true,
    );
    if (!text) return { text: null, aiMeta: meta };
    const parsed = parseSwapRewritePayload(text);
    if (!parsed || !validateModeBOutput(source, parsed)) return { text: null, aiMeta: withUnusableAnswer(meta) };
    return { text: parsed, aiMeta: meta };
  }

  /**
   * AI-rank a replacement ingredient for a planned-meal line. The engine builds
   * the candidate pool (same category, diet/allergen-safe, excluding what's
   * already in the recipe); AI picks one id. The UI then runs the existing
   * preview/apply pipeline so nutrition is recomputed deterministically.
   */
  async aiSuggestIngredient(
    userId: string,
    locale: Locale,
    req: AiSuggestIngredientRequest,
  ): Promise<AiSuggestIngredientResponse> {
    const meal = await this.loadPlannedMeal(userId, req.planId, req.plannedMealId);
    const mealRecipeId = swappableRecipeOf(meal);
    const recipe = await this.prisma.recipe.findUniqueOrThrow({
      where: { id: mealRecipeId },
      include: { ingredients: true },
    });
    const line = recipe.ingredients.find((i) => i.ingredientId === req.fromIngredientId);
    if (!line) {
      throw new NotFoundException({
        error: 'INGREDIENT_NOT_IN_RECIPE',
        message: 'Ingredient not in recipe.',
      });
    }
    const from = await this.prisma.ingredient.findUniqueOrThrow({
      where: { id: req.fromIngredientId },
    });
    const prefs = meal.day.plan.profile.preferences;
    const userAllergens = new Set(prefs?.allergens ?? []);
    const excludedIds = new Set([
      ...recipe.ingredients.map((i) => i.ingredientId),
      ...(prefs?.excludedIngredientIds ?? []),
    ]);
    const dietType = meal.day.plan.dietType;

    // Same category as the source line — keeps the swap culinarily sensible
    // (sub a meat for a meat, a vegetable for a vegetable).
    // Filtered in the query and in a fixed order, so that the cut below never
    // drops an ingredient the profile could have had.
    const rawCandidates = await this.prisma.ingredient.findMany({
      where: {
        category: from.category,
        id: { notIn: [...excludedIds] },
        // A custom diet filters nothing.
        ...(dietType === 'custom' ? {} : { dietCompatibility: { has: dietType } }),
        NOT: { allergens: { hasSome: [...userAllergens] } },
        retiredAt: null,
      },
      select: {
        id: true,
        name: true,
        caloriesPer100: true,
        proteinPer100: true,
        fatPer100: true,
        carbsPer100: true,
        allergens: true,
      },
      orderBy: { id: 'asc' },
    });
    let pool = rawCandidates;
    if (pool.length === 0) {
      throw new NotFoundException({
        error: 'NO_ALTERNATIVE',
        message: 'No alternative ingredient found.',
      });
    }
    // Surface pantry-friendly substitutes first. The AI sees them at the
    // top of the list AND the deterministic fallback (hashIndex on pool
    // order) prefers them.
    const pantryHits = await this.ingredientPantryHit(
      meal.day.plan.profileId,
      pool.map((c) => c.id),
      req.respectInventory !== false,
    );
    if (pantryHits) {
      pool = [...pool].sort((a, b) => {
        const aHit = pantryHits.has(a.id) ? 1 : 0;
        const bHit = pantryHits.has(b.id) ? 1 : 0;
        return bHit - aHit || a.id.localeCompare(b.id);
      });
    }
    pool = pool.slice(0, AI_SWAP_POOL);

    const prompt = buildIngredientSwapPrompt({
      currentName: from.name,
      currentCategory: from.category,
      currentKcalPer100: Math.round(from.caloriesPer100),
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
      INGREDIENT_SWAP,
      true,
    );

    const fallbackPick = (): string => {
      const idx = pickIndex(`${req.plannedMealId}:${req.fromIngredientId}`, pool.length);
      return pool[idx]!.id;
    };

    const offered = text === null ? null : parseAiIngredientPick(text);
    const pick = offered && pool.some((c) => c.id === offered.id) ? offered : null;
    const toIngredientId = pick?.id ?? fallbackPick();
    const aiMeta = pick ? { ...meta, reason: pick.reason } : text === null ? meta : withUnusableAnswer(meta);

    const locales = locale === 'en' ? ['en'] : [locale, 'en'];
    const toIngredient = await this.prisma.ingredient.findUniqueOrThrow({
      where: { id: toIngredientId },
      include: { translations: { where: { locale: { in: locales } } } },
    });
    return { toIngredient: toIngredientDto(toIngredient, locale), aiMeta };
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /** The profile, when it is this user's; otherwise the refusal every route that names a profile gives. */
  async loadProfile(userId: string, profileId: string) {
    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      include: { preferences: true },
    });
    if (!profile) throw new NotFoundException({ error: 'PROFILE_NOT_FOUND', message: 'Profile not found.' });
    if (profile.userId !== userId) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Profile belongs to another user.' });
    }
    return profile;
  }

  /*
   * A note for every loader below and its like in the other services: Prisma
   * fetches an included relation with a query of its own. When a plan is
   * deleted between two of those queries, a row comes back with a relation the
   * types call required set to null. Such a row is on its way out, so the
   * loaders treat a missing relation as "not found".
   */
  private async loadPlannedMeal(userId: string, planId: string, plannedMealId: string) {
    const meal = await this.prisma.plannedMeal.findUnique({
      where: { id: plannedMealId },
      include: { day: { include: { plan: { include: { profile: { include: { preferences: true } } } } } } },
    });
    if (!meal?.day?.plan?.profile || meal.day.planId !== planId) {
      throw new NotFoundException({ error: 'MEAL_NOT_FOUND', message: 'Planned meal not found.' });
    }
    if (meal.day.plan.profile.userId !== userId) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Plan belongs to another user.' });
    }
    return meal;
  }

  /** Load + authorise a plan day by ISO date. */
  /** The revision of a plan that is `userId`'s: enough to authorise an edit and to start it. */
  private async planOf(userId: string, planId: string): Promise<{ revision: number }> {
    const plan = await this.prisma.mealPlan.findUnique({ where: { id: planId }, select: { revision: true, profile: { select: { userId: true } } } });
    if (!plan?.profile) throw new NotFoundException({ error: 'PLAN_NOT_FOUND', message: 'Meal plan not found.' });
    if (plan.profile.userId !== userId) throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Plan belongs to another user.' });
    return { revision: plan.revision };
  }

  private async loadDay(userId: string, planId: string, date: string) {
    const day = await this.prisma.mealPlanDay.findFirst({
      where: { planId, date: new Date(date) },
      include: { plan: { include: { profile: true } } },
    });
    if (!day?.plan?.profile) {
      throw new NotFoundException({ error: 'REBALANCE_DAY_NOT_FOUND', message: 'Plan day not found.' });
    }
    if (day.plan.profile.userId !== userId) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Plan belongs to another user.' });
    }
    return day;
  }

  /**
   * Rebalance one day's unchecked, non-custom meals toward its target and
   * persist the new quantity scales. Returns the summary the UI toast renders,
   * or null when the day has vanished. Runs inside the transaction of the edit
   * that changed the day, whichever service made it.
   */
  async rebalanceDayInternal(
    dayId: string,
    tx: Prisma.TransactionClient,
  ): Promise<RebalanceSummary | null> {
    const day = await tx.mealPlanDay.findUnique({
      where: { id: dayId },
      include: { meals: { include: { recipe: { select: REBALANCE_MACRO_SELECT } } } },
    });
    if (!day) return null;
    const rows = day.meals.map(toRebalanceRow);
    const macrosBefore = rowsMacros(rows, (r) => r.quantityScale);
    const { scales, feasibility } = rebalanceDay(rows.map(toEngineMeal), day.calorieTarget);
    const changes = await this.persistScales(rows, scales, tx);
    const macrosAfter = rowsMacros(rows, (r) => scales.get(r.id) ?? r.quantityScale);
    return { feasibility, changes, macrosBefore, macrosAfter };
  }

  /** Week-aware variant: share the surplus/deficit across the plan week. */
  private async rebalanceWeekInternal(
    planId: string,
    tx: Prisma.TransactionClient,
    from: string,
  ): Promise<RebalanceSummary | null> {
    const plan = await tx.mealPlan.findUnique({
      where: { id: planId },
      include: {
        days: {
          orderBy: { date: 'asc' },
          include: { meals: { include: { recipe: { select: REBALANCE_MACRO_SELECT } } } },
        },
      },
    });
    if (!plan) return null;
    // From the day asked for to the end of its week of the plan. What lies
    // before it is done with, and is not changed after the fact.
    const first = plan.days.findIndex((d) => isoDate(d.date) >= from);
    const days = first === -1 ? [] : plan.days.slice(first, (Math.floor(first / 7) + 1) * 7);
    const dayRows = days.map((d) => ({ target: d.calorieTarget, rows: d.meals.map(toRebalanceRow) }));
    const allRows = dayRows.flatMap((d) => d.rows);
    const macrosBefore = rowsMacros(allRows, (r) => r.quantityScale);
    const { scales, feasibility, unabsorbed } = rebalanceWeek(
      dayRows.map((d) => ({ target: d.target, meals: d.rows.map(toEngineMeal) })),
    );
    const changes = await this.persistScales(allRows, scales, tx);
    const macrosAfter = rowsMacros(allRows, (r) => scales.get(r.id) ?? r.quantityScale);
    return { feasibility, changes, macrosBefore, macrosAfter, unabsorbedKcal: Math.round(unabsorbed) };
  }

  /** Persist only the meals whose quantity scale actually changed. */
  private async persistScales(
    rows: RebalanceRow[],
    scales: Map<string, number>,
    tx: Prisma.TransactionClient,
  ): Promise<RebalanceChange[]> {
    const changes: RebalanceChange[] = [];
    const now = new Date();
    for (const r of rows) {
      const next = scales.get(r.id);
      if (next === undefined || Math.abs(next - r.quantityScale) < 1e-9) continue;
      changes.push({ mealId: r.id, before: r.quantityScale, after: next });
      await tx.plannedMeal.update({
        where: { id: r.id },
        data: { quantityScale: next, lastRebalanceAt: now },
      });
    }
    return changes;
  }

  /** Undo: write the supplied scales verbatim (the toast's pre-edit map). */
  private async restoreScales(
    planId: string,
    restore: { mealId: string; scale: number }[],
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    const meals = await tx.plannedMeal.findMany({
      where: { id: { in: restore.map((r) => r.mealId) }, day: { planId } },
      select: { id: true, source: true, eatenAt: true },
    });
    const byId = new Map(meals.map((m) => [m.id, m]));
    for (const r of restore) {
      const m = byId.get(r.mealId);
      if (!m) throw new NotFoundException({ error: 'MEAL_NOT_FOUND', message: 'Planned meal not found.' });
      if (m.source === 'USER_CUSTOM' || m.eatenAt != null) {
        throw new BadRequestException({
          error: 'MEAL_NOT_REBALANCEABLE',
          message: 'Custom and eaten meals are never rebalanced.',
        });
      }
    }
    const now = new Date();
    for (const r of restore) {
      await tx.plannedMeal.update({
        where: { id: r.mealId },
        data: { quantityScale: r.scale, lastRebalanceAt: now },
      });
    }
  }

  private async buildRebalanceResult(
    userId: string,
    locale: Locale,
    planId: string,
    scope: 'day' | 'week',
    summary: RebalanceSummary | null,
  ): Promise<RebalanceResult> {
    const plan = await this.get(userId, locale, planId);
    return {
      plan,
      rebalance: summary
        ? {
            scope,
            feasibility: summary.feasibility,
            changes: summary.changes,
            unabsorbedKcal: summary.unabsorbedKcal ?? 0,
            macrosBefore: summary.macrosBefore,
            macrosAfter: summary.macrosAfter,
          }
        : null,
    };
  }

  private async loadEngineIngredient(id: string): Promise<EngineIngredient> {
    const i = await this.prisma.ingredient.findUnique({ where: { id } });
    if (!i) throw new NotFoundException({ error: 'INGREDIENT_NOT_FOUND', message: 'Ingredient not found.' });
    return {
      id: i.id,
      name: i.name,
      category: i.category,
      canonicalUnit: i.canonicalUnit,
      gramsPerPiece: i.gramsPerPiece,
      density: i.density,
      caloriesPer100: i.caloriesPer100,
      proteinPer100: i.proteinPer100,
      fatPer100: i.fatPer100,
      carbsPer100: i.carbsPer100,
      allergens: i.allergens as EngineIngredient['allergens'],
      dietCompatibility: i.dietCompatibility as EngineIngredient['dietCompatibility'],
    };
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

  /**
   * Which of the given ingredients the pantry holds any of. Used by the AI
   * ingredient suggestion to put what is at home first. Null when the toggle
   * is off or the pantry holds none of them.
   */
  private async ingredientPantryHit(
    profileId: string,
    ingredientIds: string[],
    respectInventory: boolean,
  ): Promise<Set<string> | null> {
    if (!respectInventory || ingredientIds.length === 0) return null;
    const stock = await stockByIngredient(this.prisma, profileId, { ingredientId: { in: ingredientIds } });
    return stock.size === 0 ? null : new Set(stock.keys());
  }

  private toDto(plan: PlanWithRelations, locale: Locale, restrictions: Restrictions): MealPlan {
    const floor = safetyFloor(plan.profile?.sex ?? null);
    const days: MealPlanDay[] = plan.days.map((day) => {
      // Sort meals into canonical eating order — Prisma's row order is
      // undefined and shifts after updates, which would look like other meals
      // also changed.
      const orderedMeals = [...day.meals].sort((a, b) => mealRank(a.mealType) - mealRank(b.mealType));
      const meals: PlannedMeal[] = orderedMeals.map((m) => {
        // Effective amount folds the rebalancer multiplier into the baseline.
        const factor = m.servings * m.quantityScale;
        const eatenAt = m.eatenAt ? m.eatenAt.toISOString() : null;
        // Custom meal: no catalogue recipe, macros frozen on the row.
        if (m.source === 'USER_CUSTOM' || !m.recipe) {
          const per = customMacros(m.customMacros);
          return {
            id: m.id,
            mealType: m.mealType as MealType,
            recipe: null,
            source: 'USER_CUSTOM' as const,
            customName: m.customName ?? null,
            ingredients: [],
            servings: m.servings,
            quantityScale: m.quantityScale,
            eatenAt,
            dietOverride: false,
            restrictionConflicts: [],
            nutrition: {
              calories: Math.round(per.calories * factor),
              protein: Math.round(per.protein * factor),
              fat: Math.round(per.fat * factor),
              carbs: Math.round(per.carbs * factor),
            },
          };
        }
        const recipe = toRecipeDto(m.recipe, locale);
        const n = recipe.nutritionPerServing;
        return {
          id: m.id,
          mealType: m.mealType as MealType,
          recipe,
          // The recipe's lines are for `recipe.servings` servings; the meal takes `factor` of one.
          ingredients: toPlannedIngredients(m.recipe.ingredients, factor / Math.max(1, m.recipe.servings), locale),
          source: 'CATALOGUE' as const,
          customName: null,
          servings: m.servings,
          quantityScale: m.quantityScale,
          eatenAt,
          // A meal the plan's diet does not admit: a favourite swapped in on
          // purpose, or a recipe whose ingredients turned out not to qualify.
          dietOverride: !fitsDiet(m.recipe.dietTags, plan.dietType),
          // What the profile ruled out after this meal was planned. The diet has
          // its own flag above, and the meal is in the slot it was planned for.
          restrictionConflicts: violations(m.recipe, restrictions, m.mealType, { diet: true, meal: true }).filter(
            (violation) => violation !== 'not_available',
          ) as PlannedMeal['restrictionConflicts'],
          nutrition: {
            calories: Math.round(n.calories * factor),
            protein: Math.round(n.protein * factor),
            fat: Math.round(n.fat * factor),
            carbs: Math.round(n.carbs * factor),
          },
        };
      });
      const dayNutrition = sumNutrition(meals.map((m) => m.nutrition));
      const overrides = parseDayOverrides(day.overrides);
      // A day the user skips has no meals: that is no shortfall.
      const skipped = overrides?.skip === true && meals.length === 0;
      return {
        id: day.id,
        date: isoDate(day.date),
        meals,
        dayNutrition,
        calorieTarget: day.calorieTarget,
        calorieDelta: skipped ? 0 : dayNutrition.calories - day.calorieTarget,
        skipped,
        belowSafetyFloor: !skipped && day.calorieTarget < floor,
        overrides,
      };
    });

    // What a day of this plan holds on average: a skipped day is no day of eating.
    const eaten = days.filter((d) => !d.skipped);
    const avg = eaten.length
      ? scaleNutrition(
          sumNutrition(eaten.map((d) => d.dayNutrition)),
          1 / eaten.length,
        )
      : { calories: 0, protein: 0, fat: 0, carbs: 0 };

    return {
      id: plan.id,
      profileId: plan.profileId,
      startDate: isoDate(plan.startDate),
      durationDays: plan.durationDays,
      dietType: plan.dietType,
      days,
      averageDailyNutrition: avg,
      targetMacros: { protein: 0, fat: 0, carbs: 0 },
      ingredientReuseScore: plan.reuseScore,
      generationMode: plan.generationMode,
      options: PlanOptions.parse(plan.options),
      report: shownReport(plan.report, days),
      revision: plan.revision,
      createdAt: plan.createdAt.toISOString(),
    };
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

interface PlanWithRelations {
  id: string;
  profileId: string;
  startDate: Date;
  durationDays: number;
  dietType: MealPlan['dietType'];
  reuseScore: number;
  generationMode: 'deterministic' | 'ai_assisted';
  options: unknown;
  report: unknown;
  revision: number;
  createdAt: Date;
  /** Whose plan it is: the floor a day's target is compared with follows from it. */
  profile: { sex: 'male' | 'female' | null } | null;
  days: {
    id: string;
    date: Date;
    calorieTarget: number;
    overrides: unknown;
    meals: {
      id: string;
      mealType: string;
      servings: number;
      quantityScale: number;
      source: 'CATALOGUE' | 'USER_CUSTOM';
      customName: string | null;
      customMacros: unknown;
      eatenAt: Date | null;
      recipe: (Parameters<typeof toRecipeDto>[0] & Candidate) | null;
    }[];
  }[];
}

/** Canonical eating order for sorting planned meals within a day. */
const MEAL_RANK: Record<string, number> = {
  breakfast: 0,
  second_breakfast: 1,
  lunch: 2,
  snack: 3,
  dinner: 4,
};
function mealRank(slot: string): number {
  return MEAL_RANK[slot] ?? 99;
}

/**
 * Parse the AI's JSON response for swap-rewrite Mode B. Returns null on any
 * shape mismatch; caller takes that as the signal to fall back to Mode A.
 */
function parseSwapRewritePayload(text: string): { description: string; steps: string[] } | null {
  const reply = readModelReply(text, SwapRewrite);
  return reply.ok ? reply.value : null;
}

/**
 * What to call an ingredient in each locale: its translation, or its English
 * name where it has none. The second-best name is still the right ingredient.
 */
function nameByLocale(ingredient: { name: string; translations: { locale: string; name: string }[] }): ReadonlyMap<Locale, string> {
  const translated = new Map(ingredient.translations.map((tr) => [tr.locale, tr.name]));
  return new Map(LocaleEnum.options.map((locale) => [locale, translated.get(locale) ?? ingredient.name]));
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

/**
 * The recipe a swap or a substitution would replace. A custom meal has none
 * and cannot be swapped; a meal that was eaten is a record of what was eaten.
 */
function swappableRecipeOf(meal: { recipeId: string | null; source: string; eatenAt: Date | null }): string {
  if (!meal.recipeId || meal.source === 'USER_CUSTOM') {
    throw new BadRequestException({
      error: 'CUSTOM_MEAL_NOT_SWAPPABLE',
      message: 'Custom meals cannot be swapped or substituted.',
    });
  }
  if (meal.eatenAt) {
    throw new ConflictException({
      error: 'MEAL_EATEN',
      message: 'A meal that was eaten cannot be changed. Unmark it first.',
    });
  }
  return meal.recipeId;
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

interface IngredientSwapPromptCandidate {
  id: string;
  name: string;
  caloriesPer100: number;
  proteinPer100: number;
  fatPer100: number;
  carbsPer100: number;
}

/**
 * Build the system + user prompt for the ingredient-swap ranker. Macros are
 * rounded and pinned into the prompt; the deterministic engine recomputes the
 * recipe nutrition after the pick, so the model can't move numbers.
 */
function buildIngredientSwapPrompt(input: {
  currentName: string;
  currentCategory: string;
  currentKcalPer100: number;
  candidates: IngredientSwapPromptCandidate[];
  hint?: string;
  locale: Locale;
}): { system: string; user: string } {
  const lines = input.candidates.map(
    (c) =>
      `- id=${c.id} | ${c.name} | ${Math.round(c.caloriesPer100)} kcal/100g · ${Math.round(c.proteinPer100)}P/${Math.round(c.fatPer100)}F/${Math.round(c.carbsPer100)}C`,
  );

  const system =
    'You rank ingredient-swap candidates for a deterministic meal-planning app. ' +
    'You never invent ingredients or macros — your only job is to pick the best ' +
    'id from the list provided. ' +
    'Respond with valid JSON exactly matching ' +
    '{"ingredientId":"<id>","reason":"<one short sentence>"} — no prose, no ' +
    'markdown, no other keys. The reason tells the cook why you picked it; ' +
    `write it in ${LANGUAGE[input.locale]}.`;

  const user = [
    `Category: ${input.currentCategory}`,
    `Currently using: ${input.currentName} (${input.currentKcalPer100} kcal/100g)`,
    input.hint ? `User hint: ${input.hint}` : null,
    '',
    'Pick the candidate that:',
    '1. is the closest culinary substitute,',
    '2. honours the user hint if any,',
    '3. has macros in the same ballpark unless the hint says otherwise.',
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
 * The ingredient the model picked and why, as far as its answer says. Null
 * when the answer holds no id, so the service can fall back deterministically.
 */
function parseAiIngredientPick(text: string): { id: string; reason: string | null } | null {
  const reply = readModelReply(text, IngredientPick);
  if (!reply.ok) return null;
  return { id: reply.value.ingredientId, reason: modelText(reply.value.reason, MAX_REASON_CHARS) };
}

// ── Rebalance helpers ───────────────────────────────────────────────────

type MacroQuad = { calories: number; protein: number; fat: number; carbs: number };

/** Per-baseline-serving macros + state for one meal, fed to the rebalancer. */
interface RebalanceRow {
  id: string;
  per: MacroQuad;
  servings: number;
  quantityScale: number;
  locked: boolean;
}

interface RebalanceSummary {
  feasibility: 'in-window' | 'best-effort';
  changes: RebalanceChange[];
  macrosBefore: MacroQuad;
  macrosAfter: MacroQuad;
  /** What a week is still off by after its rebalance; a day's rebalance leaves it out. */
  unabsorbedKcal?: number;
}

/** Prisma select for the per-serving macros the rebalancer reads off a recipe. */
const REBALANCE_MACRO_SELECT = {
  caloriesPerServing: true,
  proteinPerServing: true,
  fatPerServing: true,
  carbsPerServing: true,
} as const;

type RebalanceMealRow = {
  id: string;
  source: 'CATALOGUE' | 'USER_CUSTOM';
  customMacros: unknown;
  eatenAt: Date | null;
  servings: number;
  quantityScale: number;
  recipe: {
    caloriesPerServing: number;
    proteinPerServing: number;
    fatPerServing: number;
    carbsPerServing: number;
  } | null;
};

function toRebalanceRow(m: RebalanceMealRow): RebalanceRow {
  const per: MacroQuad =
    m.source === 'USER_CUSTOM' || !m.recipe
      ? customMacros(m.customMacros)
      : {
          calories: m.recipe.caloriesPerServing,
          protein: m.recipe.proteinPerServing,
          fat: m.recipe.fatPerServing,
          carbs: m.recipe.carbsPerServing,
        };
  return {
    id: m.id,
    per,
    servings: m.servings,
    quantityScale: m.quantityScale,
    // Pinned out of the rebalance set: user-owned custom macros or already eaten.
    locked: m.source === 'USER_CUSTOM' || m.eatenAt != null,
  };
}

const toEngineMeal = (r: RebalanceRow): RebalanceMeal => ({
  id: r.id,
  calories: r.per.calories,
  servings: r.servings,
  quantityScale: r.quantityScale,
  locked: r.locked,
});

/** Sum a day/week's effective macros given a per-meal scale lookup. */
function rowsMacros(rows: RebalanceRow[], scaleOf: (r: RebalanceRow) => number): MacroQuad {
  return rows.reduce(
    (acc, r) => {
      const f = r.servings * scaleOf(r);
      return {
        calories: acc.calories + r.per.calories * f,
        protein: acc.protein + r.per.protein * f,
        fat: acc.fat + r.per.fat * f,
        carbs: acc.carbs + r.per.carbs * f,
      };
    },
    { calories: 0, protein: 0, fat: 0, carbs: 0 },
  );
}

function sumNutrition(items: { calories: number; protein: number; fat: number; carbs: number }[]) {
  return items.reduce(
    (acc, n) => ({
      calories: acc.calories + n.calories,
      protein: acc.protein + n.protein,
      fat: acc.fat + n.fat,
      carbs: acc.carbs + n.carbs,
    }),
    { calories: 0, protein: 0, fat: 0, carbs: 0 },
  );
}

function scaleNutrition(n: { calories: number; protein: number; fat: number; carbs: number }, f: number) {
  return {
    calories: Math.round(n.calories * f),
    protein: Math.round(n.protein * f),
    fat: Math.round(n.fat * f),
    carbs: Math.round(n.carbs * f),
  };
}
