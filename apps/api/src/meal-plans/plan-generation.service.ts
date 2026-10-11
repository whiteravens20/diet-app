// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { BadRequestException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { Prisma } from '@prisma/client';
import {
  fitsDiet,
  MEAL_SLOTS_BY_COUNT,
  PlanOptions,
  type DayOverride,
  type GeneratePlanRequest,
  type Locale,
  type MealPlan,
  type MealType,
  type PlanRelaxation,
  type RegenerateRequest,
  type RelaxationNeeded,
  type UnfilledMeal,
} from '@diet-app/shared';
import {
  calculateCalories,
  effectiveDayTarget,
  optimisePlan,
  OptimizerError,
  recipeCoverage,
  requirementsPerServing,
  type CalorieEngineInput,
  type OptimizerDay,
  type OptimizerRecipe,
  type OptimizerResult,
} from '../engine/index.js';
import { stockByIngredient, stockExpiringBetween } from '../inventory/pantry-store.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { reportOf, StoredReport, withDaysAgain } from './generation-report.js';
import { MealPlansService } from './meal-plans.service.js';
import { isoDate, parseDayOverrides, type DayOverridesJson } from './plan-days.js';
import { writePlan } from './plan-write.js';

/**
 * Making a plan and making it again. Both are the deterministic optimiser's
 * work, never a model's: this service gathers what the optimiser is to choose
 * from and within which limits, and writes what it chose.
 */
@Injectable()
export class PlanGenerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: MealPlansService,
  ) {}

  /** Deterministically generate and persist a meal plan. */
  async generate(userId: string, locale: Locale, req: GeneratePlanRequest): Promise<MealPlan> {
    const profile = await this.plans.loadProfile(userId, req.profileId);
    // What was asked for stays with the plan; what was left to the profile is
    // kept as left to the profile.
    const options: PlanOptions = {
      dietType: req.dietType ?? null,
      mealCount: req.mealCount ?? null,
      calorieTargetOverride: req.calorieTargetOverride ?? null,
      mealPrepFriendly: req.mealPrepFriendly,
      respectExclusions: req.respectExclusions,
      respectFavorites: req.respectFavorites,
      respectInventory: req.respectInventory,
      maxRepeatsPerRecipe: req.maxRepeatsPerRecipe ?? null,
      allowRelaxations: req.allowRelaxations,
    };
    const base = this.planBase(profile, req.calorieTargetOverride);
    const baseCalorieTarget = base.target;
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
      base,
      dayOverrides: req.dayOverrides,
    });

    const seed = newSeed();
    const result = await this.optimiseFor(userId, profile, {
      days: resolvedDays,
      dietType,
      mealPrepFriendly: req.mealPrepFriendly,
      respectExclusions: req.respectExclusions,
      respectFavorites: req.respectFavorites,
      respectInventory: req.respectInventory,
      maxRepeatsPerRecipe: req.maxRepeatsPerRecipe,
      allowRelaxations: req.allowRelaxations,
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
        options,
        seed,
        report: result.report,
        days: { create: buildDays(resolvedDays, result.assignments) },
      },
    });
    return this.plans.get(userId, locale, plan.id);
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

    const profile = await this.plans.loadProfile(userId, existing.profileId);
    // The plan is made again as it was made: with what was asked for then,
    // with the profile as it is now for what was left to the profile, and
    // with what each day carries of its own (meal count, calorie target,
    // locks, skip, cooking time, use-up-by).
    const made = PlanOptions.parse(existing.options);
    const allowRelaxations = options.allowRelaxations ?? made.allowRelaxations;
    const base = this.planBase(profile, made.calorieTargetOverride ?? undefined);
    const baseCalorieTarget = base.target;
    const dietType = made.dietType ?? profile.dietType;
    const resolvedDays: ResolvedDay[] = existing.days.map((day) => {
      const o = parseDayOverrides(day.overrides);
      // Custom meals don't define a slot count — count catalogue meals only.
      const catalogueCount = day.meals.filter((m) => m.source === 'CATALOGUE').length;
      const mealCount = o?.mealCount ?? made.mealCount ?? (catalogueCount || profile.mealCount);
      return {
        date: day.date,
        isoDate: isoDate(day.date),
        mealSlots: MEAL_SLOTS_BY_COUNT[mealCount] ?? MEAL_SLOTS_BY_COUNT[3]!,
        calorieTarget: dayTarget(base, o),
        cookTimeBudgetMinutes: o?.cookTimeBudgetMinutes,
        lockedSlots: o?.lockedSlots?.map((l) => ({ slot: l.mealType, recipeId: l.recipeId })),
        useUpBy: o?.useUpBy ?? false,
        skip: o?.skip ?? false,
        overrides: o,
      };
    });

    const seed = newSeed();
    const result = await this.optimiseFor(userId, profile, {
      days: resolvedDays,
      dietType,
      mealPrepFriendly: made.mealPrepFriendly,
      respectExclusions: made.respectExclusions,
      respectFavorites: made.respectFavorites,
      respectInventory: made.respectInventory,
      maxRepeatsPerRecipe: made.maxRepeatsPerRecipe ?? undefined,
      allowRelaxations,
      dropIneligibleLocks: options.dropIneligibleLocks,
      seed,
    });

    await writePlan(this.prisma, planId, existing.revision, async (tx) => {
      await tx.mealPlanDay.deleteMany({ where: { planId } });
      await tx.mealPlan.update({
        where: { id: planId },
        data: {
          calorieTarget: baseCalorieTarget,
          dietType,
          reuseScore: result.ingredientReuseScore,
          // The limits the plan was made with this time are the ones it is made with from here on.
          options: { ...made, allowRelaxations },
          seed,
          report: result.report,
          days: { create: buildDays(resolvedDays, result.assignments) },
        },
      });
    });
    return this.plans.get(userId, locale, planId);
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

    const profile = await this.plans.loadProfile(userId, day.plan.profileId);
    const o = parseDayOverrides(day.overrides);

    // A skipped day re-rolls to nothing — clear its meals and return.
    if (o?.skip) {
      await writePlan(this.prisma, planId, day.plan.revision, async (tx) => {
        await tx.plannedMeal.deleteMany({ where: { dayId } });
      });
      return this.plans.get(userId, locale, planId);
    }

    const made = PlanOptions.parse(day.plan.options);
    const catalogueCount = day.meals.filter((m) => m.source === 'CATALOGUE').length;
    const mealCount = o?.mealCount ?? made.mealCount ?? (catalogueCount || profile.mealCount);
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
      mealPrepFriendly: made.mealPrepFriendly,
      respectExclusions: made.respectExclusions,
      respectFavorites: made.respectFavorites,
      respectInventory: made.respectInventory,
      maxRepeatsPerRecipe: made.maxRepeatsPerRecipe ?? undefined,
      // What is let give way for one day is let for this once: the plan keeps its own.
      allowRelaxations: options.allowRelaxations ?? made.allowRelaxations,
      dropIneligibleLocks: options.dropIneligibleLocks,
      seed: newSeed(),
    });
    const kept = StoredReport.nullable().parse(day.plan.report ?? null);

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
      // A plan from before reports were kept has none to bring up to date.
      if (kept) {
        await tx.mealPlan.update({ where: { id: planId }, data: { report: withDaysAgain(kept, result.report, [resolved.isoDate]) } });
      }
    });
    return this.plans.get(userId, locale, planId);
  }

  /**
   * The base target of a plan for this profile, and how it came about. A
   * target typed for the plan stands in for the one typed on the profile.
   */
  private planBase(
    profile: Omit<CalorieEngineInput, 'weeklyLossTarget' | 'riskAcknowledged'> & { weeklyLossTarget: string | null; riskAcknowledgedAt: Date | null },
    typedForThePlan?: number,
  ): PlanBase {
    const riskAcknowledged = profile.riskAcknowledgedAt !== null;
    const calories = calculateCalories({
      age: profile.age,
      sex: profile.sex,
      heightCm: profile.heightCm,
      weightKg: profile.weightKg,
      activityLevel: profile.activityLevel,
      dietType: profile.dietType,
      weeklyLossTarget: profile.weeklyLossTarget as WeeklyTarget,
      manualCalorieTarget: typedForThePlan ?? profile.manualCalorieTarget,
      riskAcknowledged,
    });
    const atRisk = calories.warnings.includes('minor') || calories.warnings.includes('underweight');
    return {
      target: calories.dailyTarget,
      // A goal that is held is planned as maintenance, which the engine worked out.
      calculated: calories.source === 'calculated' || calories.goalHeld,
      floor: calories.safetyFloor,
      holdUnder: atRisk && !riskAcknowledged ? calories.maintenance : null,
    };
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
      /** The limits that may give way when a meal cannot be filled inside them. */
      allowRelaxations: readonly PlanRelaxation[];
      /**
       * Take a lock that may not enter the plan out of the day, and out of the
       * overrides stored with it, instead of refusing.
       */
      dropIneligibleLocks?: boolean;
      seed: number;
    },
  ): Promise<{ assignments: OptimizerResult['assignments']; ingredientReuseScore: number; report: StoredReport }> {
    const { optimizerRecipes, requirementsByRecipe, beforeProfileRules } = await this.loadEligibleRecipes(ownerUserId, profile, {
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
            details: { date: day.isoDate, slot: lock.slot, recipeId: lock.recipeId },
          });
        }
      }
    }

    const favoriteIngredientIds =
      opts.respectFavorites === false
        ? undefined
        : new Set(profile.preferences?.favoriteIngredientIds ?? []);
    const pantry = await this.resolveInventoryBias(
      profile.id,
      opts.respectInventory !== false,
      optimizerRecipes,
      requirementsByRecipe,
    );
    const inventoryCoverage = pantry.coverage;

    // Use-up-by: build a per-date coverage map for each flagged day, scored
    // only against stock expiring by that date. Falls back to the plan-level map.
    const expiringByDate = new Map<string, ReadonlyMap<string, number>>();
    if (opts.respectInventory !== false) {
      const dates = [...new Set(opts.days.filter((d) => d.useUpBy && !d.skip).map((d) => d.isoDate))];
      // ISO dates sort as text.
      const planStart = new Date(opts.days.map((d) => d.isoDate).sort()[0]!);
      for (const iso of dates) {
        const map = await this.expiringCoverageForDate(profile.id, planStart, new Date(iso), requirementsByRecipe);
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

    const dates = opts.days.map((d) => d.isoDate);
    try {
      const result = optimisePlan({
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
        allowRelaxations: new Set(opts.allowRelaxations),
        seed: opts.seed,
      });
      // A plan that was refused is no round of the rotation: the count moves once the plan is filled.
      if (pantry.streak !== undefined) {
        await this.prisma.profile.update({ where: { id: profile.id }, data: { inventoryBiasStreak: pantry.streak } });
      }
      return {
        assignments: result.assignments,
        ingredientReuseScore: result.ingredientReuseScore,
        report: reportOf(result, dates, inventoryCoverage !== undefined),
      };
    } catch (err) {
      // The plan could be filled only by letting limits give way that may
      // not: a 422 that names the limits and the meals, so that the user can
      // ask again and let them.
      if (err instanceof OptimizerError && err.blocked) {
        const { needs, meals } = err.blocked;
        throw new UnprocessableEntityException({
          error: 'PLAN_NEEDS_RELAXATION',
          message: `The plan cannot be filled inside its limits: ${meals.length} of its meals would be outside one. These would have to give way: ${needs.join(', ')}.`,
          details: {
            needs,
            meals: meals.map((meal) => ({ date: dates[meal.dayIndex]!, slot: meal.slot, gaveWay: meal.gaveWay })),
          } satisfies RelaxationNeeded,
        });
      }
      // A meal with no recipe left for the diet is a 400 which names the meal
      // and the diet, and says how many recipes for the pair the profile's own
      // rules took out: none means there are none to begin with, and no change
      // to the profile will help.
      if (err instanceof OptimizerError) {
        const { gap } = err;
        const ruledOut = gap
          ? beforeProfileRules.filter((r) => r.mealTypes.includes(gap.slot) && fitsDiet(r.dietTags, gap.dietType)).length
          : 0;
        // Fewer meals a day help only with a meal that the shortest day does not have.
        const fewerMeals = gap && !MEAL_SLOTS_BY_COUNT[2]!.includes(gap.slot) ? ' or fewer meals a day' : '';
        throw new BadRequestException({
          error: 'NO_ELIGIBLE_RECIPE',
          message: !gap
            ? `${err.message}.`
            : ruledOut === 0
              ? `There is no recipe for ${gap.slot} on the ${gap.dietType} diet. Choose another diet${fewerMeals}.`
              : `Every recipe for ${gap.slot} on the ${gap.dietType} diet (${ruledOut}) is ruled out by this profile's allergens, skipped ingredients or avoided recipes.`,
          ...(gap ? { details: { ...gap, ruledOut } satisfies UnfilledMeal } : {}),
        });
      }
      throw err;
    }
  }

  /**
   * Use-up-by: per-recipe coverage scored only against stock that goes off
   * between the start of the plan and `date`. Steers a flagged day toward
   * recipes that consume soon-to-expire stock; what went off before the plan
   * begins is no reason to cook anything. Returns null when nothing
   * qualifies. Unlike the plan-level bias it does not touch the anti-monotony
   * streak — it's an explicit per-day request, not the rotation-governed
   * default.
   */
  private async expiringCoverageForDate(
    profileId: string,
    planStart: Date,
    date: Date,
    requirementsByRecipe: Map<string, Array<{ ingredientId: string; canonicalQuantity: number }>>,
  ): Promise<Map<string, number> | null> {
    const stock = await stockExpiringBetween(this.prisma, profileId, planStart, date);
    if (stock.size === 0) return null;

    const coverage = new Map<string, number>();
    for (const [recipeId, reqs] of requirementsByRecipe) {
      const score = recipeCoverage(reqs, stock);
      if (score > 0) coverage.set(recipeId, score);
    }
    return coverage.size === 0 ? null : coverage;
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
    /** Every recipe the user may be given at all, before the profile's allergens, skipped ingredients and avoided recipes took any out. */
    beforeProfileRules: Array<{ mealTypes: string[]; dietTags: string[] }>;
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
    for (const r of filteredRecipes) requirementsByRecipe.set(r.id, requirementsPerServing(r));

    return { optimizerRecipes, requirementsByRecipe, beforeProfileRules: recipes };
  }

  /**
   * Build the per-recipe coverage map the optimiser scores against. There is
   * no `coverage` when the toggle is off, the pantry is empty, or no candidate
   * recipe touches anything in the pantry — callers leave the pool ordering /
   * scoring untouched.
   *
   * Anti-monotony rotation: after `inventoryBiasResetEvery` consecutive
   * plan-level generations actually applied a bias, this round drops it and
   * resets the streak — keeps a leftover-heavy month from locking the user
   * into one recipe corridor. `streak` is what the profile's count becomes
   * once the plan is filled; the caller writes it then. It only moves on
   * plan-level paths (this method is unused by swap, which uses
   * `recipeCoverageMap` directly). Threshold `0` disables the reset entirely.
   */
  private async resolveInventoryBias(
    profileId: string,
    respectInventory: boolean,
    optimizerRecipes: OptimizerRecipe[],
    requirementsByRecipe: Map<string, Array<{ ingredientId: string; canonicalQuantity: number }>>,
  ): Promise<{ coverage?: Map<string, number>; streak?: number }> {
    if (!respectInventory) return {};

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
    if (threshold > 0 && currentStreak >= threshold) return { streak: 0 };

    const stock = await stockByIngredient(this.prisma, profileId);
    if (stock.size === 0) return {};

    const coverage = new Map<string, number>();
    for (const r of optimizerRecipes) {
      const reqs = requirementsByRecipe.get(r.id) ?? [];
      const score = recipeCoverage(reqs, stock);
      if (score > 0) coverage.set(r.id, score);
    }
    if (coverage.size === 0) return {};

    // Bias actually applied — the next round inches closer to the reset.
    // Threshold 0 disables the bookkeeping too.
    return { coverage, streak: threshold > 0 ? currentStreak + 1 : undefined };
  }
}

type WeeklyTarget = '0.25' | '0.5' | '0.75' | '1.0' | null;

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

/** A random value for one generation: any 32-bit integer, which is what the column holds. */
function newSeed(): number {
  return randomInt(-(2 ** 31), 2 ** 31);
}

/**
 * The base target of a plan and how it came about: what the target of each
 * of its days is decided from.
 */
interface PlanBase {
  target: number;
  /** Worked out by the engine, not typed by somebody. */
  calculated: boolean;
  floor: number;
  /** Maintenance, when the profile's loss goal is held: no day goes under it by a target of its own. */
  holdUnder: number | null;
}

/** The target of one day of a plan: its own when the user set one, else the base shaped by the kind of day. */
function dayTarget(base: PlanBase, day?: { calorieTarget?: number; dayType?: 'normal' | 'rest' | 'training' } | null): number {
  return effectiveDayTarget({
    base: base.target,
    baseIsCalculated: base.calculated,
    floor: base.floor,
    dayType: day?.dayType,
    ownTarget: day?.calorieTarget,
    holdUnder: base.holdUnder,
  }).target;
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
  base: PlanBase;
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
      calorieTarget: dayTarget(input.base, o),
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
      ? { overrides: d.overrides as Prisma.InputJsonValue }
      : {}),
    meals: {
      create: assignments
        .filter((a) => a.dayIndex === dayIndex)
        .map((a) => ({ recipeId: a.recipeId, mealType: a.slot, servings: a.servings })),
    },
  }));
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
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
