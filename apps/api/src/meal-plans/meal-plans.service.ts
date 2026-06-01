import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  MEAL_SLOTS_BY_COUNT,
  type AiSwapMealRequest,
  type AiSwapMealResponse,
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
  fitServings,
  nutritionFor,
  optimisePlan,
  OptimizerError,
  slotBudgets,
  substituteIngredient,
  toCanonical,
  type CalorieEngineInput,
  type EngineIngredient,
  type OptimizerRecipe,
} from '../engine/index.js';
import { AiRouterService } from '../ai/ai-router.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { toRecipeDto } from '../recipes/recipes.service.js';

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
  ) {}

  /** Deterministically generate and persist a meal plan. */
  async generate(userId: string, locale: Locale, req: GeneratePlanRequest): Promise<MealPlan> {
    const profile = await this.loadProfile(userId, req.profileId);
    const calorieTarget = req.calorieTargetOverride ?? this.calorieTargetFor(profile);
    const dietType = req.dietType ?? profile.dietType;
    const mealCount = req.mealCount ?? profile.mealCount;

    // Deterministic seed: count of existing plans → "regenerate" yields variety.
    const seed = await this.prisma.mealPlan.count({ where: { profileId: profile.id } });
    const result = await this.optimiseFor(profile, {
      days: req.durationDays,
      mealCount,
      calorieTarget,
      dietType,
      mealPrepFriendly: req.mealPrepFriendly,
      respectExclusions: req.respectExclusions,
      respectFavorites: req.respectFavorites,
      seed,
    });

    const start = new Date(req.startDate);
    const plan = await this.prisma.mealPlan.create({
      data: {
        profileId: profile.id,
        startDate: start,
        durationDays: req.durationDays,
        dietType,
        calorieTarget,
        generationMode: 'deterministic',
        reuseScore: result.ingredientReuseScore,
        days: { create: buildDays(start, req.durationDays, calorieTarget, result.assignments) },
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
    const calorieTarget = this.calorieTargetFor(profile);
    const mealCount = existing.days[0]?.meals.length ?? profile.mealCount;
    const result = await this.optimiseFor(profile, {
      days: existing.durationDays,
      mealCount,
      calorieTarget,
      dietType: profile.dietType,
      mealPrepFriendly: false,
      seed: Date.now(),
    });

    await this.prisma.$transaction([
      this.prisma.mealPlanDay.deleteMany({ where: { planId } }),
      this.prisma.mealPlan.update({
        where: { id: planId },
        data: {
          calorieTarget,
          dietType: profile.dietType,
          reuseScore: result.ingredientReuseScore,
          days: { create: buildDays(existing.startDate, existing.durationDays, calorieTarget, result.assignments) },
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
    const result = await this.optimiseFor(profile, {
      days: 1,
      mealCount: day.meals.length || profile.mealCount,
      calorieTarget: day.calorieTarget,
      dietType: day.plan.dietType,
      mealPrepFriendly: false,
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

  /** Run the deterministic optimiser for a profile against the eligible recipes. */
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
      days: number;
      mealCount: number;
      calorieTarget: number;
      dietType: MealPlan['dietType'];
      mealPrepFriendly: boolean;
      /** Honour the avoid-list (default true). Allergens are always respected. */
      respectExclusions?: boolean;
      /** Pass favourite-ingredient ids to the optimiser bias (default true). */
      respectFavorites?: boolean;
      seed: number;
    },
  ) {
    const mealSlots = MEAL_SLOTS_BY_COUNT[opts.mealCount] ?? MEAL_SLOTS_BY_COUNT[3]!;
    const { optimizerRecipes } = await this.loadEligibleRecipes(profile, {
      respectExclusions: opts.respectExclusions,
    });
    const favoriteIngredientIds =
      opts.respectFavorites === false
        ? undefined
        : new Set(profile.preferences?.favoriteIngredientIds ?? []);
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
    try {
      return optimisePlan({
        recipes: optimizerRecipes,
        days: opts.days,
        mealSlots,
        dailyCalorieTarget: opts.calorieTarget,
        targetMacros: { protein: 0, fat: 0, carbs: 0 },
        dietType: opts.dietType,
        mealPrepFriendly: opts.mealPrepFriendly,
        favoriteIngredientIds,
        maxConsecutiveDaysSameMeal,
        maxTimesPerWeekSameMeal,
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
      // would have wiped the pool.
      const candidates = await this.prisma.recipe.findMany({
        where: { dietTags: { has: dietType }, mealTypes: { has: meal.mealType }, id: { not: meal.recipeId } },
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
        where: { dietTags: { has: dietType }, mealTypes: { has: meal.mealType }, id: { not: meal.recipeId } },
        select: { id: true },
      });
      if (candidates.length === 0) {
        throw new NotFoundException({ error: 'NO_ALTERNATIVE', message: 'No alternative recipe found.' });
      }
      const fresh = candidates.filter((c) => !excludeBeforeReset.has(c.id));
      const pool = fresh.length > 0 ? fresh : candidates;
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
    // and slot filter mirror the deterministic swapMeal pool exactly.
    const candidates = await this.prisma.recipe.findMany({
      where: {
        dietTags: { has: dietType },
        mealTypes: { has: meal.mealType },
        id: { not: meal.recipeId },
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
    const pool = freshCandidates.length > 0 ? freshCandidates : candidates;

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
      include: { ingredients: true },
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

    // Build the variant's ingredient lines. Allergens become whatever the new
    // line carries — the swapped-out ingredient might have been the only source
    // of a given allergen, so we recompute from scratch.
    const allIds = new Set(recipe.ingredients.map((i) => i.ingredientId));
    allIds.delete(req.fromIngredientId);
    allIds.add(req.toIngredientId);
    const ingredientRows = await this.prisma.ingredient.findMany({
      where: { id: { in: [...allIds] } },
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

    const replacementName = ingredientById.get(req.toIngredientId)?.name ?? 'substitute';
    const variant = await this.prisma.recipe.create({
      data: {
        title: `${recipe.title} (with ${replacementName})`,
        description: recipe.description,
        servings: recipe.servings,
        mealTypes: recipe.mealTypes,
        dietTags: recipe.dietTags,
        steps: recipe.steps,
        prepMinutes: recipe.prepMinutes,
        cookMinutes: recipe.cookMinutes,
        difficulty: recipe.difficulty,
        allergens: variantAllergens,
        origin: 'user',
        createdByUserId: userId,
        caloriesPerServing: perServing.calories,
        proteinPerServing: perServing.protein,
        fatPerServing: perServing.fat,
        carbsPerServing: perServing.carbs,
        reuseScore: recipe.reuseScore,
        ingredients: { create: variantIngredients },
      },
    });

    await this.prisma.plannedMeal.update({
      where: { id: req.plannedMealId },
      data: { recipeId: variant.id },
    });
    return this.get(userId, locale, req.planId);
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
  ): Promise<{ optimizerRecipes: OptimizerRecipe[] }> {
    const allergens = profile.preferences?.allergens ?? [];
    const excluded =
      options.respectExclusions === false
        ? new Set<string>()
        : new Set(profile.preferences?.excludedIngredientIds ?? []);

    const recipes = await this.prisma.recipe.findMany({ include: { ingredients: true } });
    const favorites = await this.prisma.favorite.findMany({
      where: { profileId: profile.id },
      select: { recipeId: true },
    });
    const favoriteIds = new Set(favorites.map((f) => f.recipeId));

    const optimizerRecipes: OptimizerRecipe[] = recipes
      .filter((r) => !r.allergens.some((a) => allergens.includes(a)))
      .filter((r) => !r.ingredients.some((i) => excluded.has(i.ingredientId)))
      .map((r) => ({
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
      }));

    return { optimizerRecipes };
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

/** Nested `days.create` payload from a run of optimiser assignments. */
function buildDays(
  start: Date,
  durationDays: number,
  calorieTarget: number,
  assignments: { dayIndex: number; slot: string; recipeId: string; servings: number }[],
) {
  return Array.from({ length: durationDays }, (_, dayIndex) => ({
    date: addDays(start, dayIndex),
    calorieTarget,
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
