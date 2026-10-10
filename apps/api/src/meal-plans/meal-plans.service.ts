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
  MEAL_SLOTS_BY_COUNT,
  type AddCustomMealRequest,
  type AiSuggestIngredientRequest,
  type AiSuggestIngredientResponse,
  type AiSwapMealRequest,
  type AiSwapMealResponse,
  type DayOverride,
  type GeneratePlanRequest,
  type Locale,
  type MealPlan,
  type MealPlanDay,
  type MealType,
  type PlannedMeal,
  type RebalanceChange,
  type RebalanceRequest,
  type RebalanceResult,
  type RegenerateRequest,
  type SwapIngredientRequest,
  type SwapMealRequest,
  type SwapPreview,
} from '@diet-app/shared';
import {
  calculateCalories,
  dayTypeCalorieTarget,
  fitServings,
  optimisePlan,
  OptimizerError,
  rebalanceDay,
  rebalanceWeek,
  recipeCoverage,
  recipeFacts,
  slotBudgets,
  substituteIngredient,
  toCanonical,
  UnitConversionError,
  type CalorieEngineInput,
  type EngineIngredient,
  type OptimizerDay,
  type OptimizerRecipe,
  type OptimizerResult,
  type RebalanceMeal,
  type RecipeFacts,
} from '../engine/index.js';
import { AiRouterService, withUnusableAnswer } from '../ai/ai-router.service.js';
import { modelText, readModelReply } from '../ai/model-json.js';
import { INGREDIENT_SWAP, MEAL_SWAP, SWAP_REWRITE } from '../ai/operations.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { toIngredientDto } from '../ingredients/ingredients.service.js';
import { toRecipeDto } from '../recipes/recipes.service.js';
import { PersonalRecipesService } from '../recipes/personal-recipes.service.js';
import {
  rewriteSwapModeA,
  rewriteSwapModeB,
  validateModeBOutput,
  type ModeBRewriter,
  type RecipeLocaleSlice,
} from './swap-rewrite.js';
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

type WeeklyTarget = '0.25' | '0.5' | '0.75' | '1.0' | null;

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
 * Meal-plan generation, retrieval and swapping. Generation is fully
 * deterministic: it calls the optimiser engine, never AI. AI-assisted variants
 * are layered on top later via the AI module.
 */
@Injectable()
export class MealPlansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiRouterService,
    private readonly personalRecipes: PersonalRecipesService,
  ) {}

  /** Deterministically generate and persist a meal plan. */
  async generate(userId: string, locale: Locale, req: GeneratePlanRequest): Promise<MealPlan> {
    const profile = await this.loadProfile(userId, req.profileId);
    const baseCalorieTarget = req.calorieTargetOverride ?? this.calorieTargetFor(profile);
    const dietType = req.dietType ?? profile.dietType;
    const baseMealCount = req.mealCount ?? profile.mealCount;

    const start = new Date(req.startDate);
    // Resolve a per-day descriptor (slot set, calorie target, locks, skip,
    // cook-time budget, use-up-by) by layering req.dayOverrides over the plan
    // defaults. Validates override dates + locked-slot membership.
    const resolvedDays = resolvePlanDays({
      startDate: start,
      durationDays: req.durationDays,
      defaultMealCount: baseMealCount,
      defaultCalorieTarget: baseCalorieTarget,
      dayOverrides: req.dayOverrides,
    });

    // Deterministic seed: count of existing plans → "regenerate" yields variety.
    const seed = await this.prisma.mealPlan.count({ where: { profileId: profile.id } });
    const result = await this.optimiseFor(userId, profile, {
      days: resolvedDays,
      dietType,
      mealPrepFriendly: req.mealPrepFriendly,
      respectExclusions: req.respectExclusions,
      respectFavorites: req.respectFavorites,
      respectInventory: req.respectInventory,
      maxRepeatsPerRecipe: req.maxRepeatsPerRecipe,
      seed,
    });

    const plan = await this.prisma.mealPlan.create({
      data: {
        profileId: profile.id,
        startDate: start,
        durationDays: req.durationDays,
        dietType,
        calorieTarget: baseCalorieTarget,
        generationMode: 'deterministic',
        reuseScore: result.ingredientReuseScore,
        maxRepeatsPerRecipe: req.maxRepeatsPerRecipe ?? null,
        days: { create: buildDays(resolvedDays, result.assignments) },
      },
    });
    return this.get(userId, locale, plan.id);
  }

  /**
   * Re-run the optimiser for an existing plan, in place. Picks up any profile
   * changes (calorie target, diet type) and yields a fresh set of meals.
   */
  async regenerate(
    userId: string,
    locale: Locale,
    planId: string,
    options: RegenerateRequest = { dropIneligibleLocks: false },
  ): Promise<MealPlan> {
    const existing = await this.prisma.mealPlan.findUnique({
      where: { id: planId },
      include: { profile: true, days: { include: { meals: true }, orderBy: { date: 'asc' } } },
    });
    if (!existing?.profile) throw new NotFoundException({ error: 'PLAN_NOT_FOUND', message: 'Meal plan not found.' });
    if (existing.profile.userId !== userId) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Plan belongs to another user.' });
    }

    const profile = await this.loadProfile(userId, existing.profileId);
    // Picks up profile changes (calorie target, diet) for non-overridden days,
    // while re-applying each day's persisted overrides (meal count, per-day
    // calorie target, locks, skip, cook-time budget, use-up-by).
    const baseCalorieTarget = this.calorieTargetFor(profile);
    const resolvedDays: ResolvedDay[] = existing.days.map((day) => {
      const o = parseDayOverrides(day.overrides);
      // Custom meals don't define a slot count — count catalogue meals only.
      const catalogueCount = day.meals.filter((m) => m.source === 'CATALOGUE').length;
      const mealCount = o?.mealCount ?? (catalogueCount || profile.mealCount);
      return {
        date: day.date,
        isoDate: isoDate(day.date),
        mealSlots: MEAL_SLOTS_BY_COUNT[mealCount] ?? MEAL_SLOTS_BY_COUNT[3]!,
        calorieTarget: o?.calorieTarget ?? dayTypeCalorieTarget(baseCalorieTarget, o?.dayType),
        cookTimeBudgetMinutes: o?.cookTimeBudgetMinutes,
        lockedSlots: o?.lockedSlots?.map((l) => ({ slot: l.mealType, recipeId: l.recipeId })),
        useUpBy: o?.useUpBy ?? false,
        skip: o?.skip ?? false,
        overrides: o,
      };
    });

    const result = await this.optimiseFor(userId, profile, {
      days: resolvedDays,
      dietType: profile.dietType,
      mealPrepFriendly: false,
      maxRepeatsPerRecipe: existing.maxRepeatsPerRecipe ?? undefined,
      dropIneligibleLocks: options.dropIneligibleLocks,
      seed: Date.now(),
    });

    await writePlan(this.prisma, planId, existing.revision, async (tx) => {
      await tx.mealPlanDay.deleteMany({ where: { planId } });
      await tx.mealPlan.update({
        where: { id: planId },
        data: {
          calorieTarget: baseCalorieTarget,
          dietType: profile.dietType,
          reuseScore: result.ingredientReuseScore,
          days: { create: buildDays(resolvedDays, result.assignments) },
        },
      });
    });
    return this.get(userId, locale, planId);
  }

  /** Re-roll the meals of a single day, leaving the rest of the plan untouched. */
  async regenerateDay(
    userId: string,
    locale: Locale,
    planId: string,
    dayId: string,
    options: RegenerateRequest = { dropIneligibleLocks: false },
  ): Promise<MealPlan> {
    const day = await this.prisma.mealPlanDay.findUnique({
      where: { id: dayId },
      include: { plan: { include: { profile: true } }, meals: true },
    });
    if (!day?.plan?.profile || day.planId !== planId) {
      throw new NotFoundException({ error: 'DAY_NOT_FOUND', message: 'Plan day not found.' });
    }
    if (day.plan.profile.userId !== userId) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Plan belongs to another user.' });
    }

    const profile = await this.loadProfile(userId, day.plan.profileId);
    const o = parseDayOverrides(day.overrides);

    // A skipped day re-rolls to nothing — clear its meals and return.
    if (o?.skip) {
      await writePlan(this.prisma, planId, day.plan.revision, async (tx) => {
        await tx.plannedMeal.deleteMany({ where: { dayId } });
      });
      return this.get(userId, locale, planId);
    }

    const catalogueCount = day.meals.filter((m) => m.source === 'CATALOGUE').length;
    const mealCount = o?.mealCount ?? (catalogueCount || profile.mealCount);
    const resolved: ResolvedDay = {
      date: day.date,
      isoDate: isoDate(day.date),
      mealSlots: MEAL_SLOTS_BY_COUNT[mealCount] ?? MEAL_SLOTS_BY_COUNT[3]!,
      calorieTarget: day.calorieTarget,
      cookTimeBudgetMinutes: o?.cookTimeBudgetMinutes,
      lockedSlots: o?.lockedSlots?.map((l) => ({ slot: l.mealType, recipeId: l.recipeId })),
      useUpBy: o?.useUpBy ?? false,
      skip: false,
      overrides: o,
    };

    const result = await this.optimiseFor(userId, profile, {
      days: [resolved],
      dietType: day.plan.dietType,
      mealPrepFriendly: false,
      maxRepeatsPerRecipe: day.plan.maxRepeatsPerRecipe ?? undefined,
      dropIneligibleLocks: options.dropIneligibleLocks,
      seed: Date.now(),
    });

    await writePlan(this.prisma, planId, day.plan.revision, async (tx) => {
      // A lock that was dropped leaves the stored overrides of the day as well.
      if (options.dropIneligibleLocks) {
        await tx.mealPlanDay.update({
          where: { id: dayId },
          data: { overrides: resolved.overrides ? (resolved.overrides as Prisma.InputJsonValue) : Prisma.JsonNull },
        });
      }
      await tx.plannedMeal.deleteMany({ where: { dayId } });
      await tx.plannedMeal.createMany({
        data: result.assignments
          .filter((a) => a.dayIndex === 0)
          .map((a) => ({ dayId, recipeId: a.recipeId, mealType: a.slot, servings: a.servings })),
      });
    });
    return this.get(userId, locale, planId);
  }

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
    await this.prisma.mealPlan.delete({ where: { id: planId } });
  }

  /** Daily calorie target for a profile (a manual override wins, see the engine). */
  private calorieTargetFor(
    profile: Omit<CalorieEngineInput, 'weeklyLossTarget'> & { weeklyLossTarget: string | null },
  ): number {
    return calculateCalories({
      age: profile.age,
      sex: profile.sex,
      heightCm: profile.heightCm,
      weightKg: profile.weightKg,
      activityLevel: profile.activityLevel,
      dietType: profile.dietType,
      weeklyLossTarget: profile.weeklyLossTarget as WeeklyTarget,
      manualCalorieTarget: profile.manualCalorieTarget,
    }).dailyTarget;
  }

  /**
   * Run the deterministic optimiser for a profile against the eligible recipes.
   * Takes a fully-resolved per-day descriptor list (slot set + calorie
   * target + locks + skip + cook-time budget + use-up-by per day); the basic
   * flow is just a list of uniform days.
   */
  private async optimiseFor(
    ownerUserId: string,
    profile: {
      id: string;
      preferences:
        | {
            allergens: string[];
            excludedIngredientIds: string[];
            favoriteIngredientIds: string[];
            maxConsecutiveDaysSameMeal: number;
            maxTimesPerWeekSameMeal: number;
          }
        | null;
    },
    opts: {
      days: ResolvedDay[];
      dietType: MealPlan['dietType'];
      mealPrepFriendly: boolean;
      /** Honour the avoid-list (default true). Allergens are always respected. */
      respectExclusions?: boolean;
      /** Pass favourite-ingredient ids to the optimiser bias (default true). */
      respectFavorites?: boolean;
      /** Pantry-aware bias toggle (default true). */
      respectInventory?: boolean;
      /** Variety floor — max total uses of any recipe across the window. */
      maxRepeatsPerRecipe?: number;
      /**
       * Take a lock that may not enter the plan out of the day, and out of the
       * overrides stored with it, instead of refusing.
       */
      dropIneligibleLocks?: boolean;
      seed: number;
    },
  ): Promise<OptimizerResult> {
    const { optimizerRecipes, requirementsByRecipe } = await this.loadEligibleRecipes(ownerUserId, profile, {
      respectExclusions: opts.respectExclusions,
    });

    // A lock pins a recipe to a slot, and a pinned recipe passes the same gate
    // as any other: it has to be among the recipes this profile may be given,
    // for that meal, on this diet.
    const recipeById = new Map(optimizerRecipes.map((r) => [r.id, r]));
    for (const day of opts.days) {
      for (const lock of [...(day.lockedSlots ?? [])]) {
        const recipe = recipeById.get(lock.recipeId);
        if (!recipe || !recipe.mealTypes.includes(lock.slot) || !fitsDiet(recipe.dietTags, opts.dietType)) {
          if (opts.dropIneligibleLocks) {
            dropLock(day, lock);
            continue;
          }
          throw new BadRequestException({
            error: 'LOCKED_RECIPE_INELIGIBLE',
            message: `The recipe locked for ${lock.slot} on ${day.isoDate} cannot go into this plan: it is unavailable, or the profile's diet, allergens, skipped ingredients or avoided recipes rule it out.`,
            date: day.isoDate,
            slot: lock.slot,
            recipeId: lock.recipeId,
          });
        }
      }
    }

    const favoriteIngredientIds =
      opts.respectFavorites === false
        ? undefined
        : new Set(profile.preferences?.favoriteIngredientIds ?? []);
    const inventoryCoverage = await this.resolveInventoryBias(
      profile.id,
      opts.respectInventory !== false,
      optimizerRecipes,
      requirementsByRecipe,
    );

    // Use-up-by: build a per-date coverage map for each flagged day, scored
    // only against stock expiring by that date. Falls back to the plan-level map.
    const expiringByDate = new Map<string, ReadonlyMap<string, number>>();
    if (opts.respectInventory !== false) {
      const dates = [...new Set(opts.days.filter((d) => d.useUpBy && !d.skip).map((d) => d.isoDate))];
      for (const iso of dates) {
        const map = await this.expiringCoverageForDate(profile.id, new Date(iso), requirementsByRecipe);
        if (map) expiringByDate.set(iso, map);
      }
    }

    // When mealPrepFriendly is set on the request, relax the profile's caps
    // up to a generous baseline (4 consecutive days, 5 occurrences/week) —
    // the user is asking for cook-once-eat-many, so honour their intent even
    // if their profile defaults skew strict.
    const profileCons = profile.preferences?.maxConsecutiveDaysSameMeal ?? 2;
    const profileWeek = profile.preferences?.maxTimesPerWeekSameMeal ?? 3;
    const maxConsecutiveDaysSameMeal = opts.mealPrepFriendly
      ? Math.max(profileCons, 4)
      : profileCons;
    const maxTimesPerWeekSameMeal = opts.mealPrepFriendly
      ? Math.max(profileWeek, 5)
      : profileWeek;

    const days: OptimizerDay[] = opts.days.map((d) => ({
      mealSlots: d.mealSlots,
      dailyCalorieTarget: d.calorieTarget,
      cookTimeBudgetMinutes: d.cookTimeBudgetMinutes,
      lockedSlots: d.lockedSlots,
      inventoryCoverage: d.useUpBy ? expiringByDate.get(d.isoDate) : undefined,
      skip: d.skip,
    }));

    try {
      return optimisePlan({
        recipes: optimizerRecipes,
        days,
        targetMacros: { protein: 0, fat: 0, carbs: 0 },
        dietType: opts.dietType,
        mealPrepFriendly: opts.mealPrepFriendly,
        favoriteIngredientIds,
        inventoryCoverage,
        maxConsecutiveDaysSameMeal,
        maxTimesPerWeekSameMeal,
        maxRepeatsPerRecipe: opts.maxRepeatsPerRecipe,
        seed: opts.seed,
      });
    } catch (err) {
      // The optimiser throws when a (slot × diet) combination has no eligible
      // recipe. Surface that as a 400 with the missing slot named, instead of
      // a generic 500.
      if (err instanceof OptimizerError) {
        throw new BadRequestException({
          error: 'NO_ELIGIBLE_RECIPE',
          message: `${err.message}. Try a different diet, fewer meals per day, or relax the allergen/exclusion filters.`,
        });
      }
      throw err;
    }
  }

  /**
   * Use-up-by: per-recipe coverage scored only against inventory expiring on
   * or before `date`. Steers a flagged day toward recipes that consume
   * soon-to-expire stock. Returns null when nothing qualifies. Unlike the
   * plan-level bias it does not touch the anti-monotony streak — it's an
   * explicit per-day request, not the rotation-governed default.
   */
  private async expiringCoverageForDate(
    profileId: string,
    date: Date,
    requirementsByRecipe: Map<string, Array<{ ingredientId: string; canonicalQuantity: number }>>,
  ): Promise<Map<string, number> | null> {
    const items = await this.prisma.inventoryItem.findMany({
      where: { profileId, bestBefore: { not: null, lte: date } },
      include: { ingredient: { select: { canonicalUnit: true, gramsPerPiece: true, density: true } } },
    });
    if (items.length === 0) return null;

    const pantryStock = new Map<string, number>();
    for (const item of items) {
      try {
        const canonical = toCanonical(item.quantity, item.unit, item.ingredient);
        pantryStock.set(item.ingredientId, (pantryStock.get(item.ingredientId) ?? 0) + canonical);
      } catch (err) {
        if (!(err instanceof UnitConversionError)) throw err;
      }
    }
    if (pantryStock.size === 0) return null;

    const coverage = new Map<string, number>();
    for (const [recipeId, reqs] of requirementsByRecipe) {
      const score = recipeCoverage(reqs, pantryStock);
      if (score > 0) coverage.set(recipeId, score);
    }
    return coverage.size === 0 ? null : coverage;
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
    const { revision } = await this.get(userId, locale, planId);

    const restore = req.restore;
    if (restore && restore.length > 0) {
      await writePlan(this.prisma, planId, revision, (tx) => this.restoreScales(planId, restore, tx));
      return this.buildRebalanceResult(userId, locale, planId, req.scope, null);
    }

    if (req.scope === 'week') {
      const summary = await writePlan(this.prisma, planId, revision, (tx) =>
        this.rebalanceWeekInternal(planId, tx),
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
  ): Promise<RebalanceResult> {
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

    // Build the variant's ingredient lines + load full ingredient rows for
    // nutrition / fingerprint. Allergens become whatever the new line carries
    // — the swapped-out ingredient might have been the only source of a given
    // allergen, so recompute from scratch.
    const allIds = new Set(recipe.ingredients.map((i) => i.ingredientId));
    allIds.delete(req.fromIngredientId);
    allIds.add(req.toIngredientId);
    const ingredientRows = await this.prisma.ingredient.findMany({
      where: { id: { in: [...allIds] } },
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

    // Build per-locale translation slices for the variant. Mode B (AI
    // sentence rewrite) when the user's AI is available + quota OK; falls
    // back to Mode A on per-locale validator rejection or AI unavailability.
    // Mode A directly when the user is on `aiMode: 'none'` (no provider
    // call ever leaves the instance).
    const variantTranslations = await this.buildVariantTranslations(
      userId,
      recipe.translations,
      ingredientById.get(req.fromIngredientId),
      ingredientById.get(req.toIngredientId),
    );
    // The recipe row carries the English text: the variant's, or the source's
    // where the source has no English translation row.
    const text = new Map<string, RecipeLocaleSlice>(variantTranslations);
    if (!text.has('en')) text.set('en', { title: recipe.title, description: recipe.description, steps: recipe.steps });

    // Stored as the user's own recipe, or recognised as one that exists
    // already. A shared recipe the profile avoids is not handed back for it.
    const variantId = await this.personalRecipes.save(
      {
        userId,
        origin: 'user',
        text,
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
    return this.buildRebalanceResult(userId, locale, req.planId, 'day', summary);
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
    sourceTranslations: { locale: string; title: string; description: string; steps: string[] }[],
    oldIngredient: { name: string; translations: { locale: string; name: string }[] } | undefined,
    newIngredient: { name: string; translations: { locale: string; name: string }[] } | undefined,
  ): Promise<Map<Locale, RecipeLocaleSlice>> {
    const localeOptions = LocaleEnum.options;
    const sourceSlices = new Map<Locale, RecipeLocaleSlice>();
    for (const tr of sourceTranslations) {
      if (!localeOptions.includes(tr.locale as Locale)) continue;
      sourceSlices.set(tr.locale as Locale, {
        title: tr.title,
        description: tr.description,
        steps: tr.steps,
      });
    }
    const oldNames = nameByLocale(oldIngredient);
    const newNames = nameByLocale(newIngredient);

    // Decide on Mode B per request: only when the user has chosen a non-none
    // aiMode. Quota / provider-chain failures inside the AI call surface as a
    // null Rewriter return → per-locale Mode A fallback. We never block the
    // user's swap on an AI hiccup.
    const aiUser = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { aiMode: true },
    });
    const useModeB = aiUser?.aiMode && aiUser.aiMode !== 'none';
    if (!useModeB) {
      return rewriteSwapModeA({
        source: sourceSlices,
        oldName: oldNames,
        newName: newNames,
      });
    }
    const rewriter: ModeBRewriter = async (locale, slice) => {
      return this.aiRewriteSwapSentences(userId, locale, slice);
    };
    return rewriteSwapModeB({
      source: sourceSlices,
      oldName: oldNames,
      newName: newNames,
      rewrite: rewriter,
    });
  }

  /**
   * One AI call per locale: ask the model to rewrite `description + steps` so
   * the prose matches the new ingredient. The model must return JSON in the
   * shape `{description, steps}`; everything is validated by
   * `validateModeBOutput` before the caller decides to splice. Returns null
   * on any failure — caller will Mode-A this locale.
   */
  private async aiRewriteSwapSentences(
    userId: string,
    locale: Locale,
    source: { description: string; steps: string[]; oldName: string; newName: string },
  ): Promise<{ description: string; steps: string[] } | null> {
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

    let text: string | null;
    try {
      const result = await this.ai.chat(
        userId,
        [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        SWAP_REWRITE,
        true,
      );
      text = result.text;
    } catch {
      return null;
    }
    if (!text) return null;
    const parsed = parseSwapRewritePayload(text);
    if (!parsed) return null;
    return validateModeBOutput(source, parsed) ? parsed : null;
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

  private async loadProfile(userId: string, profileId: string) {
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
    const dayRows = plan.days.map((d) => ({ target: d.calorieTarget, rows: d.meals.map(toRebalanceRow) }));
    const allRows = dayRows.flatMap((d) => d.rows);
    const macrosBefore = rowsMacros(allRows, (r) => r.quantityScale);
    const { scales, feasibility } = rebalanceWeek(
      dayRows.map((d) => ({ target: d.target, meals: d.rows.map(toEngineMeal) })),
    );
    const changes = await this.persistScales(allRows, scales, tx);
    const macrosAfter = rowsMacros(allRows, (r) => scales.get(r.id) ?? r.quantityScale);
    return { feasibility, changes, macrosBefore, macrosAfter };
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
   * Load recipes compatible with a profile's allergens / exclusions and map
   * them to optimiser input. Diet-type filtering happens inside the optimiser.
   * Allergens are always honoured; the soft exclusion list can be skipped via
   * `respectExclusions: false` for one-off plans.
   */
  private async loadEligibleRecipes(
    ownerUserId: string,
    profile: {
      id: string;
      preferences:
        | { allergens: string[]; excludedIngredientIds: string[]; favoriteIngredientIds: string[] }
        | null;
    },
    options: { respectExclusions?: boolean } = {},
  ): Promise<{
    optimizerRecipes: OptimizerRecipe[];
    /**
     * Per-recipe canonical-unit ingredient requirements, used by pantry-coverage
     * scoring. Rows whose unit conversion fails (missing density / gramsPerPiece)
     * are dropped from the requirement list — they can't be compared against
     * pantry stock, so treating them as "not covered" is the safe default.
     */
    requirementsByRecipe: Map<string, Array<{ ingredientId: string; canonicalQuantity: number }>>;
  }> {
    const allergens = profile.preferences?.allergens ?? [];
    const excluded =
      options.respectExclusions === false
        ? new Set<string>()
        : new Set(profile.preferences?.excludedIngredientIds ?? []);

    // Candidate pool is the public/curated library plus the requesting user's
    // own non-deleted recipes — never another user's private (user/AI_USER)
    // rows, which the optimiser would otherwise be free to embed into this
    // user's plan and leak through the plan view. Mirrors the visibility filter
    // used by the recipe list and the meal-swap candidate query.
    const recipes = await this.prisma.recipe.findMany({
      where: {
        deletedAt: null,
        retiredAt: null,
        OR: [{ createdByUserId: null }, { createdByUserId: ownerUserId }],
      },
      include: {
        ingredients: {
          include: {
            ingredient: { select: { canonicalUnit: true, gramsPerPiece: true, density: true } },
          },
        },
      },
    });
    // A favourite is a recipe the profile has an opinion on: "avoid" keeps it
    // out of every plan, anything else makes the optimiser lean towards it.
    const favorites = await this.prisma.favorite.findMany({
      where: { profileId: profile.id },
      select: { recipeId: true, sentiment: true },
    });
    const avoidedIds = new Set(favorites.filter((f) => f.sentiment === 'avoid').map((f) => f.recipeId));
    const favoriteIds = new Set(favorites.filter((f) => f.sentiment !== 'avoid').map((f) => f.recipeId));

    const filteredRecipes = recipes
      .filter((r) => !avoidedIds.has(r.id))
      .filter((r) => !r.allergens.some((a) => allergens.includes(a)))
      .filter((r) => !r.ingredients.some((i) => excluded.has(i.ingredientId)));

    const optimizerRecipes: OptimizerRecipe[] = filteredRecipes.map((r) => ({
      id: r.id,
      mealTypes: r.mealTypes as MealType[],
      dietTags: r.dietTags,
      caloriesPerServing: r.caloriesPerServing,
      proteinPerServing: r.proteinPerServing,
      fatPerServing: r.fatPerServing,
      carbsPerServing: r.carbsPerServing,
      ingredientIds: r.ingredients.map((i) => i.ingredientId),
      difficulty: r.difficulty,
      isFavorite: favoriteIds.has(r.id),
      totalMinutes: r.prepMinutes + r.cookMinutes,
    }));

    const requirementsByRecipe = new Map<string, Array<{ ingredientId: string; canonicalQuantity: number }>>();
    for (const r of filteredRecipes) {
      const reqs: Array<{ ingredientId: string; canonicalQuantity: number }> = [];
      for (const ri of r.ingredients) {
        try {
          const canonical = toCanonical(ri.quantity, ri.unit, ri.ingredient);
          if (canonical > 0) reqs.push({ ingredientId: ri.ingredientId, canonicalQuantity: canonical });
        } catch (err) {
          if (!(err instanceof UnitConversionError)) throw err;
        }
      }
      requirementsByRecipe.set(r.id, reqs);
    }

    return { optimizerRecipes, requirementsByRecipe };
  }

  /**
   * Build the per-recipe coverage map the optimiser scores against.
   * Returns undefined when the toggle is off, the pantry is empty, or no
   * candidate recipe touches anything in the pantry — callers leave the
   * pool ordering / scoring untouched.
   *
   * Anti-monotony rotation: after `inventoryBiasResetEvery` consecutive
   * plan-level generations actually applied a bias, this round drops it and
   * resets the streak — keeps a leftover-heavy month from locking the user
   * into one recipe corridor. The counter only moves on plan-level paths
   * (this method is unused by swap, which uses `recipeCoverageMap` directly).
   * Threshold `0` disables the reset entirely.
   */
  private async resolveInventoryBias(
    profileId: string,
    respectInventory: boolean,
    optimizerRecipes: OptimizerRecipe[],
    requirementsByRecipe: Map<string, Array<{ ingredientId: string; canonicalQuantity: number }>>,
  ): Promise<Map<string, number> | undefined> {
    if (!respectInventory) return undefined;

    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: {
        inventoryBiasStreak: true,
        preferences: { select: { inventoryBiasResetEvery: true } },
      },
    });
    const threshold = profile?.preferences?.inventoryBiasResetEvery ?? 5;
    const currentStreak = profile?.inventoryBiasStreak ?? 0;
    // Anti-monotony cool-down: if the streak has reached the threshold, skip
    // the bias for THIS round and reset. `threshold === 0` opts out entirely.
    if (threshold > 0 && currentStreak >= threshold) {
      await this.prisma.profile.update({
        where: { id: profileId },
        data: { inventoryBiasStreak: 0 },
      });
      return undefined;
    }

    const items = await this.prisma.inventoryItem.findMany({
      where: { profileId },
      include: { ingredient: { select: { canonicalUnit: true, gramsPerPiece: true, density: true } } },
    });
    if (items.length === 0) return undefined;

    const pantryStock = new Map<string, number>();
    for (const item of items) {
      try {
        const canonical = toCanonical(item.quantity, item.unit, item.ingredient);
        pantryStock.set(item.ingredientId, (pantryStock.get(item.ingredientId) ?? 0) + canonical);
      } catch (err) {
        if (!(err instanceof UnitConversionError)) throw err;
      }
    }
    if (pantryStock.size === 0) return undefined;

    const coverage = new Map<string, number>();
    for (const r of optimizerRecipes) {
      const reqs = requirementsByRecipe.get(r.id) ?? [];
      const score = recipeCoverage(reqs, pantryStock);
      if (score > 0) coverage.set(r.id, score);
    }
    if (coverage.size === 0) return undefined;

    // Bias actually applied — bump the counter so the next round inches
    // closer to the reset. Threshold 0 disables the bookkeeping too.
    if (threshold > 0) {
      await this.prisma.profile.update({
        where: { id: profileId },
        data: { inventoryBiasStreak: currentStreak + 1 },
      });
    }
    return coverage;
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

    const inventoryRows = await this.prisma.inventoryItem.findMany({
      where: { profileId },
      include: { ingredient: { select: { canonicalUnit: true, gramsPerPiece: true, density: true } } },
    });
    if (inventoryRows.length === 0) return null;
    const pantryStock = new Map<string, number>();
    for (const item of inventoryRows) {
      try {
        const canonical = toCanonical(item.quantity, item.unit, item.ingredient);
        pantryStock.set(item.ingredientId, (pantryStock.get(item.ingredientId) ?? 0) + canonical);
      } catch (err) {
        if (!(err instanceof UnitConversionError)) throw err;
      }
    }
    if (pantryStock.size === 0) return null;

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
    for (const r of recipes) {
      const reqs: Array<{ ingredientId: string; canonicalQuantity: number }> = [];
      for (const ri of r.ingredients) {
        try {
          const canonical = toCanonical(ri.quantity, ri.unit, ri.ingredient);
          if (canonical > 0) reqs.push({ ingredientId: ri.ingredientId, canonicalQuantity: canonical });
        } catch (err) {
          if (!(err instanceof UnitConversionError)) throw err;
        }
      }
      result.set(r.id, recipeCoverage(reqs, pantryStock));
    }
    return result;
  }

  /**
   * Batch-score an arbitrary ingredient-id list by "is in the pantry".
   * Returns a boolean-ish [0, 1] score keyed by ingredient id: 1 when the
   * pantry has any stock of that ingredient, 0 otherwise. Used by AI-suggest
   * ingredient swap to bias candidates toward the pantry without doing a
   * full canonical-mass coverage calc.
   */
  private async ingredientPantryHit(
    profileId: string,
    ingredientIds: string[],
    respectInventory: boolean,
  ): Promise<Set<string> | null> {
    if (!respectInventory || ingredientIds.length === 0) return null;
    const rows = await this.prisma.inventoryItem.findMany({
      where: { profileId, ingredientId: { in: ingredientIds } },
      select: { ingredientId: true, quantity: true },
    });
    const hits = new Set<string>();
    for (const r of rows) {
      if (r.quantity > 0) hits.add(r.ingredientId);
    }
    return hits.size === 0 ? null : hits;
  }

  private toDto(plan: PlanWithRelations, locale: Locale, restrictions: Restrictions): MealPlan {
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
      return {
        id: day.id,
        date: isoDate(day.date),
        meals,
        dayNutrition,
        calorieTarget: day.calorieTarget,
        calorieDelta: dayNutrition.calories - day.calorieTarget,
        overrides: parseDayOverrides(day.overrides),
      };
    });

    const avg = days.length
      ? scaleNutrition(
          sumNutrition(days.map((d) => d.dayNutrition)),
          1 / days.length,
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
  revision: number;
  createdAt: Date;
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

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
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
 * Per-locale display name for an ingredient. Pulls from `IngredientTranslation`
 * rows for every locale present; falls back to the canonical English `name`
 * for the EN slot so EN always has a value even when no translation row exists.
 * Used by the swap-rewrite Mode A substitution.
 */
function nameByLocale(
  ingredient:
    | { name: string; translations: { locale: string; name: string }[] }
    | undefined,
): ReadonlyMap<Locale, string> {
  const out = new Map<Locale, string>();
  if (!ingredient) return out;
  const localeOptions = LocaleEnum.options;
  for (const tr of ingredient.translations) {
    if (localeOptions.includes(tr.locale as Locale)) {
      out.set(tr.locale as Locale, tr.name);
    }
  }
  if (!out.has('en')) out.set('en', ingredient.name);
  return out;
}

/**
 * Persisted per-day overrides. The resolved per-day calorie target lives in
 * the `MealPlanDay.calorieTarget` column (so swap, favorite-set apply and the
 * rebalancer read it unchanged); this JSON carries the raw advanced inputs + semantics needed to
 * re-roll the day and to render it. `calorieTarget` is stored here only when it
 * was an explicit override, so `regenerate` can pick up profile changes for
 * non-overridden days while preserving deliberate per-day targets.
 */
type DayOverridesJson = {
  mealCount?: number;
  calorieTarget?: number;
  dayType?: 'normal' | 'rest' | 'training';
  skip?: boolean;
  cookTimeBudgetMinutes?: number;
  useUpBy?: boolean;
  lockedSlots?: { mealType: MealType; recipeId: string }[];
};

/** A fully-resolved day: defaults merged with overrides, ready for the optimiser. */
interface ResolvedDay {
  date: Date;
  isoDate: string;
  mealSlots: MealType[];
  calorieTarget: number;
  cookTimeBudgetMinutes?: number;
  lockedSlots?: { slot: MealType; recipeId: string }[];
  useUpBy: boolean;
  skip: boolean;
  /** The JSON to persist on the day row (null = basic-flow day). */
  overrides: DayOverridesJson | null;
}

/** Narrow a Prisma JSON column to the day-overrides shape (null when absent). */
function parseDayOverrides(raw: unknown): DayOverridesJson | null {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as DayOverridesJson;
  }
  return null;
}

/** Collapse a request `DayOverride` into the persisted JSON (only set keys). */
function buildOverridesJson(o: DayOverride | undefined): DayOverridesJson | null {
  if (!o) return null;
  const out: DayOverridesJson = {};
  if (o.mealCount !== undefined) out.mealCount = o.mealCount;
  if (o.calorieTarget !== undefined) out.calorieTarget = o.calorieTarget;
  if (o.dayType !== undefined) out.dayType = o.dayType;
  if (o.skip !== undefined) out.skip = o.skip;
  if (o.cookTimeBudgetMinutes !== undefined) out.cookTimeBudgetMinutes = o.cookTimeBudgetMinutes;
  if (o.useUpBy !== undefined) out.useUpBy = o.useUpBy;
  if (o.lockedSlots !== undefined) out.lockedSlots = o.lockedSlots;
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Resolve every day in `[startDate, +durationDays)` by layering the request's
 * sparse `dayOverrides` over the plan defaults. Validates that override dates fall
 * inside the plan range and that each locked slot belongs to its day's slot set.
 */
function resolvePlanDays(input: {
  startDate: Date;
  durationDays: number;
  defaultMealCount: number;
  defaultCalorieTarget: number;
  dayOverrides?: DayOverride[];
}): ResolvedDay[] {
  const dates = Array.from({ length: input.durationDays }, (_, i) => addDays(input.startDate, i));
  const validIso = new Set(dates.map(isoDate));
  const byDate = new Map<string, DayOverride>();
  for (const o of input.dayOverrides ?? []) {
    if (!validIso.has(o.date)) {
      throw new BadRequestException({
        error: 'OVERRIDE_DATE_OUT_OF_RANGE',
        message: `Day override date ${o.date} is outside the plan range.`,
      });
    }
    byDate.set(o.date, o);
  }

  return dates.map((date) => {
    const iso = isoDate(date);
    const o = byDate.get(iso);
    const mealCount = o?.mealCount ?? input.defaultMealCount;
    const mealSlots = MEAL_SLOTS_BY_COUNT[mealCount] ?? MEAL_SLOTS_BY_COUNT[3]!;
    const lockedSlots = o?.lockedSlots?.map((l) => ({ slot: l.mealType, recipeId: l.recipeId }));

    for (const lock of lockedSlots ?? []) {
      if (!mealSlots.includes(lock.slot)) {
        throw new BadRequestException({
          error: 'INVALID_LOCKED_SLOT',
          message: `Locked slot ${lock.slot} is not part of the ${mealCount}-meal day ${iso}.`,
        });
      }
    }

    return {
      date,
      isoDate: iso,
      mealSlots,
      // An explicit per-day calorie override wins; otherwise a rest/training tag
      // shifts the base target (training surplus / rest deficit). Plain days use
      // the base unchanged.
      calorieTarget: o?.calorieTarget ?? dayTypeCalorieTarget(input.defaultCalorieTarget, o?.dayType),
      cookTimeBudgetMinutes: o?.cookTimeBudgetMinutes,
      lockedSlots,
      useUpBy: o?.useUpBy ?? false,
      skip: o?.skip ?? false,
      overrides: buildOverridesJson(o),
    };
  });
}

/** Nested `days.create` payload from resolved days + optimiser assignments. */
function buildDays(
  resolved: ResolvedDay[],
  assignments: { dayIndex: number; slot: string; recipeId: string; servings: number }[],
) {
  return resolved.map((d, dayIndex) => ({
    date: d.date,
    calorieTarget: d.calorieTarget,
    ...(d.overrides
      ? { overrides: d.overrides as import('@prisma/client').Prisma.InputJsonValue }
      : {}),
    meals: {
      create: assignments
        .filter((a) => a.dayIndex === dayIndex)
        .map((a) => ({ recipeId: a.recipeId, mealType: a.slot, servings: a.servings })),
    },
  }));
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Take one lock out of a day that is about to be planned, and out of the
 * overrides that are stored with the day, so that it does not come back at the
 * next re-roll. Overrides left with nothing in them are stored as none.
 */
function dropLock(day: ResolvedDay, lock: { slot: MealType; recipeId: string }): void {
  day.lockedSlots = (day.lockedSlots ?? []).filter((kept) => kept !== lock);
  if (!day.overrides) return;
  const kept = (day.overrides.lockedSlots ?? []).filter(
    (stored) => !(stored.mealType === lock.slot && stored.recipeId === lock.recipeId),
  );
  const next: DayOverridesJson = { ...day.overrides, lockedSlots: kept };
  if (kept.length === 0) delete next.lockedSlots;
  day.overrides = Object.keys(next).length > 0 ? next : null;
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

/** Read frozen, user-entered macros off a custom meal row (defaults to zero). */
function customMacros(raw: unknown): { calories: number; protein: number; fat: number; carbs: number } {
  const o = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    calories: num(o.calories),
    protein: num(o.protein),
    fat: num(o.fat),
    carbs: num(o.carbs),
  };
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
