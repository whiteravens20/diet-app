import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Locale as LocaleEnum,
  MEAL_SLOTS_BY_COUNT,
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
  type SwapIngredientRequest,
  type SwapMealRequest,
  type SwapPreview,
} from '@diet-app/shared';
import {
  calculateCalories,
  dayTypeCalorieTarget,
  fitServings,
  nutritionFor,
  optimisePlan,
  OptimizerError,
  recipeCoverage,
  slotBudgets,
  substituteIngredient,
  toCanonical,
  UnitConversionError,
  type CalorieEngineInput,
  type EngineIngredient,
  type OptimizerDay,
  type OptimizerRecipe,
  type OptimizerResult,
} from '../engine/index.js';
import { AiRouterService } from '../ai/ai-router.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { toIngredientDto } from '../ingredients/ingredients.service.js';
import { toRecipeDto } from '../recipes/recipes.service.js';
import { DedupService } from '../admin/drafts/dedup.js';
import {
  computeFingerprint,
  FingerprintError,
  type FingerprintIngredientLookup,
} from '../admin/drafts/fingerprint.js';
import {
  rewriteSwapModeA,
  rewriteSwapModeB,
  validateModeBOutput,
  type ModeBRewriter,
  type RecipeLocaleSlice,
} from './swap-rewrite.js';

type WeeklyTarget = '0.25' | '0.5' | '0.75' | '1.0' | null;

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
    private readonly dedup: DedupService,
  ) {}

  /** Deterministically generate and persist a meal plan. */
  async generate(userId: string, locale: Locale, req: GeneratePlanRequest): Promise<MealPlan> {
    const profile = await this.loadProfile(userId, req.profileId);
    const baseCalorieTarget = req.calorieTargetOverride ?? this.calorieTargetFor(profile);
    const dietType = req.dietType ?? profile.dietType;
    const baseMealCount = req.mealCount ?? profile.mealCount;

    const start = new Date(req.startDate);
    // F17: resolve a per-day descriptor (slot set, calorie target, locks, skip,
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
    const result = await this.optimiseFor(profile, {
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
  async regenerate(userId: string, locale: Locale, planId: string): Promise<MealPlan> {
    const existing = await this.prisma.mealPlan.findUnique({
      where: { id: planId },
      include: { profile: true, days: { include: { meals: true }, orderBy: { date: 'asc' } } },
    });
    if (!existing) throw new NotFoundException({ error: 'PLAN_NOT_FOUND', message: 'Meal plan not found.' });
    if (existing.profile.userId !== userId) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Plan belongs to another user.' });
    }

    const profile = await this.loadProfile(userId, existing.profileId);
    // Picks up profile changes (calorie target, diet) for non-overridden days,
    // while re-applying each day's persisted F17 overrides (meal count, per-day
    // calorie target, locks, skip, cook-time budget, use-up-by).
    const baseCalorieTarget = this.calorieTargetFor(profile);
    const resolvedDays: ResolvedDay[] = existing.days.map((day) => {
      const o = parseDayOverrides(day.overrides);
      const mealCount = o?.mealCount ?? (day.meals.length || profile.mealCount);
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

    const result = await this.optimiseFor(profile, {
      days: resolvedDays,
      dietType: profile.dietType,
      mealPrepFriendly: false,
      maxRepeatsPerRecipe: existing.maxRepeatsPerRecipe ?? undefined,
      seed: Date.now(),
    });

    await this.prisma.$transaction([
      this.prisma.mealPlanDay.deleteMany({ where: { planId } }),
      this.prisma.mealPlan.update({
        where: { id: planId },
        data: {
          calorieTarget: baseCalorieTarget,
          dietType: profile.dietType,
          reuseScore: result.ingredientReuseScore,
          days: { create: buildDays(resolvedDays, result.assignments) },
        },
      }),
    ]);
    return this.get(userId, locale, planId);
  }

  /** Re-roll the meals of a single day, leaving the rest of the plan untouched. */
  async regenerateDay(userId: string, locale: Locale, planId: string, dayId: string): Promise<MealPlan> {
    const day = await this.prisma.mealPlanDay.findUnique({
      where: { id: dayId },
      include: { plan: { include: { profile: true } }, meals: true },
    });
    if (!day || day.planId !== planId) {
      throw new NotFoundException({ error: 'DAY_NOT_FOUND', message: 'Plan day not found.' });
    }
    if (day.plan.profile.userId !== userId) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Plan belongs to another user.' });
    }

    const profile = await this.loadProfile(userId, day.plan.profileId);
    const o = parseDayOverrides(day.overrides);

    // A skipped day re-rolls to nothing — clear its meals and return.
    if (o?.skip) {
      await this.prisma.plannedMeal.deleteMany({ where: { dayId } });
      return this.get(userId, locale, planId);
    }

    const mealCount = o?.mealCount ?? (day.meals.length || profile.mealCount);
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

    const result = await this.optimiseFor(profile, {
      days: [resolved],
      dietType: day.plan.dietType,
      mealPrepFriendly: false,
      maxRepeatsPerRecipe: day.plan.maxRepeatsPerRecipe ?? undefined,
      seed: Date.now(),
    });

    await this.prisma.$transaction([
      this.prisma.plannedMeal.deleteMany({ where: { dayId } }),
      this.prisma.plannedMeal.createMany({
        data: result.assignments
          .filter((a) => a.dayIndex === 0)
          .map((a) => ({ dayId, recipeId: a.recipeId, mealType: a.slot, servings: a.servings })),
      }),
    ]);
    return this.get(userId, locale, planId);
  }

  /** Delete a plan and everything under it (days, meals, shopping lists cascade). */
  async remove(userId: string, planId: string): Promise<void> {
    const plan = await this.prisma.mealPlan.findUnique({
      where: { id: planId },
      include: { profile: true },
    });
    if (!plan) throw new NotFoundException({ error: 'PLAN_NOT_FOUND', message: 'Meal plan not found.' });
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
   * Takes a fully-resolved F17 per-day descriptor list (slot set + calorie
   * target + locks + skip + cook-time budget + use-up-by per day); the basic
   * flow is just a list of uniform days.
   */
  private async optimiseFor(
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
      /** F15 pantry-aware bias toggle (default true). */
      respectInventory?: boolean;
      /** F17 variety floor — max total uses of any recipe across the window. */
      maxRepeatsPerRecipe?: number;
      seed: number;
    },
  ): Promise<OptimizerResult> {
    const { optimizerRecipes, requirementsByRecipe } = await this.loadEligibleRecipes(profile, {
      respectExclusions: opts.respectExclusions,
    });

    // F17 validate locked slots against the eligible recipe set. (Slot-membership
    // was already checked when the day list was resolved.)
    const recipeById = new Map(optimizerRecipes.map((r) => [r.id, r]));
    for (const day of opts.days) {
      for (const lock of day.lockedSlots ?? []) {
        const recipe = recipeById.get(lock.recipeId);
        if (!recipe) {
          throw new NotFoundException({
            error: 'LOCKED_RECIPE_NOT_FOUND',
            message: `Locked recipe not found or not eligible: ${lock.recipeId}`,
          });
        }
        const eligibleForSlot =
          recipe.mealTypes.includes(lock.slot) &&
          (opts.dietType === 'custom' || recipe.dietTags.includes(opts.dietType));
        if (!eligibleForSlot) {
          throw new BadRequestException({
            error: 'LOCKED_RECIPE_INELIGIBLE',
            message: `Locked recipe ${lock.recipeId} is not valid for ${lock.slot} on this diet.`,
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

    // F15 use-up-by: build a per-date coverage map for each flagged day, scored
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
   * F15 use-up-by: per-recipe coverage scored only against inventory expiring on
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
        profile: true,
      },
    });
    if (!plan) throw new NotFoundException({ error: 'PLAN_NOT_FOUND', message: 'Meal plan not found.' });
    if (plan.profile.userId !== userId) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Plan belongs to another user.' });
    }
    return this.toDto(plan, locale);
  }

  /** Swap a planned meal for a random / favorite alternative; applies immediately. */
  async swapMeal(userId: string, locale: Locale, req: SwapMealRequest): Promise<MealPlan> {
    const meal = await this.loadPlannedMeal(userId, req.planId, req.plannedMealId);
    const dietType = meal.day.plan.dietType;

    // History of recipes already shown for THIS slot (across previous swaps),
    // plus the currently displayed recipe. The picker excludes the union so
    // repeated clicks advance through fresh candidates instead of cycling
    // between two. `applyHistory` is the array we persist back to the row.
    const prevHistory = meal.swapHistory ?? [];
    const excludeBeforeReset = new Set<string>([meal.recipeId, ...prevHistory]);

    let replacementId: string;
    let nextHistory: string[];

    if (req.strategy === 'favorite') {
      if (!req.favoriteRecipeId) {
        throw new NotFoundException({ error: 'NO_FAVORITE', message: 'favoriteRecipeId required.' });
      }
      // Explicit user pick — bypass exclusion logic but still record it so a
      // subsequent random swap doesn't immediately resurface it.
      replacementId = req.favoriteRecipeId;
      nextHistory = appendUnique(prevHistory, meal.recipeId);
    } else if (req.strategy === 'favorite_ingredients') {
      const favIngs = meal.day.plan.profile.preferences?.favoriteIngredientIds ?? [];
      if (favIngs.length === 0) {
        throw new BadRequestException({
          error: 'NO_FAVORITE_INGREDIENTS',
          message: 'Add favourite ingredients on the profile before swapping by them.',
        });
      }
      // Score all candidates that match the slot + diet (excluding current
      // recipe only); we apply the swap-history filter after scoring so the
      // user always gets a relevant fav-ingredient match even when history
      // would have wiped the pool. Visibility filter mirrors the public
      // recipe library — curated rows + the user's own non-deleted recipes
      // only. Without it the picker could land on another user's private
      // AI draft which the recipe-detail page would 404 on.
      const candidates = await this.prisma.recipe.findMany({
        where: {
          dietTags: { has: dietType },
          mealTypes: { has: meal.mealType },
          id: { not: meal.recipeId },
          deletedAt: null,
          OR: [{ createdByUserId: null }, { createdByUserId: userId }],
        },
        select: { id: true, ingredients: { select: { ingredientId: true } } },
      });
      const favSet = new Set(favIngs);
      const scored = candidates
        .map((c) => ({ id: c.id, hits: c.ingredients.filter((i) => favSet.has(i.ingredientId)).length }))
        .filter((c) => c.hits > 0)
        .sort((a, b) => b.hits - a.hits || a.id.localeCompare(b.id));
      if (scored.length === 0) {
        throw new NotFoundException({
          error: 'NO_FAVORITE_INGREDIENT_MATCH',
          message: 'No recipe in this slot uses any of your favourite ingredients.',
        });
      }
      // First-choice pool: top-scoring AND not yet shown in this slot.
      const topHits = scored[0]!.hits;
      const top = scored.filter((c) => c.hits === topHits);
      const fresh = top.filter((c) => !excludeBeforeReset.has(c.id));
      const pool = fresh.length > 0 ? fresh : top;
      // history advances the seed so consecutive picks vary even when pool
      // composition stays the same.
      const idx = hashIndex(`${req.plannedMealId}:${prevHistory.length}`, pool.length);
      replacementId = pool[idx]!.id;
      nextHistory =
        fresh.length > 0
          ? appendUnique(prevHistory, meal.recipeId)
          : // Pool wrapped — reset history to just the recipe leaving the slot
            // so the next swap sees the previously-shown options as fresh again.
            [meal.recipeId];
    } else {
      const candidates = await this.prisma.recipe.findMany({
        where: {
          dietTags: { has: dietType },
          mealTypes: { has: meal.mealType },
          id: { not: meal.recipeId },
          deletedAt: null,
          OR: [{ createdByUserId: null }, { createdByUserId: userId }],
        },
        select: { id: true },
      });
      if (candidates.length === 0) {
        throw new NotFoundException({ error: 'NO_ALTERNATIVE', message: 'No alternative recipe found.' });
      }
      const fresh = candidates.filter((c) => !excludeBeforeReset.has(c.id));
      let pool = fresh.length > 0 ? fresh : candidates;
      // F15 re-rank by pantry coverage descending so an inventory-friendly
      // random swap is picked when the user opted in. hashIndex on a stable
      // order still rotates through the pool so consecutive clicks vary —
      // but consistently among high-coverage candidates first.
      const coverage = await this.recipeCoverageMap(
        meal.day.plan.profileId,
        pool.map((c) => c.id),
        req.respectInventory !== false,
      );
      if (coverage) {
        pool = [...pool].sort((a, b) => {
          const diff = (coverage.get(b.id) ?? 0) - (coverage.get(a.id) ?? 0);
          return diff !== 0 ? diff : a.id.localeCompare(b.id);
        });
      }
      // Same seed-advance trick as above.
      const idx = hashIndex(`${req.plannedMealId}:${prevHistory.length}`, pool.length);
      replacementId = pool[idx]!.id;
      nextHistory =
        fresh.length > 0 ? appendUnique(prevHistory, meal.recipeId) : [meal.recipeId];
    }

    // Rescale servings so the swap stays close to the slot's calorie budget.
    // Without this, swapping a 100 kcal/serving recipe for a 200 kcal one
    // would double the meal's calories at the same servings count.
    const replacement = await this.prisma.recipe.findUniqueOrThrow({
      where: { id: replacementId },
      select: { caloriesPerServing: true },
    });
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

    await this.prisma.plannedMeal.update({
      where: { id: req.plannedMealId },
      data: { recipeId: replacementId, servings, swapHistory: nextHistory },
    });
    return this.get(userId, locale, req.planId);
  }

  /**
   * AI-ranked meal swap (F20). The engine builds a deterministic candidate pool
   * (same diet+slot filter as the random strategy) and AI picks one. If AI is
   * unavailable (quota / no provider / total provider failure) OR the model
   * returns an id that isn't in the pool, the engine falls back to the same
   * hash-indexed pick the random strategy uses — so the user always gets a
   * swap. The `aiMeta.fallbackReason` field tells the UI whether to surface
   * the localised "AI didn't run" toast.
   */
  async aiSwapMeal(
    userId: string,
    locale: Locale,
    req: AiSwapMealRequest,
  ): Promise<AiSwapMealResponse> {
    const meal = await this.loadPlannedMeal(userId, req.planId, req.plannedMealId);
    const dietType = meal.day.plan.dietType;
    const prevHistory = meal.swapHistory ?? [];
    const excludeBeforeReset = new Set<string>([meal.recipeId, ...prevHistory]);

    // Capped at 25 — keeps the prompt small enough for cheap models. Diet-tag
    // and slot filter mirror the deterministic swapMeal pool exactly,
    // including the visibility gate (no other users' private rows, no
    // soft-deleted variants).
    const candidates = await this.prisma.recipe.findMany({
      where: {
        dietTags: { has: dietType },
        mealTypes: { has: meal.mealType },
        id: { not: meal.recipeId },
        deletedAt: null,
        OR: [{ createdByUserId: null }, { createdByUserId: userId }],
      },
      select: {
        id: true,
        title: true,
        caloriesPerServing: true,
        proteinPerServing: true,
        fatPerServing: true,
        carbsPerServing: true,
        ingredients: {
          select: { ingredient: { select: { name: true } } },
          take: 6,
        },
      },
      take: 25,
    });
    if (candidates.length === 0) {
      throw new NotFoundException({ error: 'NO_ALTERNATIVE', message: 'No alternative recipe found.' });
    }

    const freshCandidates = candidates.filter((c) => !excludeBeforeReset.has(c.id));
    let pool = freshCandidates.length > 0 ? freshCandidates : candidates;
    // F15 sort the pool by pantry coverage descending so the AI sees pantry-
    // friendly recipes first AND the deterministic fallback (hashIndex on
    // pool order) prefers them. Coverage is null when the toggle is off or
    // the pantry is empty — pool stays in its original order.
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
      where: { id: meal.recipeId },
      select: { title: true, caloriesPerServing: true },
    });

    const prompt = buildSwapPrompt({
      slot: meal.mealType as MealType,
      budget,
      currentTitle: current.title,
      currentKcal: Math.round(current.caloriesPerServing),
      candidates: pool,
      hint: req.hint,
    });
    const { text, meta } = await this.ai.chat(
      userId,
      [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      'meal-swap',
      true,
    );

    const fallbackPick = (): string => {
      const idx = hashIndex(`${req.plannedMealId}:${prevHistory.length}`, pool.length);
      return pool[idx]!.id;
    };

    let replacementId: string;
    if (text) {
      const aiPick = parseAiRecipePick(text);
      replacementId = aiPick && pool.some((c) => c.id === aiPick) ? aiPick : fallbackPick();
    } else {
      replacementId = fallbackPick();
    }

    const nextHistory =
      freshCandidates.length > 0 ? appendUnique(prevHistory, meal.recipeId) : [meal.recipeId];

    const replacement = pool.find((c) => c.id === replacementId)!;
    const servings = fitServings(replacement.caloriesPerServing, budget);

    await this.prisma.plannedMeal.update({
      where: { id: req.plannedMealId },
      data: { recipeId: replacementId, servings, swapHistory: nextHistory },
    });
    const plan = await this.get(userId, locale, req.planId);
    return { plan, aiMeta: meta };
  }

  /**
   * Preview an ingredient substitution inside a planned meal's recipe. Returns
   * the calorie/macro delta; the caller confirms before persisting a variant.
   */
  async previewIngredientSwap(userId: string, req: SwapIngredientRequest): Promise<SwapPreview> {
    const meal = await this.loadPlannedMeal(userId, req.planId, req.plannedMealId);
    const recipe = await this.prisma.recipe.findUniqueOrThrow({
      where: { id: meal.recipeId },
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
  async applyIngredientSwap(userId: string, locale: Locale, req: SwapIngredientRequest): Promise<MealPlan> {
    const meal = await this.loadPlannedMeal(userId, req.planId, req.plannedMealId);
    const recipe = await this.prisma.recipe.findUniqueOrThrow({
      where: { id: meal.recipeId },
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

    // Recompute per-serving nutrition from the canonical DB — the engine, not
    // the user, owns nutrition numbers.
    const totals = variantIngredients.reduce(
      (acc, ri) => {
        const ing = ingredientById.get(ri.ingredientId);
        if (!ing) return acc;
        const engineIng: EngineIngredient = {
          id: ing.id,
          name: ing.name,
          category: ing.category,
          canonicalUnit: ing.canonicalUnit,
          gramsPerPiece: ing.gramsPerPiece,
          density: ing.density,
          caloriesPer100: ing.caloriesPer100,
          proteinPer100: ing.proteinPer100,
          fatPer100: ing.fatPer100,
          carbsPer100: ing.carbsPer100,
          allergens: ing.allergens as EngineIngredient['allergens'],
          dietCompatibility: ing.dietCompatibility as EngineIngredient['dietCompatibility'],
        };
        const canonical = toCanonical(ri.quantity, ri.unit, engineIng);
        const n = nutritionFor(canonical, {
          calories: ing.caloriesPer100,
          protein: ing.proteinPer100,
          fat: ing.fatPer100,
          carbs: ing.carbsPer100,
        });
        return {
          calories: acc.calories + n.calories,
          protein: acc.protein + n.protein,
          fat: acc.fat + n.fat,
          carbs: acc.carbs + n.carbs,
        };
      },
      { calories: 0, protein: 0, fat: 0, carbs: 0 },
    );
    const perServing = {
      calories: Math.round(totals.calories / recipe.servings),
      protein: Math.round(totals.protein / recipe.servings),
      fat: Math.round(totals.fat / recipe.servings),
      carbs: Math.round(totals.carbs / recipe.servings),
    };

    const variantAllergens = Array.from(
      new Set(
        variantIngredients.flatMap((ri) => ingredientById.get(ri.ingredientId)?.allergens ?? []),
      ),
    );

    // Fingerprint dedup — see admin/drafts/fingerprint.ts + dedup.ts. The
    // transaction below holds an advisory lock on the fingerprint so two
    // racing swaps producing the same variant serialise: the loser hits the
    // existing draft instead of inserting a duplicate.
    const fingerprintLookup: FingerprintIngredientLookup = new Map(
      ingredientRows
        .filter((i): i is typeof i & { slug: string } => i.slug !== null)
        .map((i) => [
          i.slug,
          {
            canonicalUnit: i.canonicalUnit,
            gramsPerPiece: i.gramsPerPiece,
            density: i.density,
          },
        ]),
    );
    let fingerprint: string | null;
    const fingerprintLines = variantIngredients.map((vi) => {
      const ing = ingredientById.get(vi.ingredientId)!;
      return { slug: ing.slug, quantity: vi.quantity, unit: vi.unit };
    });
    const allSlugsResolved = fingerprintLines.every(
      (l): l is typeof l & { slug: string } => l.slug !== null,
    );
    if (allSlugsResolved) {
      try {
        fingerprint = computeFingerprint(
          {
            ingredients: fingerprintLines as { slug: string; quantity: number; unit: typeof fingerprintLines[number]['unit'] }[],
            mealTypes: recipe.mealTypes,
            dietTags: recipe.dietTags,
            servings: recipe.servings,
          },
          fingerprintLookup,
        );
      } catch (err) {
        if (err instanceof FingerprintError) {
          // Don't block the swap on a fingerprint failure — write the variant
          // without a fingerprint and skip the dedup path. The user still
          // gets their swap; we just can't dedup this one.
          fingerprint = null;
        } else {
          throw err;
        }
      }
    } else {
      // At least one ingredient lacks a slug (legacy or imported row). Skip
      // dedup; variant still gets written with no fingerprint.
      fingerprint = null;
    }

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
    const enSlice = variantTranslations.get('en');
    const variantTitle = enSlice?.title ?? recipe.title;
    const variantDescription = enSlice?.description ?? recipe.description;
    const variantSteps = enSlice?.steps ?? recipe.steps;

    const variantId = await this.persistVariantWithDedup({
      userId,
      fingerprint,
      title: variantTitle,
      description: variantDescription,
      steps: variantSteps,
      translations: variantTranslations,
      sourceRecipe: recipe,
      variantIngredients,
      variantAllergens,
      perServing,
    });

    await this.prisma.plannedMeal.update({
      where: { id: req.plannedMealId },
      data: { recipeId: variantId },
    });
    return this.get(userId, locale, req.planId);
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
      `Write entirely in ${locale === 'pl' ? 'Polish' : 'English'}; do not switch language. ` +
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
        'swap-rewrite',
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
   * Write the variant Recipe (+ RecipeTranslation rows) inside an advisory-
   * locked transaction so concurrent swaps producing the same fingerprint
   * serialise. Returns the resolved recipe id — either the existing curated /
   * user / draft-attached row or a newly created variant.
   */
  private async persistVariantWithDedup(input: {
    userId: string;
    fingerprint: string | null;
    title: string;
    description: string;
    steps: string[];
    translations: Map<Locale, RecipeLocaleSlice>;
    sourceRecipe: {
      mealTypes: string[];
      dietTags: string[];
      servings: number;
      prepMinutes: number;
      cookMinutes: number;
      difficulty: 'easy' | 'medium' | 'hard';
      reuseScore: number;
    };
    variantIngredients: { ingredientId: string; quantity: number; unit: 'g' | 'ml' | 'piece'; note: string | null }[];
    variantAllergens: string[];
    perServing: { calories: number; protein: number; fat: number; carbs: number };
  }): Promise<string> {
    const writeFresh = async (
      tx:
        | import('@prisma/client').Prisma.TransactionClient
        | PrismaService,
    ): Promise<string> => {
      const variant = await tx.recipe.create({
        data: {
          title: input.title,
          description: input.description,
          servings: input.sourceRecipe.servings,
          mealTypes: input.sourceRecipe.mealTypes,
          dietTags: input.sourceRecipe.dietTags,
          steps: input.steps,
          prepMinutes: input.sourceRecipe.prepMinutes,
          cookMinutes: input.sourceRecipe.cookMinutes,
          difficulty: input.sourceRecipe.difficulty,
          allergens: input.variantAllergens,
          origin: 'user',
          createdByUserId: input.userId,
          fingerprint: input.fingerprint,
          caloriesPerServing: input.perServing.calories,
          proteinPerServing: input.perServing.protein,
          fatPerServing: input.perServing.fat,
          carbsPerServing: input.perServing.carbs,
          reuseScore: input.sourceRecipe.reuseScore,
          ingredients: { create: input.variantIngredients },
        },
      });
      // RecipeTranslation rows for every locale we generated a slice for.
      for (const [locale, slice] of input.translations) {
        await tx.recipeTranslation.create({
          data: {
            recipeId: variant.id,
            locale,
            title: slice.title,
            description: slice.description,
            steps: slice.steps,
            source: 'MANUAL',
          },
        });
      }
      return variant.id;
    };

    if (!input.fingerprint) {
      // No fingerprint available (rare: missing canonical-unit info). Just
      // write the variant; no dedup possible.
      return writeFresh(this.prisma);
    }
    const fingerprint = input.fingerprint;

    return this.dedup.withFingerprintLock(fingerprint, async (tx) => {
      // 1. Curated short-circuit.
      const curated = await this.dedup.findCuratedByFingerprint(tx, fingerprint);
      if (curated) return curated.id;
      // 2. This user's own existing variant.
      const userOwn = await this.dedup.findUserRecipeByFingerprint(
        tx,
        fingerprint,
        input.userId,
      );
      if (userOwn) return userOwn.id;
      // Write the variant first; then either attach to an existing draft or
      // create a new AI_USER draft.
      const newRecipeId = await writeFresh(tx);
      const existingDraft = await this.dedup.findDraftByFingerprint(
        tx,
        fingerprint,
      );
      if (existingDraft) {
        await this.dedup.attachRecipeToDraft(tx, existingDraft.id, newRecipeId);
      } else {
        await this.createAiUserDraft(tx, {
          fingerprint,
          recipeId: newRecipeId,
          createdByUserId: input.userId,
          title: input.title,
          description: input.description,
          steps: input.steps,
          translations: input.translations,
          servings: input.sourceRecipe.servings,
          mealTypes: input.sourceRecipe.mealTypes,
          dietTags: input.sourceRecipe.dietTags,
          prepMinutes: input.sourceRecipe.prepMinutes,
          cookMinutes: input.sourceRecipe.cookMinutes,
          difficulty: input.sourceRecipe.difficulty,
          allergens: input.variantAllergens,
          ingredients: input.variantIngredients,
          perServing: input.perServing,
        });
      }
      return newRecipeId;
    });
  }

  /**
   * Insert the AI_USER `RecipeDraft` row that mirrors the just-written
   * personal variant. Translation polish + curated promotion happen later via
   * the admin/reviewer surface (Phase I.6 / I.7).
   */
  private async createAiUserDraft(
    tx: import('@prisma/client').Prisma.TransactionClient,
    input: {
      fingerprint: string;
      recipeId: string;
      createdByUserId: string;
      title: string;
      description: string;
      steps: string[];
      translations: Map<Locale, RecipeLocaleSlice>;
      servings: number;
      mealTypes: string[];
      dietTags: string[];
      prepMinutes: number;
      cookMinutes: number;
      difficulty: 'easy' | 'medium' | 'hard';
      allergens: string[];
      ingredients: { ingredientId: string; quantity: number; unit: 'g' | 'ml' | 'piece'; note: string | null }[];
      perServing: { calories: number; protein: number; fat: number; carbs: number };
    },
  ): Promise<void> {
    const titles: Record<string, string> = {};
    const descriptions: Record<string, string> = {};
    const stepsByLocale: Record<string, string[]> = {};
    for (const [locale, slice] of input.translations) {
      titles[locale] = slice.title;
      descriptions[locale] = slice.description;
      stepsByLocale[locale] = slice.steps;
    }
    // Look up slug for each ingredient in the draft's ingredientsJson — the
    // curation queue + dedup chain key everything by slug, not by db id.
    const ingRows = await tx.ingredient.findMany({
      where: { id: { in: input.ingredients.map((i) => i.ingredientId) } },
      select: { id: true, slug: true },
    });
    const slugById = new Map(ingRows.map((r) => [r.id, r.slug]));
    await tx.recipeDraft.create({
      data: {
        slug: `swap-${input.recipeId.slice(0, 8)}`,
        titles,
        descriptions,
        steps: stepsByLocale,
        locales: Array.from(input.translations.keys()),
        servings: input.servings,
        mealTypes: input.mealTypes,
        dietTags: input.dietTags,
        prepMinutes: input.prepMinutes,
        cookMinutes: input.cookMinutes,
        difficulty: input.difficulty,
        complexity: 'medium',
        caloriesPerServing: input.perServing.calories,
        proteinPerServing: input.perServing.protein,
        fatPerServing: input.perServing.fat,
        carbsPerServing: input.perServing.carbs,
        allergens: input.allergens,
        ingredientsJson: input.ingredients.map((i) => ({
          slug: slugById.get(i.ingredientId) ?? '',
          quantity: i.quantity,
          unit: i.unit,
          note: i.note,
        })),
        status: 'PENDING',
        source: 'AI_USER',
        batchId: `user-swap-${input.createdByUserId.slice(0, 8)}-${Date.now()}`,
        fingerprint: input.fingerprint,
        sourceRecipeIds: [input.recipeId],
        createdByUserId: input.createdByUserId,
      },
    });
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
    const recipe = await this.prisma.recipe.findUniqueOrThrow({
      where: { id: meal.recipeId },
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
    const rawCandidates = await this.prisma.ingredient.findMany({
      where: {
        category: from.category,
        id: { notIn: [...excludedIds] },
        dietCompatibility: { has: dietType },
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
      take: 50,
    });
    let pool = rawCandidates
      .filter((c) => !c.allergens.some((a) => userAllergens.has(a)))
      .slice(0, 25);
    if (pool.length === 0) {
      throw new NotFoundException({
        error: 'NO_ALTERNATIVE',
        message: 'No alternative ingredient found.',
      });
    }
    // F15 surface pantry-friendly substitutes first. The AI sees them at the
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

    const prompt = buildIngredientSwapPrompt({
      currentName: from.name,
      currentCategory: from.category,
      currentKcalPer100: Math.round(from.caloriesPer100),
      candidates: pool,
      hint: req.hint,
    });
    const { text, meta } = await this.ai.chat(
      userId,
      [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      'ingredient-swap',
      true,
    );

    const fallbackPick = (): string => {
      const idx = hashIndex(`${req.plannedMealId}:${req.fromIngredientId}`, pool.length);
      return pool[idx]!.id;
    };

    let toIngredientId: string;
    if (text) {
      const aiPick = parseAiIngredientPick(text);
      toIngredientId = aiPick && pool.some((c) => c.id === aiPick) ? aiPick : fallbackPick();
    } else {
      toIngredientId = fallbackPick();
    }

    const locales = locale === 'en' ? ['en'] : [locale, 'en'];
    const toIngredient = await this.prisma.ingredient.findUniqueOrThrow({
      where: { id: toIngredientId },
      include: { translations: { where: { locale: { in: locales } } } },
    });
    return { toIngredient: toIngredientDto(toIngredient, locale), aiMeta: meta };
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

  private async loadPlannedMeal(userId: string, planId: string, plannedMealId: string) {
    const meal = await this.prisma.plannedMeal.findUnique({
      where: { id: plannedMealId },
      include: { day: { include: { plan: { include: { profile: { include: { preferences: true } } } } } } },
    });
    if (!meal || meal.day.planId !== planId) {
      throw new NotFoundException({ error: 'MEAL_NOT_FOUND', message: 'Planned meal not found.' });
    }
    if (meal.day.plan.profile.userId !== userId) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Plan belongs to another user.' });
    }
    return meal;
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
     * Per-recipe canonical-unit ingredient requirements, used by F15 coverage
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

    const recipes = await this.prisma.recipe.findMany({
      include: {
        ingredients: {
          include: {
            ingredient: { select: { canonicalUnit: true, gramsPerPiece: true, density: true } },
          },
        },
      },
    });
    const favorites = await this.prisma.favorite.findMany({
      where: { profileId: profile.id },
      select: { recipeId: true },
    });
    const favoriteIds = new Set(favorites.map((f) => f.recipeId));

    const filteredRecipes = recipes
      .filter((r) => !r.allergens.some((a) => allergens.includes(a)))
      .filter((r) => !r.ingredients.some((i) => excluded.has(i.ingredientId)));

    const optimizerRecipes: OptimizerRecipe[] = filteredRecipes.map((r) => ({
      id: r.id,
      mealTypes: r.mealTypes as MealType[],
      dietTags: r.dietTags as OptimizerRecipe['dietTags'],
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
   * F15 build the per-recipe coverage map the optimiser scores against.
   * Returns undefined when the toggle is off, the pantry is empty, or no
   * candidate recipe touches anything in the pantry — callers leave the
   * pool ordering / scoring untouched.
   *
   * F15.1 anti-monotony rotation: after `inventoryBiasResetEvery` consecutive
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
   * F15 batch-score an arbitrary recipe-id list by pantry coverage. Used by
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
   * F15 batch-score an arbitrary ingredient-id list by "is in the pantry".
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

  private toDto(plan: PlanWithRelations, locale: Locale): MealPlan {
    const days: MealPlanDay[] = plan.days.map((day) => {
      // Sort meals into canonical eating order — Prisma's row order is
      // undefined and shifts after updates, which would look like other meals
      // also changed.
      const orderedMeals = [...day.meals].sort((a, b) => mealRank(a.mealType) - mealRank(b.mealType));
      const meals: PlannedMeal[] = orderedMeals.map((m) => {
        const recipe = toRecipeDto(m.recipe, locale);
        const n = recipe.nutritionPerServing;
        return {
          id: m.id,
          mealType: m.mealType as MealType,
          recipe,
          servings: m.servings,
          nutrition: {
            calories: Math.round(n.calories * m.servings),
            protein: Math.round(n.protein * m.servings),
            fat: Math.round(n.fat * m.servings),
            carbs: Math.round(n.carbs * m.servings),
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
  createdAt: Date;
  days: {
    id: string;
    date: Date;
    calorieTarget: number;
    overrides: unknown;
    meals: { id: string; mealType: string; servings: number; recipe: Parameters<typeof toRecipeDto>[0] }[];
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
  const trimmed = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  const candidates: string[] = [];
  const braceMatch = trimmed.match(/\{[\s\S]*\}/);
  if (braceMatch) candidates.push(braceMatch[0]);
  candidates.push(trimmed);
  for (const c of candidates) {
    try {
      const raw = JSON.parse(c) as unknown;
      if (!raw || typeof raw !== 'object') continue;
      const o = raw as Record<string, unknown>;
      const description = typeof o.description === 'string' ? o.description.trim() : null;
      if (!description) continue;
      if (!Array.isArray(o.steps)) continue;
      const steps: string[] = [];
      let ok = true;
      for (const s of o.steps) {
        if (typeof s !== 'string' || s.trim().length === 0) {
          ok = false;
          break;
        }
        steps.push(s.trim());
      }
      if (!ok) continue;
      return { description, steps };
    } catch {
      // try next candidate
    }
  }
  return null;
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
 * F17 persisted per-day overrides. The resolved per-day calorie target lives in
 * the `MealPlanDay.calorieTarget` column (so swap / favorite-set apply / F22 read
 * it unchanged); this JSON carries the raw advanced inputs + semantics needed to
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
 * F17: resolve every day in `[startDate, +durationDays)` by layering the request's
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

function appendUnique(arr: readonly string[], value: string): string[] {
  return arr.includes(value) ? [...arr] : [...arr, value];
}

function hashIndex(key: string, modulo: number): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h = (h ^ key.charCodeAt(i)) * 16777619;
    h >>>= 0;
  }
  return h % modulo;
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
    'Respond with valid JSON exactly matching {"recipeId":"<id>"} — no prose, ' +
    'no markdown, no other keys.';

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
 * Pull a `recipeId` string out of the model's response. Tolerates a stray
 * markdown fence or surrounding prose — returns null if no usable id is
 * present, so the service can fall back deterministically.
 */
function parseAiRecipePick(text: string): string | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  const candidates: string[] = [];
  const braceMatch = trimmed.match(/\{[\s\S]*\}/);
  if (braceMatch) candidates.push(braceMatch[0]);
  candidates.push(trimmed);
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c) as unknown;
      if (parsed && typeof parsed === 'object' && 'recipeId' in parsed) {
        const id = (parsed as { recipeId: unknown }).recipeId;
        if (typeof id === 'string' && id.length > 0) return id;
      }
    } catch {
      // try next candidate
    }
  }
  return null;
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
}): { system: string; user: string } {
  const lines = input.candidates.map(
    (c) =>
      `- id=${c.id} | ${c.name} | ${Math.round(c.caloriesPer100)} kcal/100g · ${Math.round(c.proteinPer100)}P/${Math.round(c.fatPer100)}F/${Math.round(c.carbsPer100)}C`,
  );

  const system =
    'You rank ingredient-swap candidates for a deterministic meal-planning app. ' +
    'You never invent ingredients or macros — your only job is to pick the best ' +
    'id from the list provided. ' +
    'Respond with valid JSON exactly matching {"ingredientId":"<id>"} — no prose, ' +
    'no markdown, no other keys.';

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
 * Pull an `ingredientId` string out of the model's response. Tolerates a stray
 * markdown fence or surrounding prose — returns null if no usable id is
 * present, so the service can fall back deterministically.
 */
function parseAiIngredientPick(text: string): string | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  const candidates: string[] = [];
  const braceMatch = trimmed.match(/\{[\s\S]*\}/);
  if (braceMatch) candidates.push(braceMatch[0]);
  candidates.push(trimmed);
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c) as unknown;
      if (parsed && typeof parsed === 'object' && 'ingredientId' in parsed) {
        const id = (parsed as { ingredientId: unknown }).ingredientId;
        if (typeof id === 'string' && id.length > 0) return id;
      }
    } catch {
      // try next candidate
    }
  }
  return null;
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
