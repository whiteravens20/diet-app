// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomInt } from 'node:crypto';
import { Prisma } from '@prisma/client';
import {
  fitsDiet,
  MAX_PLANS_PER_PROFILE,
  MEAL_SLOTS_BY_COUNT,
  PlanOptions,
  RegenerateDayRequest,
  RegenerateRequest,
  type DayOverride,
  type RerollPreview,
  type GeneratePlanRequest,
  type Locale,
  type MacroSplit,
  type MealPlan,
  type MealType,
  type PantryUse,
  type PlanRelaxation,
  type RelaxationNeeded,
  type UnfilledMeal,
} from '@diet-app/shared';
import {
  amountsPerServing,
  dayMacros,
  effectiveDayTarget,
  macroSplitOf,
  macrosForCalories,
  optimisePlan,
  weekScales,
  sizeAssignments,
  sharesOf,
  OptimizerError,
  proteinKindsOf,
  recipeCoverage,
  requirementsPerServing,
  type KeptMeal,
  type OptimizerDay,
  type OptimizerRecipe,
  type SizedAssignment,
} from '../engine/index.js';
import { holdProfile } from '../common/hold.js';
import type { Env } from '../config/env.js';
import { diaryOfDays, type DiaryOnDay } from '../diary/diary-days.js';
import { stockByIngredient, stockExpiringBetween } from '../inventory/pantry-store.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { storedSplit } from '../common/stored-split.js';
import { reportOf, StoredReport, withDaysAgain } from './generation-report.js';
import { cookingChange, MealPlansService, type CookedMeal } from './meal-plans.service.js';
import {
  customMacros,
  isoDate,
  isSkipped,
  parseDayOverrides,
  type DayOverridesJson,
} from './plan-days.js';
import { planBaseOf, type BaseProfile, type PlanBase } from './plan-base.js';
import { asWeekDay } from './plan-weeks.js';
import { capsOnARecipe, mealsPerKind } from './plan-limits.js';
import { writePlan } from './plan-write.js';
import { readReroll, rerollDayOf, rerollOutcome } from './reroll-reading.js';

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
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Deterministically generate and persist a meal plan. */
  async generate(userId: string, locale: Locale, req: GeneratePlanRequest): Promise<MealPlan> {
    const profile = await this.plans.loadProfile(userId, req.profileId);
    // A profile that holds the most plans is told so before a plan is worked out for nothing.
    await refuseFullProfile(this.prisma, profile.id);
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
    const macroSplit = splitFor(dietType, profile);
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

    // What the diary holds already for a day of the plan is eaten: the plan fills what is left of its target.
    const diary = await diaryOfDays(this.prisma, profile.id, resolvedDays);

    const seed = this.nextSeed();
    const result = await this.optimiseFor(userId, profile, {
      days: resolvedDays.map((day) => ({ ...day, kept: keptOfDiary(diary.get(day.isoDate)) })),
      planTarget: baseCalorieTarget,
      dietType,
      macroSplit,
      mealPrepFriendly: req.mealPrepFriendly,
      respectExclusions: req.respectExclusions,
      respectFavorites: req.respectFavorites,
      respectInventory: req.respectInventory,
      maxRepeatsPerRecipe: req.maxRepeatsPerRecipe,
      allowRelaxations: req.allowRelaxations,
      seed,
    });

    const plan = await this.prisma.$transaction(async (tx) => {
      // Counted again while the profile is held: plans asked for together do not pass the most between them.
      await holdProfile(tx, profile.id);
      await refuseFullProfile(tx, profile.id);
      if (result.pantryRound)
        await tx.profile.update({
          where: { id: profile.id },
          data: pantryCount(result.pantryRound),
        });
      return tx.mealPlan.create({
        data: {
          profileId: profile.id,
          startDate: start,
          durationDays: req.durationDays,
          dietType,
          calorieTarget: baseCalorieTarget,
          macroSplit: macroSplit ?? Prisma.JsonNull,
          reuseScore: result.ingredientReuseScore,
          options,
          seed,
          report: result.report,
          days: { create: buildDays(resolvedDays, result.assignments) },
        },
      });
    });
    return this.plans.get(userId, locale, plan.id);
  }

  /** The server's own day, as the API writes dates, for a request that names none; replaceable in a test. */
  today: () => string = () => isoDate(new Date());

  /** The seed of one generation: random, so that making a plan again gives another; replaceable in a test. */
  nextSeed: () => number = newSeed;

  /** Make a plan again, or the days of it that the request names. `clientToday` is the day it is for whoever asks. */
  async regenerate(
    userId: string,
    locale: Locale,
    planId: string,
    request: RegenerateRequest = RegenerateRequest.parse({}),
    clientToday: string | null = null,
  ): Promise<MealPlan> {
    const { from, to, ...options } = request;
    await this.reroll(userId, planId, { from, to }, options, clientToday);
    return this.plans.get(userId, locale, planId);
  }

  /**
   * Take the profile's target from today (`RetargetPlanRequest`), on the plan
   * as it was at `revision`: the plan's target becomes the one the profile
   * has now, and each day from today that is not skipped gets the target that
   * comes of it by its kind and its week, or keeps its own, the same dishes
   * in other portions. Days before today stay as they were. A plan whose
   * target was typed for it has nothing to take.
   */
  async retarget(
    userId: string,
    locale: Locale,
    planId: string,
    revision: number,
    clientToday: string | null = null,
  ): Promise<MealPlan> {
    const plan = await this.prisma.mealPlan.findUnique({
      where: { id: planId },
      include: { profile: true, days: { orderBy: { date: 'asc' } } },
    });
    if (!plan?.profile || plan.profile.userId !== userId)
      throw new NotFoundException({ error: 'PLAN_NOT_FOUND', message: 'Meal plan not found.' });
    if (plan.revision !== revision) {
      throw new ConflictException({
        error: 'PLAN_CHANGED',
        message: 'The plan changed while this request was running. Reload it and try again.',
      });
    }
    const made = PlanOptions.parse(plan.options);
    if (made.calorieTargetOverride !== null) {
      throw new ConflictException({
        error: 'PLAN_TARGET_TYPED',
        message: 'This plan keeps the target typed for it; the profile has none to give it.',
      });
    }
    const today = clientToday ?? this.today();
    const base = this.planBase(plan.profile);
    const scales = weekScales(plan.days.map(asWeekDay));
    const moved = plan.days.flatMap((day, index) => {
      if (isoDate(day.date) < today || isSkipped(day)) return [];
      const target = dayTarget(base, parseDayOverrides(day.overrides), scales[index]!);
      return target === day.calorieTarget ? [] : [{ id: day.id, target }];
    });
    if (base.target !== plan.calorieTarget || moved.length > 0) {
      await writePlan(this.prisma, planId, revision, async (tx) => {
        await tx.mealPlan.update({ where: { id: planId }, data: { calorieTarget: base.target } });
        for (const day of moved) {
          await tx.mealPlanDay.update({
            where: { id: day.id },
            data: { calorieTarget: day.target },
          });
          await this.plans.rebalanceDayInternal(day.id, tx, today);
        }
      });
    }
    return this.plans.get(userId, locale, planId, today);
  }

  /** Give one day of a plan other meals. */
  async regenerateDay(
    userId: string,
    locale: Locale,
    planId: string,
    dayId: string,
    options: RegenerateDayRequest = RegenerateDayRequest.parse({}),
    clientToday: string | null = null,
  ): Promise<MealPlan> {
    const date = await this.dateOfDay(userId, planId, dayId);
    await this.reroll(userId, planId, { from: date, to: date }, options, clientToday);
    return this.plans.get(userId, locale, planId);
  }

  /**
   * What a re-roll of the days from `range.from` to `range.to` (all of the
   * plan's days without them) would do to the plan as it stands, read as
   * `prepare` reads it for the re-roll (`rerollOutcome`). Nothing is drawn and
   * nothing is written.
   */
  async previewReroll(
    userId: string,
    planId: string,
    range: { from?: string; to?: string },
    options: RegenerateDayRequest = RegenerateDayRequest.parse({}),
    clientToday: string | null = null,
  ): Promise<RerollPreview> {
    const plan = await this.prisma.mealPlan.findFirst({
      where: { id: planId, profile: { userId } },
      select: {
        options: true,
        profile: { select: { mealCount: true } },
        days: {
          orderBy: { date: 'asc' },
          select: {
            id: true,
            date: true,
            overrides: true,
            meals: {
              select: { id: true, mealType: true, recipeId: true, source: true, eatenAt: true },
            },
          },
        },
      },
    });
    if (!plan?.profile)
      throw new NotFoundException({ error: 'PLAN_NOT_FOUND', message: 'Meal plan not found.' });
    const dates = plan.days.map((day) => isoDate(day.date));
    const span = spanOf(dates, range);
    const today = clientToday ?? this.today();
    const { mealCount } = PlanOptions.parse(plan.options);
    const profileCount = plan.profile.mealCount;
    const days = plan.days.map((day, index) =>
      rerollDayOf(day, dates[index]!, mealCount, profileCount),
    );
    // What gives place on the days filled again, and the meals cooked with it on the other days.
    const readings = days.map((day) => readReroll(day, { ...span, ...options }, today));
    const filled = new Set(
      plan.days.filter((_, index) => readings[index]!.fate === 'again').map((day) => day.id),
    );
    const cookedWith = await this.plans.cookedWith(
      this.prisma,
      planId,
      PlanOptions.parse(plan.options),
    );
    const others = days.flatMap((day, index) => {
      const reading = readings[index]!;
      if (reading.fate !== 'again') return [];
      const staying = new Set(reading.staying);
      return day.meals
        .filter((meal) => !staying.has(meal))
        .flatMap((meal) => cookedWith.get(meal.id) ?? [])
        .filter((meal) => !filled.has(meal.dayId));
    });
    return {
      ...rerollOutcome(days, { ...span, ...options }, today),
      cooking: cookingChange(others, today),
      // Dates in this form sort as text.
      fromToday: today <= dates[0]! ? 'not_begun' : today > dates.at(-1)! ? 'over' : null,
    };
  }

  /** What a re-roll of one day of a plan would do, as `previewReroll` says it of that day. */
  async previewRerollDay(
    userId: string,
    planId: string,
    dayId: string,
    options: RegenerateDayRequest = RegenerateDayRequest.parse({}),
    clientToday: string | null = null,
  ): Promise<RerollPreview> {
    const date = await this.dateOfDay(userId, planId, dayId);
    return this.previewReroll(userId, planId, { from: date, to: date }, options, clientToday);
  }

  /** The date of a day of a plan of the account's. */
  private async dateOfDay(userId: string, planId: string, dayId: string): Promise<string> {
    // The plan first: whoever asks about a plan that is not theirs learns nothing about its days.
    const plan = await this.prisma.mealPlan.findFirst({
      where: { id: planId, profile: { userId } },
      select: { id: true },
    });
    if (!plan)
      throw new NotFoundException({ error: 'PLAN_NOT_FOUND', message: 'Meal plan not found.' });
    const day = await this.prisma.mealPlanDay.findUnique({
      where: { id: dayId },
      select: { planId: true, date: true },
    });
    if (!day || day.planId !== planId) {
      throw new NotFoundException({ error: 'DAY_NOT_FOUND', message: 'Plan day not found.' });
    }
    return isoDate(day.date);
  }

  /**
   * The days of a plan that are to be filled again, with everything a draw
   * for them needs: all of the plan's days, or those from `range.from` to
   * `range.to`. Days before today, meals marked as eaten and the user's own
   * meals stay unless the options say otherwise, and whatever stays counts for
   * the limits of the plan and for what its day has left, as what the profile's
   * diary holds for the day counts for the latter. A day the user skips
   * gets nothing, and keeps what was eaten of it and the user's own meals
   * whatever the options say. Read once, for as many draws as are made of it;
   * nothing is written.
   *
   * Without a range the plan is made again: as it was asked for, with the
   * profile as it is now for what was left to the profile, and with what each
   * day carries of its own. With one, the plan stays what it is.
   */
  async prepare(
    userId: string,
    planId: string,
    range: { from?: string; to?: string },
    options: RegenerateDayRequest,
    clientToday: string | null,
  ) {
    const plan = await this.prisma.mealPlan.findUnique({
      where: { id: planId },
      include: {
        profile: true,
        days: {
          orderBy: { date: 'asc' },
          include: {
            meals: {
              include: {
                recipe: {
                  select: {
                    caloriesPerServing: true,
                    proteinPerServing: true,
                    fatPerServing: true,
                    carbsPerServing: true,
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!plan?.profile || plan.profile.userId !== userId)
      throw new NotFoundException({ error: 'PLAN_NOT_FOUND', message: 'Meal plan not found.' });

    const dates = plan.days.map((day) => isoDate(day.date));
    const whole = range.from === undefined && range.to === undefined;
    const span = spanOf(dates, range);
    const today = clientToday ?? this.today();
    const made = PlanOptions.parse(plan.options);
    const profileCount = plan.profile.mealCount;
    const readings = plan.days.map((day, index) =>
      readReroll(
        rerollDayOf(day, dates[index]!, made.mealCount, profileCount),
        { ...span, ...options },
        today,
      ),
    );
    if (readings.every((reading) => reading.fate === 'outside' || reading.fate === 'past')) {
      throw new ConflictException({
        error: 'NOTHING_TO_REGENERATE',
        message:
          'Every day asked for is before today. Days in the past are made again only when the request says so.',
      });
    }

    const profile = await this.plans.loadProfile(userId, plan.profileId);
    const diary = await diaryOfDays(this.prisma, plan.profileId, plan.days);
    const allowRelaxations = options.allowRelaxations ?? made.allowRelaxations;
    const base = this.planBase(profile, made.calorieTargetOverride ?? undefined);
    const dietType = whole ? (made.dietType ?? profile.dietType) : plan.dietType;
    // A plan that is made again takes the split the profile has now; days of it that are filled again, the one the plan was made with.
    const macroSplit = whole ? splitFor(dietType, profile) : storedSplit(plan.macroSplit);

    /** The days that are filled again, by their place in the plan, with the meals that stay on them. */
    const filled: { dayIndex: number; dayId: string; staying: string[] }[] = [];
    // A plan made again shares each week's base among its days as a new plan does.
    const scales = weekScales(plan.days.map(asWeekDay));
    const days = plan.days.map((day, dayIndex): ResolvedDay => {
      const iso = dates[dayIndex]!;
      const o = parseDayOverrides(day.overrides);
      const reading = readings[dayIndex]!;
      const kept = (meal: (typeof day.meals)[number]): KeptMeal => {
        // A meal of the user's own holds what the user said it holds; one of the catalogue what its recipe does.
        const own = customMacros(meal.customMacros);
        const perServing = meal.recipe
          ? {
              calories: meal.recipe.caloriesPerServing,
              protein: meal.recipe.proteinPerServing,
              fat: meal.recipe.fatPerServing,
              carbs: meal.recipe.carbsPerServing,
            }
          : own;
        const servings = meal.servings * meal.quantityScale;
        return {
          recipeId: meal.recipeId ?? undefined,
          calories: perServing.calories * servings,
          servings,
          macros: {
            protein: perServing.protein * servings,
            fat: perServing.fat * servings,
            carbs: perServing.carbs * servings,
          },
        };
      };
      if (reading.fate === 'outside' || reading.fate === 'past') {
        return {
          date: day.date,
          isoDate: iso,
          mealSlots: [],
          calorieTarget: day.calorieTarget,
          useUpBy: false,
          skip: false,
          overrides: o,
          kept: day.meals.map(kept),
        };
      }

      filled.push({ dayIndex, dayId: day.id, staying: reading.staying.map((meal) => meal.id) });
      return {
        date: day.date,
        isoDate: iso,
        mealSlots: reading.slots,
        calorieTarget: whole ? dayTarget(base, o, scales[dayIndex]!) : day.calorieTarget,
        cookTimeBudgetMinutes: o?.cookTimeBudgetMinutes,
        lockedSlots: o?.lockedSlots
          ? reading.locks.map((lock) => ({ slot: lock.mealType, recipeId: lock.recipeId }))
          : undefined,
        useUpBy: o?.useUpBy ?? false,
        skip: o?.skip ?? false,
        overrides: o,
        kept: [...reading.staying.map(kept), ...keptOfDiary(diary.get(iso))],
      };
    });

    return {
      plan,
      profile,
      made,
      dates,
      whole,
      days,
      filled,
      diary,
      allowRelaxations,
      base,
      dietType,
      macroSplit,
      dropIneligibleLocks: options.dropIneligibleLocks,
    };
  }

  /** One way to fill the days that were prepared, by the draws of `seed`. Nothing is written. */
  draw(
    userId: string,
    prepared: Awaited<ReturnType<PlanGenerationService['prepare']>>,
    seed: number,
  ) {
    return this.optimiseFor(userId, prepared.profile, {
      days: prepared.days,
      planTarget: prepared.whole ? prepared.base.target : prepared.plan.calorieTarget,
      dietType: prepared.dietType,
      macroSplit: prepared.macroSplit,
      mealPrepFriendly: prepared.made.mealPrepFriendly,
      respectExclusions: prepared.made.respectExclusions,
      respectFavorites: prepared.made.respectFavorites,
      respectInventory: prepared.made.respectInventory,
      maxRepeatsPerRecipe: prepared.made.maxRepeatsPerRecipe ?? undefined,
      allowRelaxations: prepared.allowRelaxations,
      dropIneligibleLocks: prepared.dropIneligibleLocks,
      seed,
    });
  }

  /** Fill days of a plan again (see `prepare`), and write what the draw came to. */
  private async reroll(
    userId: string,
    planId: string,
    range: { from?: string; to?: string },
    options: RegenerateDayRequest,
    clientToday: string | null,
  ): Promise<void> {
    const prepared = await this.prepare(userId, planId, range, options, clientToday);
    if (prepared.filled.every(({ dayIndex }) => isSkipped(prepared.plan.days[dayIndex]!))) {
      throw new ConflictException({
        error: 'NOTHING_TO_REGENERATE',
        message:
          'Every day asked for is skipped or before today. A skipped day is left as it is, and days in the past are made again only when the request says so.',
      });
    }
    const { plan, made, dates, whole, days, filled, allowRelaxations, base, dietType, macroSplit } =
      prepared;
    const seed = this.nextSeed();
    const result = await this.draw(userId, prepared, seed);
    // Each meal that gives place, with the recipe that takes its place: for the meals cooked with it.
    const today = clientToday ?? this.today();
    const cookedWith = options.together
      ? await this.plans.cookedWith(this.prisma, planId, PlanOptions.parse(plan.options))
      : new Map<string, CookedMeal[]>();
    const moves = filled.flatMap(({ dayIndex, staying }) =>
      plan.days[dayIndex]!.meals.filter((meal) => !staying.includes(meal.id)).flatMap((meal) => {
        const placed = result.assignments.find(
          (one) => one.dayIndex === dayIndex && one.slot === meal.mealType,
        );
        return placed ? [{ mealId: meal.id, recipeId: placed.recipeId }] : [];
      }),
    );

    // What the report said of the days filled again gives place to what this
    // run found. A plan from before reports were kept gets one when the whole
    // of it is made again; what the pantry had to do with it is said of a whole plan.
    const before = StoredReport.nullable().parse(plan.report ?? null);
    const merged = before
      ? withDaysAgain(
          before,
          result.report,
          filled.map(({ dayIndex }) => dates[dayIndex]!),
        )
      : null;
    const report = whole ? { ...(merged ?? result.report), pantry: result.report.pantry } : merged;

    await writePlan(this.prisma, planId, plan.revision, async (tx) => {
      // A plan made again is a round of the pantry's rotation; days of it filled again are not.
      if (whole && result.pantryRound)
        await tx.profile.update({
          where: { id: plan.profileId },
          data: pantryCount(result.pantryRound),
        });
      for (const { dayIndex, dayId, staying } of filled) {
        const day = days[dayIndex]!;
        await tx.mealPlanDay.update({
          where: { id: dayId },
          // A lock that was dropped leaves the stored overrides of the day as well.
          data: {
            calorieTarget: day.calorieTarget,
            overrides: day.overrides ? (day.overrides as Prisma.InputJsonValue) : Prisma.JsonNull,
          },
        });
        await tx.plannedMeal.deleteMany({ where: { dayId, id: { notIn: staying } } });
        await tx.plannedMeal.createMany({
          data: result.assignments
            .filter((placed) => placed.dayIndex === dayIndex)
            .map((placed) => ({
              dayId,
              recipeId: placed.recipeId,
              mealType: placed.slot,
              servings: placed.servings,
              quantityScale: placed.quantityScale,
            })),
        });
      }
      await tx.mealPlan.update({
        where: { id: planId },
        data: {
          reuseScore: result.ingredientReuseScore,
          ...(report ? { report } : {}),
          // A plan that was made again is what it was made with this time, and the engine's alone unless a meal a model picked stayed in it.
          ...(whole
            ? {
                calorieTarget: base.target,
                dietType,
                macroSplit: macroSplit ?? Prisma.JsonNull,
                options: { ...made, allowRelaxations },
                seed,
              }
            : {}),
        },
      });
      await this.plans.carryToOtherDays(
        tx,
        planId,
        cookedWith,
        moves,
        new Set(filled.map((entry) => entry.dayId)),
        today,
      );
    });
  }

  /**
   * The target of a day of a plan with the settings `overrides`, as the days of
   * the plan were given theirs: the base the plan was made with, times `scale`
   * (what a usual day of the day's week is against the base, `weekScale`),
   * shaped by the kind of day; or the day's own target.
   */
  targetOfDay(
    profile: BaseProfile,
    plan: { calorieTarget: number; options: unknown },
    overrides: { calorieTarget?: number; dayType?: 'normal' | 'rest' | 'training' } | null,
    scale: number,
  ): number {
    const made = PlanOptions.parse(plan.options);
    return dayTarget(
      {
        ...this.planBase(profile, made.calorieTargetOverride ?? undefined),
        target: plan.calorieTarget,
      },
      overrides,
      scale,
    );
  }

  /** The base target of a plan for this profile (`planBaseOf`). */
  private planBase(profile: BaseProfile, typedForThePlan?: number): PlanBase {
    return planBaseOf(profile, typedForThePlan);
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
      preferences: {
        allergens: string[];
        excludedIngredientIds: string[];
        favoriteIngredientIds: string[];
        dislikedIngredientIds: string[];
        preferredCuisines: string[];
        maxConsecutiveDaysSameMeal: number;
        maxTimesPerWeekSameMeal: number;
        maxMealsPerDaySameKind: number | null;
        maxMealsPerWeekSameKind: number | null;
        kindLimits: unknown;
      } | null;
    },
    opts: {
      days: ResolvedDay[];
      /** The plan's own calorie target, whose protein every day keeps. */
      planTarget: number;
      dietType: MealPlan['dietType'];
      /** The split a plan on the custom diet aims at; null on every other diet. */
      macroSplit: MacroSplit | null;
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
  ): Promise<{
    assignments: SizedAssignment[];
    ingredientReuseScore: number;
    report: StoredReport;
    pantryRound?: PantryRound;
  }> {
    const { optimizerRecipes, requirementsByRecipe, beforeProfileRules, perishablePacks } =
      await this.loadEligibleRecipes(ownerUserId, profile, {
        respectExclusions: opts.respectExclusions,
      });

    // A lock pins a recipe to a slot, and a pinned recipe passes the same gate
    // as any other: it has to be among the recipes this profile may be given,
    // for that meal, on this diet.
    const recipeById = new Map(optimizerRecipes.map((r) => [r.id, r]));
    for (const day of opts.days) {
      for (const lock of [...(day.lockedSlots ?? [])]) {
        const recipe = recipeById.get(lock.recipeId);
        if (
          !recipe ||
          !recipe.mealTypes.includes(lock.slot) ||
          !fitsDiet(recipe.dietTags, opts.dietType)
        ) {
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
      const dates = [
        ...new Set(opts.days.filter((d) => d.useUpBy && !d.skip).map((d) => d.isoDate)),
      ];
      // ISO dates sort as text.
      const planStart = new Date(opts.days.map((d) => d.isoDate).sort()[0]!);
      for (const iso of dates) {
        const map = await this.expiringCoverageForDate(
          profile.id,
          planStart,
          new Date(iso),
          requirementsByRecipe,
        );
        if (map) expiringByDate.set(iso, map);
      }
    }

    const caps = capsOnARecipe(profile.preferences, opts.mealPrepFriendly);

    const own = sharesOf(opts.macroSplit);
    const days: OptimizerDay[] = opts.days.map((d) => {
      // Every day keeps the protein of the plan's target: a day the kinds took off it aims at its own grams.
      const aimed = dayMacros(
        {
          target: d.calorieTarget,
          base: opts.planTarget,
          ownTarget: d.overrides?.calorieTarget ?? null,
        },
        opts.dietType,
        own,
      );
      const plain = macrosForCalories(d.calorieTarget, opts.dietType, own);
      const macroAim =
        aimed.protein === plain.protein && aimed.fat === plain.fat && aimed.carbs === plain.carbs
          ? undefined
          : aimed;
      return {
        mealSlots: d.mealSlots,
        dailyCalorieTarget: d.calorieTarget,
        ...(macroAim ? { macroAim } : {}),
        cookTimeBudgetMinutes: d.cookTimeBudgetMinutes,
        lockedSlots: d.lockedSlots,
        inventoryCoverage: d.useUpBy ? expiringByDate.get(d.isoDate) : undefined,
        skip: d.skip,
        kept: d.kept,
        avoid: d.avoid,
      };
    });

    const dates = opts.days.map((d) => d.isoDate);
    const split = macroSplitOf(opts.dietType, sharesOf(opts.macroSplit));
    try {
      const result = optimisePlan({
        recipes: optimizerRecipes,
        days,
        macroSplit: split,
        dietType: opts.dietType,
        mealPrepFriendly: opts.mealPrepFriendly,
        favoriteIngredientIds,
        dislikedIngredientIds: new Set(profile.preferences?.dislikedIngredientIds ?? []),
        preferredCuisines: new Set(profile.preferences?.preferredCuisines ?? []),
        inventoryCoverage,
        maxConsecutiveDaysSameMeal: caps.consecutive,
        maxTimesPerWeekSameMeal: caps.perWeek,
        // A plan that names no number is held to the operator's, where one is set.
        maxRepeatsPerRecipe:
          opts.maxRepeatsPerRecipe ??
          this.config.get('DEFAULT_MAX_REPEATS_PER_RECIPE', { infer: true }),
        maxMealsPerKind: mealsPerKind(profile.preferences),
        perishablePacks,
        allowRelaxations: new Set(opts.allowRelaxations),
        seed: opts.seed,
      });
      return {
        assignments: sizeAssignments(days, optimizerRecipes, result.assignments, split),
        ingredientReuseScore: result.ingredientReuseScore,
        report: reportOf(result, dates, pantry.use),
        pantryRound: pantry.round,
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
            meals: meals.map((meal) => ({
              date: dates[meal.dayIndex]!,
              slot: meal.slot,
              gaveWay: meal.gaveWay,
            })),
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
          ? beforeProfileRules.filter(
              (r) => r.mealTypes.includes(gap.slot) && fitsDiet(r.dietTags, gap.dietType),
            ).length
          : 0;
        // Fewer meals a day help only with a meal that the shortest day does not have.
        const fewerMeals =
          gap && !MEAL_SLOTS_BY_COUNT[2]!.includes(gap.slot) ? ' or fewer meals a day' : '';
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
      preferences: {
        allergens: string[];
        excludedIngredientIds: string[];
        favoriteIngredientIds: string[];
      } | null;
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
    /** The pack of each ingredient of the pool whose opened pack does not keep, in the ingredient's canonical unit. */
    perishablePacks: Map<string, number>;
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
    // Only what the choice of recipes reads: the texts of two thousand
    // recipes are most of what their rows weigh, and no part of the choice.
    const recipes = await this.prisma.recipe.findMany({
      where: {
        deletedAt: null,
        retiredAt: null,
        OR: [{ createdByUserId: null }, { createdByUserId: ownerUserId }],
      },
      select: {
        id: true,
        slug: true,
        servings: true,
        mealTypes: true,
        dietTags: true,
        allergens: true,
        caloriesPerServing: true,
        proteinPerServing: true,
        fatPerServing: true,
        carbsPerServing: true,
        difficulty: true,
        cuisine: true,
        prepMinutes: true,
        cookMinutes: true,
        ingredients: {
          orderBy: { position: 'asc' },
          select: {
            ingredientId: true,
            quantity: true,
            unit: true,
            ingredient: {
              select: {
                canonicalUnit: true,
                gramsPerPiece: true,
                density: true,
                packSize: true,
                perishable: true,
                proteinPer100: true,
                proteinKind: true,
              },
            },
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
    const avoidedIds = new Set(
      favorites.filter((f) => f.sentiment === 'avoid').map((f) => f.recipeId),
    );
    const favoriteIds = new Set(
      favorites.filter((f) => f.sentiment !== 'avoid').map((f) => f.recipeId),
    );
    const oftenIds = new Set(
      favorites.filter((f) => f.sentiment === 'often').map((f) => f.recipeId),
    );

    const filteredRecipes = recipes
      .filter((r) => !avoidedIds.has(r.id))
      .filter((r) => !r.allergens.some((a) => allergens.includes(a)))
      .filter((r) => !r.ingredients.some((i) => excluded.has(i.ingredientId)));

    const requirementsByRecipe = new Map<
      string,
      Array<{ ingredientId: string; canonicalQuantity: number }>
    >();
    for (const r of filteredRecipes) requirementsByRecipe.set(r.id, requirementsPerServing(r));

    const optimizerRecipes: OptimizerRecipe[] = filteredRecipes.map((r) => ({
      id: r.id,
      slug: r.slug,
      mealTypes: r.mealTypes as MealType[],
      dietTags: r.dietTags,
      caloriesPerServing: r.caloriesPerServing,
      proteinPerServing: r.proteinPerServing,
      fatPerServing: r.fatPerServing,
      carbsPerServing: r.carbsPerServing,
      ingredientIds: r.ingredients.map((i) => i.ingredientId),
      amounts: amountsPerServing(requirementsByRecipe.get(r.id) ?? []),
      proteinKinds: proteinKindsOf(r),
      difficulty: r.difficulty,
      cuisine: r.cuisine,
      isFavorite: favoriteIds.has(r.id),
      eatenOften: oftenIds.has(r.id),
      totalMinutes: r.prepMinutes + r.cookMinutes,
    }));

    // The pack of every ingredient of the pool whose opened pack does not keep.
    const perishablePacks = new Map<string, number>();
    for (const line of filteredRecipes.flatMap((r) => r.ingredients)) {
      if (line.ingredient.perishable && line.ingredient.packSize)
        perishablePacks.set(line.ingredientId, line.ingredient.packSize);
    }

    return { optimizerRecipes, requirementsByRecipe, beforeProfileRules: recipes, perishablePacks };
  }

  /**
   * What the pantry has to do with this plan (`use`), and when it counts the
   * per-recipe coverage map the optimiser scores against. It does not count
   * when the plan was asked to leave it aside, when it is empty, and when no
   * candidate recipe uses anything that is in it.
   *
   * Anti-monotony rotation: after `inventoryBiasResetEvery` consecutive plans
   * that counted the pantry, the next one that would have leaves it out, so
   * that a month heavy with leftovers does not keep the user in one corridor
   * of recipes. `streak` is what the profile's count becomes once the plan is
   * filled; the caller writes it then. It only moves on plan-level paths (a
   * swap reads `recipeCoverageMap` directly). Threshold `0` switches the
   * rotation off.
   */
  private async resolveInventoryBias(
    profileId: string,
    respectInventory: boolean,
    optimizerRecipes: OptimizerRecipe[],
    requirementsByRecipe: Map<string, Array<{ ingredientId: string; canonicalQuantity: number }>>,
  ): Promise<{ use: PantryUse; coverage?: Map<string, number>; round?: PantryRound }> {
    if (!respectInventory) return { use: 'not_asked' };

    const stock = await stockByIngredient(this.prisma, profileId);
    if (stock.size === 0) return { use: 'empty' };

    const coverage = new Map<string, number>();
    for (const r of optimizerRecipes) {
      const reqs = requirementsByRecipe.get(r.id) ?? [];
      const score = recipeCoverage(reqs, stock);
      if (score > 0) coverage.set(r.id, score);
    }
    if (coverage.size === 0) return { use: 'unused' };

    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: {
        inventoryBiasStreak: true,
        preferences: { select: { inventoryBiasResetEvery: true } },
      },
    });
    const threshold = profile?.preferences?.inventoryBiasResetEvery ?? 5;
    if (threshold === 0) return { use: 'counted', coverage };
    const currentStreak = profile?.inventoryBiasStreak ?? 0;
    return currentStreak >= threshold
      ? { use: 'left_out', round: 'left_out' }
      : { use: 'counted', coverage, round: 'counted' };
  }
}

/**
 * What a plan made for a profile means for the rotation of its pantry: a
 * round in which the pantry counted, or the round it was left out, after
 * which the count begins again. The count is moved by whoever writes the
 * plan, with the plan: a plan that was refused or not saved is no round, and
 * neither is a single day filled again.
 */
type PantryRound = 'counted' | 'left_out';

/** The move of the count for a round, in a form two plans made at once cannot lose a step of. */
const pantryCount = (round: PantryRound): Prisma.ProfileUpdateInput => ({
  inventoryBiasStreak: round === 'counted' ? { increment: 1 } : 0,
});

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
  /** Meals that are on the day and stay there. */
  kept?: KeptMeal[];
  /** Recipes the day is filled with only where the limits leave no other (`OptimizerDay.avoid`). */
  avoid?: ReadonlySet<string>;
}

/**
 * The first and the last day a re-roll asks for: all of the plan's days
 * without a range. Refused where a date is no day of the plan, or the first is
 * after the last.
 */
function spanOf(
  dates: readonly string[],
  range: { from?: string; to?: string },
): { first: string; last: string } {
  const first = range.from ?? dates[0]!;
  const last = range.to ?? dates.at(-1)!;
  // Dates in this form sort as text.
  if (!dates.includes(first) || !dates.includes(last) || first > last) {
    throw new BadRequestException({
      error: 'RANGE_OUTSIDE_PLAN',
      message: `The days from ${first} to ${last} are not days of this plan, in that order.`,
    });
  }
  return { first, last };
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
 * The target of one day of a plan: its own when the user set one, else the
 * base times the scale of its week (`weekScale`), shaped by the kind of day.
 */
function dayTarget(
  base: PlanBase,
  day: { calorieTarget?: number; dayType?: 'normal' | 'rest' | 'training' } | null | undefined,
  scale: number,
): number {
  return effectiveDayTarget({
    base: base.target,
    baseIsCalculated: base.calculated,
    floor: base.floor,
    dayType: day?.dayType,
    scale,
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
  // The kinds of day share each week's base among its days.
  const scales = weekScales(
    dates.map((date) => {
      const o = byDate.get(isoDate(date));
      return { dayType: o?.dayType, ownTarget: o?.calorieTarget ?? null, skip: o?.skip };
    }),
  );

  return dates.map((date, dayIndex) => {
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
      calorieTarget: dayTarget(input.base, o, scales[dayIndex]!),
      cookTimeBudgetMinutes: o?.cookTimeBudgetMinutes,
      lockedSlots,
      useUpBy: o?.useUpBy ?? false,
      skip: o?.skip ?? false,
      overrides: buildOverridesJson(o),
    };
  });
}

/** What the diary holds for a day, as what the day keeps: eaten, and of no recipe. */
function keptOfDiary(diary: DiaryOnDay | undefined): KeptMeal[] {
  if (!diary) return [];
  const { calories, ...macros } = diary.nutrition;
  return [{ calories, macros }];
}

/** Nested `days.create` payload from resolved days + optimiser assignments. */
function buildDays(resolved: ResolvedDay[], assignments: SizedAssignment[]) {
  return resolved.map((d, dayIndex) => ({
    date: d.date,
    calorieTarget: d.calorieTarget,
    ...(d.overrides ? { overrides: d.overrides as Prisma.InputJsonValue } : {}),
    meals: {
      create: assignments
        .filter((a) => a.dayIndex === dayIndex)
        .map((a) => ({
          recipeId: a.recipeId,
          mealType: a.slot,
          servings: a.servings,
          quantityScale: a.quantityScale,
        })),
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

/**
 * The split a plan on `dietType` aims at for this profile: the profile's own
 * on the custom diet, and none on any other. A plan for the custom diet of a
 * profile that has said no split is refused: another diet's split under that
 * name would be a plan for something nobody asked for.
 */
function splitFor(
  dietType: MealPlan['dietType'],
  profile: { customMacroSplit: unknown },
): MacroSplit | null {
  if (dietType !== 'custom') return null;
  const split = storedSplit(profile.customMacroSplit);
  if (!split) {
    throw new BadRequestException({
      error: 'CUSTOM_SPLIT_MISSING',
      message:
        'The custom diet needs a split of protein, fat and carbohydrate. Set one on the profile first.',
    });
  }
  return split;
}

/** Refuse a plan more for a profile that holds `MAX_PLANS_PER_PROFILE` already. */
async function refuseFullProfile(
  db: Pick<Prisma.TransactionClient, 'mealPlan'>,
  profileId: string,
): Promise<void> {
  if ((await db.mealPlan.count({ where: { profileId } })) >= MAX_PLANS_PER_PROFILE) {
    throw new ConflictException({
      error: 'PLAN_LIMIT_REACHED',
      message: `A profile holds at most ${MAX_PLANS_PER_PROFILE} plans: delete an old one first.`,
    });
  }
}
