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
  type Macros,
  type MacroSplit,
  type MealPlan,
  type MealType,
  type PantryUse,
  type PlanRelaxation,
  type RelaxationNeeded,
  type UnfilledMeal,
  type Unit,
} from '@diet-app/shared';
import {
  amountsPerServing,
  dayMacros,
  effectiveDayTarget,
  macroSplitOf,
  macrosForCalories,
  optimisePlan,
  SCORE_WEIGHTS,
  weekScales,
  sizeAssignments,
  sharesOf,
  OptimizerError,
  proteinKindsOf,
  recipeCoverage,
  requirementsPerServing,
  closePacks,
  kitchenNeeds,
  LESS_WASTE,
  NO_WASTE,
  packKitchen,
  packRests,
  reuseScore,
  type ClosingPlan,
  type MealRest,
  type WasteLevel,
  type PackKitchen,
  type KeptMeal,
  type OptimizerDay,
  type OptimizerRecipe,
  type OptimizerResult,
  type SizedAssignment,
  fullKindsOn,
  keepDaysOf,
  topAssignments,
  type Pack,
  type ToppedAssignment,
  type ToppingOption,
} from '../engine/index.js';
import { labelOfAmount, roundLabel } from '../engine/label-totals.js';
import { holdProfile } from '../common/hold.js';
import type { Env } from '../config/env.js';
import { diaryOfDays, type DiaryOnDay } from '../diary/diary-days.js';
import { stockByIngredient, stockExpiringBetween } from '../inventory/pantry-store.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { storedSplit } from '../common/stored-split.js';
import { reportOf, StoredReport, withDaysAgain } from './generation-report.js';
import { dishTraitsOf, eaterOf, toppingOptionsOf } from './toppings-store.js';
import { cookingChange, MealPlansService, type CookedMeal } from './meal-plans.service.js';
import {
  customMacros,
  isoDate,
  restsOf,
  type StoredRest,
  isSkipped,
  parseDayOverrides,
  type DayOverridesJson,
} from './plan-days.js';
import { planBaseOf, type BaseProfile, type PlanBase } from './plan-base.js';
import { menuNeeds, type PackedMeal } from './plan-menu.js';
import { packedOfDays, partnerPacked } from './plan-packs-store.js';
import { asWeekDay } from './plan-weeks.js';
import { capsOnARecipe, mealsPerKind } from './plan-limits.js';
import { writePlan, writePlans } from './plan-write.js';
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
  async generate(userId: string, locale: Locale, asked: GeneratePlanRequest): Promise<MealPlan> {
    // A plan that wastes nothing wastes less as well.
    const req = asked.noWaste ? { ...asked, lessWaste: true } : asked;
    if (req.withProfileId) return this.generateJoint(userId, locale, req, req.withProfileId);
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
      lessWaste: req.lessWaste,
      noWaste: req.noWaste,
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
      lessWaste: req.lessWaste,
      noWaste: req.noWaste,
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

  /**
   * Make two plans together (`GeneratePlanRequest.withProfileId`): the profile
   * asked for first, as the request asks, then the other, as its own profile
   * is, on the same days. At the times of day both have, the first plan holds
   * only a dish both may be given, steered by both profiles' favourites and
   * kitchens and held to the stricter of their limits; the second has those
   * dishes locked, its portions and the rest of its days sized to its own
   * targets, and each such meal of the two is linked as one shared meal. A time
   * of day no dish suits both is planned apart in each plan, and both reports
   * say so. Answers the plan of the profile asked for.
   */
  private async generateJoint(
    userId: string,
    locale: Locale,
    req: GeneratePlanRequest,
    withProfileId: string,
  ): Promise<MealPlan> {
    const profiles = [
      await this.plans.loadProfile(userId, req.profileId),
      await this.plans.loadProfile(userId, withProfileId),
    ] as const;
    for (const profile of profiles) await refuseFullProfile(this.prisma, profile.id);
    const start = new Date(req.startDate);
    // The second follows its own profile; the rest of what was asked holds for both.
    const asked = [
      { dietType: req.dietType, mealCount: req.mealCount, target: req.calorieTargetOverride },
      { dietType: undefined, mealCount: undefined, target: undefined },
    ];
    const sides = await Promise.all(
      profiles.map(async (profile, index) => {
        const own = asked[index]!;
        const base = this.planBase(profile, own.target);
        const dietType = own.dietType ?? profile.dietType;
        const days = resolvePlanDays({
          startDate: start,
          durationDays: req.durationDays,
          defaultMealCount: own.mealCount ?? profile.mealCount,
          base,
        });
        const diary = await diaryOfDays(this.prisma, profile.id, days);
        const options: PlanOptions = {
          dietType: own.dietType ?? null,
          mealCount: own.mealCount ?? null,
          calorieTargetOverride: own.target ?? null,
          mealPrepFriendly: req.mealPrepFriendly,
          respectExclusions: req.respectExclusions,
          respectFavorites: req.respectFavorites,
          respectInventory: req.respectInventory,
          lessWaste: req.lessWaste,
          noWaste: req.noWaste,
          maxRepeatsPerRecipe: req.maxRepeatsPerRecipe ?? null,
          allowRelaxations: req.allowRelaxations,
        };
        return {
          profile,
          base,
          dietType,
          macroSplit: splitFor(dietType, profile),
          days: days.map((day) => ({ ...day, kept: keptOfDiary(diary.get(day.isoDate)) })),
          options,
          seed: this.nextSeed(),
        };
      }),
    );
    const [first, second] = sides as [(typeof sides)[number], (typeof sides)[number]];
    const ask = (side: typeof first) => ({
      planTarget: side.base.target,
      dietType: side.dietType,
      macroSplit: side.macroSplit,
      mealPrepFriendly: req.mealPrepFriendly,
      respectExclusions: req.respectExclusions,
      respectFavorites: req.respectFavorites,
      respectInventory: req.respectInventory,
      lessWaste: req.lessWaste,
      noWaste: req.noWaste,
      maxRepeatsPerRecipe: req.maxRepeatsPerRecipe,
      allowRelaxations: req.allowRelaxations,
      seed: side.seed,
    });

    // The times of day both have: without settings of their days, every day of a plan has the same.
    const bothHave = first.days[0]!.mealSlots.filter((slot) =>
      second.days[0]!.mealSlots.includes(slot),
    );
    // What the second may be given on its diet, and its favourite recipes: what the dishes of the shared times are chosen from.
    const theirs = (
      await this.loadEligibleRecipes(userId, second.profile, {
        respectExclusions: req.respectExclusions,
      })
    ).optimizerRecipes;
    // What the plate of either may be given beside a shared dish where their day would stay off its split or target.
    const toppingOptions = await toppingOptionsOf(this.prisma);
    const joint = {
      theirs: new Set(theirs.filter((r) => fitsDiet(r.dietTags, second.dietType)).map((r) => r.id)),
      favorites: new Set(theirs.filter((r) => r.isFavorite).map((r) => r.id)),
      preferences: second.profile.preferences,
      profileId: second.profile.id,
    };
    // A shared time the first plan cannot be filled at, held to what both may be given, is planned apart, and the
    // plan made again without it.
    let sharedAsked = bothHave;
    let drawnFirst: Drawn;
    for (;;) {
      try {
        drawnFirst = await this.drawPlan(userId, first.profile, {
          ...ask(first),
          days: first.days,
          joint: { ...joint, sharedSlots: sharedAsked },
          topped: { slots: 'shared', options: toppingOptions },
        });
        break;
      } catch (err) {
        const named = slotsNamedBy(err).filter((slot) => sharedAsked.includes(slot));
        if (named.length === 0) throw err;
        sharedAsked = sharedAsked.filter((slot) => !named.includes(slot));
      }
    }
    const shared = drawnFirst.shared;
    const apart = bothHave.filter((slot) => !shared.includes(slot));
    // The second plan's meals at the shared times are the first plan's dishes.
    const atShared = drawnFirst.closing.assignments.filter((placed) =>
      shared.includes(placed.slot),
    );
    const locked = second.days.map((day, dayIndex) => ({
      ...day,
      lockedSlots: atShared
        .filter((placed) => placed.dayIndex === dayIndex)
        .map((placed) => ({ slot: placed.slot, recipeId: placed.recipeId })),
    }));
    const drawnSecond = await this.drawPlan(userId, second.profile, {
      ...ask(second),
      days: locked,
      topped: { slots: shared, options: toppingOptions },
    });
    // The two are cooked in one kitchen: their packs are closed together, before the toppings are given, and the
    // rests of the packs go into the meals that finish them after.
    const sharedMeals = atShared.map(({ dayIndex, slot }) => ({ dayIndex, slot }));
    const together = await closeTogether(
      drawnFirst,
      drawnSecond,
      sharedMeals,
      req.lessWaste === true,
    );
    const [ofFirst, ofSecond] = req.lessWaste
      ? await this.withRests(together, [drawnFirst, drawnSecond], sharedMeals)
      : together;

    const planId = await this.prisma.$transaction(async (tx) => {
      // Held in one order, so that two joint plans of the same two profiles asked at once wait for each other.
      for (const id of profiles.map((profile) => profile.id).sort()) await holdProfile(tx, id);
      for (const profile of profiles) await refuseFullProfile(tx, profile.id);
      const joint = await tx.jointPlan.create({ data: { userId } });
      const made: string[] = [];
      for (const [side, result] of [
        [first, ofFirst],
        [second, ofSecond],
      ] as const) {
        if (result.pantryRound)
          await tx.profile.update({
            where: { id: side.profile.id },
            data: pantryCount(result.pantryRound),
          });
        const plan = await tx.mealPlan.create({
          data: {
            profileId: side.profile.id,
            startDate: start,
            durationDays: req.durationDays,
            dietType: side.dietType,
            calorieTarget: side.base.target,
            macroSplit: side.macroSplit ?? Prisma.JsonNull,
            reuseScore: result.ingredientReuseScore,
            options: side.options,
            seed: side.seed,
            report: { ...result.report, apart },
            jointPlanId: joint.id,
            days: { create: buildDays(side.days, result.assignments) },
          },
          select: { id: true },
        });
        made.push(plan.id);
      }
      await linkShared(tx, joint.id, made, null, shared);
      return made[0]!;
    });
    return this.plans.get(userId, locale, planId);
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
              select: {
                id: true,
                mealType: true,
                recipeId: true,
                source: true,
                eatenAt: true,
                leftoverFromDate: true,
              },
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
    options: RegenerateDayRequest & { lessWaste?: boolean; noWaste?: boolean },
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
    // Asked of the whole plan, it is kept with the plan; a part of it is made as the plan is.
    // A plan made again by the whole that is told it wastes less no more wastes nothing either; one that wastes nothing wastes less.
    const noWaste = whole
      ? (options.noWaste ?? (options.lessWaste === false ? false : made.noWaste))
      : made.noWaste;
    const lessWaste = (whole ? (options.lessWaste ?? made.lessWaste) : made.lessWaste) || noWaste;
    const base = this.planBase(profile, made.calorieTargetOverride ?? undefined);
    const dietType = whole ? (made.dietType ?? profile.dietType) : plan.dietType;
    // A plan that is made again takes the split the profile has now; days of it that are filled again, the one the plan was made with.
    const macroSplit = whole ? splitFor(dietType, profile) : storedSplit(plan.macroSplit);

    /** The days that are filled again, by their place in the plan, with the meals that stay on them. */
    const filled: { dayIndex: number; dayId: string; staying: string[] }[] = [];
    // A plan made again shares each week's base among its days as a new plan does.
    const scales = weekScales(plan.days.map(asWeekDay));
    // A topping a staying meal has counts with it, eaten or about to be.
    const toppingPer100 = new Map(
      plan.days.some((day) => day.meals.some((meal) => meal.toppingKey !== null))
        ? (await toppingOptionsOf(this.prisma)).map(
            (option) => [option.topping.key, option.per100] as const,
          )
        : [],
    );
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
        const topping = meal.toppingKey !== null ? toppingPer100.get(meal.toppingKey) : undefined;
        const part = topping ? (meal.toppingAmount ?? 0) / 100 : 0;
        // The rests of packs it finishes count with it.
        const rests = restsOf(meal.rests);
        const plus = (of: 'calories' | 'protein' | 'fat' | 'carbs'): number =>
          (topping?.[of] ?? 0) * part + rests.reduce((sum, rest) => sum + rest.figures[of], 0);
        return {
          recipeId: meal.recipeId ?? undefined,
          calories: perServing.calories * servings + plus('calories'),
          servings,
          macros: {
            protein: perServing.protein * servings + plus('protein'),
            fat: perServing.fat * servings + plus('fat'),
            carbs: perServing.carbs * servings + plus('carbs'),
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

    // In a plan that wastes less, what stays in it, and the other plan of a joint plan, take of the packs: the packs
    // of the days filled again are closed with it.
    const staysOn = (dayIndex: number) => {
      const reading = readings[dayIndex]!;
      const { meals } = plan.days[dayIndex]!;
      if (reading.fate === 'outside' || reading.fate === 'past') return meals;
      const staying = new Set(reading.staying.map((meal) => meal.id));
      return meals.filter((meal) => staying.has(meal.id));
    };
    const fixed: { own: PackedMeal[]; partner: PackedMeal[] } = lessWaste
      ? {
          own: await packedOfDays(
            this.prisma,
            plan.days.map((day, dayIndex) => ({ date: day.date, meals: staysOn(dayIndex) })),
            made.mealPrepFriendly,
          ),
          partner: await partnerPacked(this.prisma, userId, plan),
        }
      : { own: [], partner: [] };

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
      lessWaste,
      noWaste,
      base,
      dietType,
      macroSplit,
      dropIneligibleLocks: options.dropIneligibleLocks,
      fixed,
    };
  }

  /** One way to fill the days that were prepared, by the draws of `seed`. Nothing is written. */
  draw(userId: string, prepared: Prepared, seed: number) {
    return this.drawFor(userId, prepared, seed);
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
    const today = clientToday ?? this.today();
    const jointPlanId = prepared.plan.jointPlanId;
    const partner = jointPlanId
      ? await this.prisma.mealPlan.findFirst({
          where: { jointPlanId, id: { not: planId }, profile: { userId } },
          select: { id: true },
        })
      : null;
    if (options.forAll && partner)
      return this.rerollJoint(userId, prepared, partner.id, range, options, clientToday);

    const seed = this.nextSeed();
    const result = await this.draw(userId, prepared, seed);
    const outcome = await this.outcomeOf(prepared, result, options);
    // Made again for this plan alone, its new meals share nothing: the links of the meals that gave place go with
    // them (`writePlan`), and a meal both ate that stays on its day stays shared.
    await writePlan(this.prisma, planId, prepared.plan.revision, (tx) =>
      this.writeReroll(tx, prepared, result, seed, outcome, today),
    );
  }

  /**
   * Fill the same days of the two plans of a joint plan again
   * (`RegenerateDayRequest.forAll`), as a joint plan is made: this plan first,
   * at the times of day both fill again held to what both may be given, then
   * the other with those dishes locked; each such pair is a shared meal again.
   */
  private async rerollJoint(
    userId: string,
    mine: Prepared,
    partnerId: string,
    range: { from?: string; to?: string },
    options: RegenerateDayRequest,
    clientToday: string | null,
  ): Promise<void> {
    const theirs = await this.prepare(userId, partnerId, range, options, clientToday);
    const today = clientToday ?? this.today();
    // The times of day both fill again, by the date of the day.
    const theirIndex = new Map(
      theirs.filled.map(({ dayIndex }) => [isoDate(theirs.plan.days[dayIndex]!.date), dayIndex]),
    );
    const sharedOn = new Map<string, MealType[]>();
    for (const { dayIndex } of mine.filled) {
      const date = isoDate(mine.plan.days[dayIndex]!.date);
      const other = theirIndex.get(date);
      if (other === undefined || mine.days[dayIndex]!.skip || theirs.days[other]!.skip) continue;
      const slots = mine.days[dayIndex]!.mealSlots.filter((slot) =>
        theirs.days[other]!.mealSlots.includes(slot),
      );
      if (slots.length > 0) sharedOn.set(date, slots);
    }
    const second = theirs.profile;
    const theirRecipes = (
      await this.loadEligibleRecipes(userId, second, {
        respectExclusions: theirs.made.respectExclusions,
      })
    ).optimizerRecipes;
    const joint = {
      theirs: new Set(
        theirRecipes.filter((r) => fitsDiet(r.dietTags, theirs.dietType)).map((r) => r.id),
      ),
      favorites: new Set(theirRecipes.filter((r) => r.isFavorite).map((r) => r.id)),
      preferences: second.preferences,
      profileId: second.id,
    };
    const seed = this.nextSeed();
    // What the plate of either may be given beside a shared dish, as when the plan was made.
    const toppingOptions = await toppingOptionsOf(this.prisma);
    let sharedAsked = [...new Set([...sharedOn.values()].flat())];
    let drawnMine: Drawn;
    for (;;) {
      try {
        drawnMine = await this.drawnFor(
          userId,
          mine,
          seed,
          { ...joint, sharedSlots: sharedAsked },
          { slots: 'shared', options: toppingOptions },
        );
        break;
      } catch (err) {
        const named = slotsNamedBy(err).filter((slot) => sharedAsked.includes(slot));
        if (named.length === 0) throw err;
        sharedAsked = sharedAsked.filter((slot) => !named.includes(slot));
      }
    }
    const shared = drawnMine.shared;
    // The other plan's days filled again hold this plan's dishes at the shared times.
    const myIndex = new Map(
      mine.filled.map(({ dayIndex }) => [isoDate(mine.plan.days[dayIndex]!.date), dayIndex]),
    );
    const atShared: { dayIndex: number; slot: MealType }[] = [];
    for (const [date, slots] of sharedOn) {
      const day = theirs.days[theirIndex.get(date)!]!;
      const placedShared = drawnMine.closing.assignments.filter(
        (placed) =>
          placed.dayIndex === myIndex.get(date) &&
          slots.includes(placed.slot) &&
          shared.includes(placed.slot),
      );
      const locks = placedShared.map((placed) => ({
        slot: placed.slot,
        recipeId: placed.recipeId,
      }));
      day.lockedSlots = [
        ...(day.lockedSlots ?? []).filter((lock) => !locks.some((one) => one.slot === lock.slot)),
        ...locks,
      ];
      // The same day of the other plan is at the same place among its days: the two plans have the same days.
      for (const placed of placedShared)
        if (theirIndex.get(date) === placed.dayIndex)
          atShared.push({ dayIndex: placed.dayIndex, slot: placed.slot });
    }
    const theirSeed = this.nextSeed();
    const drawnTheirs = await this.drawnFor(userId, theirs, theirSeed, undefined, {
      slots: shared,
      options: toppingOptions,
    });
    // The two are cooked in one kitchen: their packs are closed together, before the toppings are given, and the
    // rests of the packs go into the meals that finish them after.
    const together = await closeTogether(drawnMine, drawnTheirs, atShared, mine.lessWaste);
    const [ofMine, ofTheirs] = mine.lessWaste
      ? await this.withRests(together, [drawnMine, drawnTheirs], atShared)
      : together;
    const [mineOutcome, theirOutcome] = await Promise.all([
      this.outcomeOf(mine, ofMine, options),
      this.outcomeOf(theirs, ofTheirs, options),
    ]);
    const jointPlanId = mine.plan.jointPlanId!;
    await writePlans(
      this.prisma,
      [
        { planId: mine.plan.id, revision: mine.plan.revision },
        { planId: theirs.plan.id, revision: theirs.plan.revision },
      ],
      async (tx) => {
        await this.writeReroll(tx, mine, ofMine, seed, mineOutcome, today);
        await this.writeReroll(tx, theirs, ofTheirs, theirSeed, theirOutcome, today);
        const dates = [
          ...new Set([...datesOf(mine), ...datesOf(theirs)].map((date) => date.getTime())),
        ].map((time) => new Date(time));
        await linkShared(tx, jointPlanId, [mine.plan.id, theirs.plan.id], dates, shared);
      },
    );
  }

  /**
   * The draw of `draw`: one plan made again by itself, its packs closed with what
   * stays in it and with the other plan of a joint plan.
   */
  private drawFor(userId: string, prepared: Prepared, seed: number): Promise<Optimised> {
    return this.optimiseFor(
      userId,
      prepared.profile,
      this.askOf(prepared, seed, [...prepared.fixed.own, ...prepared.fixed.partner]),
    );
  }

  /**
   * A draw of one of the two plans of a joint plan made again together, with what
   * planning together asks of it: its packs are closed with the other's after
   * (`closeTogether`).
   */
  private drawnFor(
    userId: string,
    prepared: Prepared,
    seed: number,
    joint?: JointAsk,
    topped?: { slots: readonly MealType[] | 'shared'; options: readonly ToppingOption[] },
  ): Promise<Drawn> {
    return this.drawPlan(userId, prepared.profile, {
      ...this.askOf(prepared, seed, prepared.fixed.own),
      ...(joint ? { joint } : {}),
      ...(topped ? { topped } : {}),
    });
  }

  /** What the optimiser is asked for the days that were prepared. */
  private askOf(prepared: Prepared, seed: number, fixed: readonly PackedMeal[]) {
    return {
      days: prepared.days,
      planTarget: prepared.whole ? prepared.base.target : prepared.plan.calorieTarget,
      dietType: prepared.dietType,
      macroSplit: prepared.macroSplit,
      mealPrepFriendly: prepared.made.mealPrepFriendly,
      respectExclusions: prepared.made.respectExclusions,
      respectFavorites: prepared.made.respectFavorites,
      respectInventory: prepared.made.respectInventory,
      lessWaste: prepared.lessWaste,
      noWaste: prepared.noWaste,
      maxRepeatsPerRecipe: prepared.made.maxRepeatsPerRecipe ?? undefined,
      allowRelaxations: prepared.allowRelaxations,
      dropIneligibleLocks: prepared.dropIneligibleLocks,
      fixed,
      seed,
    };
  }

  /**
   * What a draw of days filled again comes to besides its meals: the meals cooked
   * with the meals that give place, and with which recipe, and the report.
   */
  private async outcomeOf(prepared: Prepared, result: Optimised, options: RegenerateDayRequest) {
    const { plan, filled, dates, whole } = prepared;
    // Each meal that gives place, with the recipe that takes its place: for the meals cooked with it.
    const cookedWith = options.together
      ? await this.plans.cookedWith(this.prisma, plan.id, PlanOptions.parse(plan.options))
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
    return { cookedWith, moves, report };
  }

  /** Write the days of a plan filled again, as `outcomeOf` reads the draw. */
  private async writeReroll(
    tx: Prisma.TransactionClient,
    prepared: Prepared,
    result: Optimised,
    seed: number,
    { cookedWith, moves, report }: Awaited<ReturnType<PlanGenerationService['outcomeOf']>>,
    today: string,
  ): Promise<void> {
    const {
      plan,
      made,
      whole,
      days,
      filled,
      allowRelaxations,
      lessWaste,
      noWaste,
      base,
      dietType,
      macroSplit,
    } = prepared;
    const planId = plan.id;
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
            ...(placed.topping
              ? { toppingKey: placed.topping.key, toppingAmount: placed.topping.amount }
              : {}),
            ...(placed.rests ? { rests: placed.rests } : {}),
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
              options: { ...made, allowRelaxations, lessWaste, noWaste },
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
   * Run the deterministic optimiser for a profile against the eligible recipes,
   * and in a plan that wastes less close the packs it opens (`closePacks`).
   * Takes a fully-resolved per-day descriptor list (slot set + calorie
   * target + locks + skip + cook-time budget + use-up-by per day); the basic
   * flow is just a list of uniform days.
   */
  private async optimiseFor(
    ownerUserId: string,
    profile: Parameters<PlanGenerationService['drawPlan']>[1],
    opts: Parameters<PlanGenerationService['drawPlan']>[2],
  ): Promise<Optimised> {
    const drawn = await this.drawPlan(ownerUserId, profile, opts);
    if (!opts.lessWaste) return drawn.finish(drawn.closing.assignments);
    const [closed] = closePacks({
      plans: [drawn.closing],
      fixed: drawn.fixed,
      packs: drawn.packs,
      pantry: drawn.pantry,
      splitSlack: drawn.level.splitSlack,
    });
    const finished = await drawn.finish(
      closed!,
      kitchenOf([{ ...drawn.closing, assignments: closed! }], [drawn]),
    );
    return (await this.withRests([finished], [drawn]))[0]!;
  }

  /**
   * The plans of one kitchen, as they were finished, with the rests of packs their
   * meals finish (`packRests`) in a plan that wastes less: each rest with what it
   * holds, as the meal keeps it.
   */
  private async withRests(
    finished: readonly Optimised[],
    drawn: readonly Drawn[],
    shared: readonly { dayIndex: number; slot: MealType }[] = [],
  ): Promise<Optimised[]> {
    const optionOf = new Map(
      drawn.flatMap((one) => one.toppingOptions).map((option) => [option.topping.key, option]),
    );
    const packs = new Map(drawn.flatMap((one) => [...one.packs]));
    for (const option of optionOf.values()) if (option.pack) packs.set(option.food.id, option.pack);
    const foods = new Map(
      (
        await this.prisma.ingredient.findMany({
          where: { id: { in: [...packs.keys()] } },
          select: {
            id: true,
            canonicalUnit: true,
            caloriesPer100: true,
            proteinPer100: true,
            fatPer100: true,
            carbsPer100: true,
            fiberPer100: true,
            sugarsPer100: true,
            saltPer100: true,
            saturatedFatPer100: true,
          },
        })
      ).map((food) => [food.id, food]),
    );
    const given = packRests({
      plans: finished.map((plan, p) => ({
        ...drawn[p]!.closing,
        assignments: plan.assignments,
        toppings: new Map(
          plan.assignments.flatMap((meal, index) => {
            const option = meal.topping ? optionOf.get(meal.topping.key) : undefined;
            return option && meal.topping
              ? [
                  [
                    index,
                    {
                      ingredientId: option.food.id,
                      amount: meal.topping.amount,
                      calories: (option.per100.calories * meal.topping.amount) / 100,
                    },
                  ] as const,
                ]
              : [];
          }),
        ),
      })),
      shared,
      fixed: fixedOf(drawn),
      packs,
      energyPer100: new Map([...foods].map(([id, food]) => [id, food.caloriesPer100])),
      caps: drawn[0]!.level.rests,
    });
    return finished.map((plan, p) => ({
      ...plan,
      assignments: plan.assignments.map((meal, index) => {
        const rests = (given[p]!.get(index) ?? []).flatMap((rest) => {
          const food = foods.get(rest.ingredientId);
          const kept = food ? storedRestOf(food, rest) : null;
          return kept ? [kept] : [];
        });
        return rests.length > 0 ? { ...meal, rests } : meal;
      }),
    }));
  }

  /**
   * What the optimiser places for a profile, sized, with what closing its packs
   * needs to know and a step that finishes it: the plan's meals once closed,
   * their toppings, its report. Two plans of a joint plan are drawn each, closed
   * together and finished each.
   */
  private async drawPlan(
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
      /** Lean much harder on the pantry and the packs (`LESS_WASTE_WEIGHTS`), and close the packs after. */
      lessWaste?: boolean;
      /** Of a plan that wastes less, the stricter level: it wastes nothing (`NO_WASTE`). */
      noWaste?: boolean;
      /**
       * What stays in the plan takes of the packs, and of a joint plan made again
       * alone what the other plan takes: what closing the packs counts with.
       */
      fixed?: readonly PackedMeal[];
      /** Variety floor — max total uses of any recipe across the window. */
      maxRepeatsPerRecipe?: number;
      /** The limits that may give way when a meal cannot be filled inside them. */
      allowRelaxations: readonly PlanRelaxation[];
      /**
       * Take a lock that may not enter the plan out of the day, and out of the
       * overrides stored with it, instead of refusing.
       */
      dropIneligibleLocks?: boolean;
      /** Planned together with another profile, whose dishes at the shared times this plan chooses (`JointAsk`). */
      joint?: JointAsk;
      /**
       * Of a plan of a joint plan, the toppings its shared meals may be given: at the times of day named, or at
       * the shared times of `joint`, where the day stays off its split or target (`topAssignments`).
       */
      topped?: { slots: readonly MealType[] | 'shared'; options: readonly ToppingOption[] };
      seed: number;
    },
  ): Promise<Drawn> {
    // The level of a plan that wastes less, where it is one.
    const level = !opts.lessWaste ? null : opts.noWaste ? NO_WASTE : LESS_WASTE;
    const loaded = await this.loadEligibleRecipes(ownerUserId, profile, {
      respectExclusions: opts.respectExclusions,
      ...(level ? { keepDays: level.keepDays } : {}),
    });
    const { requirementsByRecipe, beforeProfileRules, perishablePacks } = loaded;
    const joint = opts.joint;
    // At a time of day both plans share, only a dish both may be given, without what either would rather not eat;
    // the other's favourite recipes are favourites here too.
    const theirDislikes = new Set(joint?.preferences?.dislikedIngredientIds ?? []);
    const ourDislikes = new Set([
      ...(profile.preferences?.dislikedIngredientIds ?? []),
      ...theirDislikes,
    ]);
    const bothMay = (recipe: OptimizerRecipe): boolean =>
      joint !== undefined &&
      joint.theirs.has(recipe.id) &&
      !recipe.ingredientIds.some((id) => ourDislikes.has(id));
    // A time of day no dish suits both at is planned apart in each plan.
    const sharedSlots = new Set(
      (joint?.sharedSlots ?? []).filter((slot) =>
        loaded.optimizerRecipes.some(
          (recipe) =>
            bothMay(recipe) &&
            recipe.mealTypes.includes(slot) &&
            fitsDiet(recipe.dietTags, opts.dietType),
        ),
      ),
    );
    const optimizerRecipes: OptimizerRecipe[] = joint
      ? loaded.optimizerRecipes.map((recipe) =>
          bothMay(recipe)
            ? { ...recipe, isFavorite: recipe.isFavorite || joint.favorites.has(recipe.id) }
            : { ...recipe, mealTypes: recipe.mealTypes.filter((slot) => !sharedSlots.has(slot)) },
        )
      : loaded.optimizerRecipes;

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
        : new Set([
            ...(profile.preferences?.favoriteIngredientIds ?? []),
            ...(joint?.preferences?.favoriteIngredientIds ?? []),
          ]);
    // A plan that wastes less counts the pantry, whatever the request says of it.
    const countsPantry = opts.respectInventory !== false || opts.lessWaste === true;
    const pantry = await this.resolveInventoryBias(
      profile.id,
      countsPantry,
      opts.lessWaste === true,
      optimizerRecipes,
      requirementsByRecipe,
      joint?.profileId,
    );
    const inventoryCoverage = pantry.coverage;

    // Use-up-by: build a per-date coverage map for each flagged day, scored
    // only against stock expiring by that date. Falls back to the plan-level map.
    const expiringByDate = new Map<string, ReadonlyMap<string, number>>();
    if (countsPantry) {
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

    // Planned together, the stricter of the two profiles' limits holds: the dishes it chooses go into both plans.
    const stricter = stricterCaps(
      capsOnARecipe(profile.preferences, opts.mealPrepFriendly),
      joint ? capsOnARecipe(joint.preferences, opts.mealPrepFriendly) : null,
    );
    // A plan that wastes nothing allows the repeats of its level whatever the profiles say, and more where they do.
    const repeats = level?.repeats;
    const caps = repeats
      ? {
          ...stricter,
          consecutive: Math.max(stricter.consecutive, repeats.daysInARow),
          perWeek: Math.max(stricter.perWeek, repeats.timesAWeek),
        }
      : stricter;
    const perKind = stricterKinds(
      mealsPerKind(profile.preferences),
      joint ? mealsPerKind(joint.preferences) : null,
    );

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
    // A plan that names no number is held to the operator's, where one is set.
    const perPlan =
      opts.maxRepeatsPerRecipe ??
      this.config.get('DEFAULT_MAX_REPEATS_PER_RECIPE', { infer: true });
    const disliked = new Set(profile.preferences?.dislikedIngredientIds ?? []);
    try {
      const result = optimisePlan(
        {
          recipes: optimizerRecipes,
          days,
          macroSplit: split,
          dietType: opts.dietType,
          mealPrepFriendly: opts.mealPrepFriendly,
          favoriteIngredientIds,
          dislikedIngredientIds: disliked,
          preferredCuisines: new Set([
            ...(profile.preferences?.preferredCuisines ?? []),
            ...(joint?.preferences?.preferredCuisines ?? []),
          ]),
          inventoryCoverage,
          maxConsecutiveDaysSameMeal: caps.consecutive,
          maxTimesPerWeekSameMeal: caps.perWeek,
          maxRepeatsPerRecipe: perPlan,
          maxMealsPerKind: perKind,
          ...(repeats?.twiceADay ? { twiceADay: true } : {}),
          perishablePacks,
          allowRelaxations: new Set(opts.allowRelaxations),
          seed: opts.seed,
        },
        level?.weights ?? SCORE_WEIGHTS,
      );
      const sized = sizeAssignments(days, optimizerRecipes, result.assignments, split);
      // What stays in the plan, and what another plan of the kitchen takes, with the packs it takes them from.
      const kitchen = menuNeeds(opts.fixed ?? [], days.length);
      const topped = opts.topped;
      return {
        closing: {
          recipes: optimizerRecipes,
          days,
          assignments: sized,
          split,
          dietType: opts.dietType,
          mealPrepFriendly: opts.mealPrepFriendly,
          limits: {
            consecutive: caps.consecutive,
            perWeek: caps.perWeek,
            perPlan,
            perKind,
            ...(repeats?.twiceADay ? { twiceADay: true } : {}),
          },
          dislikedIngredientIds: disliked,
        },
        fixed: kitchen.needs,
        packs: new Map([...kitchen.packs, ...perishablePacks]),
        pantry: pantry.stock,
        toppingOptions: opts.topped?.options ?? [],
        level: level ?? LESS_WASTE,
        shared: [...sharedSlots],
        finish: async (closed, kitchen) => {
          const finished = closedResult(result, closed, days, optimizerRecipes);
          return {
            assignments: topped
              ? await this.topped(
                  days,
                  optimizerRecipes,
                  closed,
                  split,
                  {
                    slots: topped.slots === 'shared' ? [...sharedSlots] : topped.slots,
                    options: topped.options,
                    diet: opts.dietType,
                    preferences: profile.preferences,
                    perKind,
                    respectExclusions: opts.respectExclusions !== false,
                  },
                  kitchen,
                )
              : [...closed],
            ingredientReuseScore: finished.ingredientReuseScore,
            report: reportOf(finished, dates, pantry.use),
            pantryRound: pantry.round,
            shared: [...sharedSlots],
          };
        },
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
   * The sized meals of a plan of a joint plan, each day's meals at `slots` its places for a topping, topped and
   * sized again where the day stays off its split or target; the person is the profile, held to its diet,
   * allergens, rules and the kinds of protein each day has no more meals of.
   */
  private async topped(
    days: readonly OptimizerDay[],
    recipes: readonly OptimizerRecipe[],
    sized: readonly SizedAssignment[],
    split: Macros,
    ask: {
      slots: readonly MealType[];
      options: readonly ToppingOption[];
      diet: string;
      preferences: {
        allergens: string[];
        excludedIngredientIds: string[];
        dislikedIngredientIds: string[];
      } | null;
      perKind: ReadonlyMap<string, { perDay?: number; perWeek?: number }>;
      respectExclusions: boolean;
    },
    /** In a plan that wastes less, the packs of its kitchen, which the toppings are chosen by and taken from. */
    kitchen?: PackKitchen,
  ): Promise<ToppedAssignment[]> {
    const places = sized.filter((meal) => ask.slots.includes(meal.slot));
    const traits = await dishTraitsOf(
      this.prisma,
      places.map((meal) => meal.recipeId),
    );
    const kindsOf = new Map(recipes.map((recipe) => [recipe.id, recipe.proteinKinds ?? []]));
    return topAssignments(
      days,
      recipes,
      sized,
      split,
      (meal) => (ask.slots.includes(meal.slot) ? (traits.get(meal.recipeId) ?? null) : null),
      ask.options,
      (dayIndex) =>
        eaterOf(
          ask.diet,
          ask.preferences,
          fullKindsOn(dayIndex, sized, (recipeId) => kindsOf.get(recipeId) ?? [], ask.perKind),
          ask.respectExclusions,
        ),
      kitchen,
    );
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
    options: {
      respectExclusions?: boolean;
      /** The days an opened pack is to be eaten within: its own, or a level's fewer (`WasteLevel.keepDays`). */
      keepDays?: WasteLevel['keepDays'];
    } = {},
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
    perishablePacks: Map<string, Pack>;
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
                keepDays: true,
                category: true,
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

    // The pack of every ingredient of the pool whose opened pack does not keep, and the days an opened one keeps.
    const perishablePacks = new Map<string, Pack>();
    for (const line of filteredRecipes.flatMap((r) => r.ingredients)) {
      if (line.ingredient.perishable && line.ingredient.packSize)
        perishablePacks.set(line.ingredientId, {
          size: line.ingredient.packSize,
          keepDays: (options.keepDays ?? keepDaysOf)(line.ingredient),
        });
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
   * rotation off. A plan that wastes less (`lessWaste`) is a round like any
   * other but never the one that leaves the pantry out: the plan after it is.
   */
  private async resolveInventoryBias(
    profileId: string,
    respectInventory: boolean,
    lessWaste: boolean,
    optimizerRecipes: OptimizerRecipe[],
    requirementsByRecipe: Map<string, Array<{ ingredientId: string; canonicalQuantity: number }>>,
    /** Another profile whose pantry the plan counts as well: the other of a joint plan. */
    alsoOf?: string,
  ): Promise<{
    use: PantryUse;
    coverage?: Map<string, number>;
    round?: PantryRound;
    /** What the pantry holds of each ingredient, where the plan counts it. */
    stock?: Map<string, number>;
  }> {
    if (!respectInventory) return { use: 'not_asked' };

    const stock = await stockByIngredient(this.prisma, profileId);
    if (alsoOf)
      for (const [ingredientId, quantity] of await stockByIngredient(this.prisma, alsoOf))
        stock.set(ingredientId, (stock.get(ingredientId) ?? 0) + quantity);
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
    if (threshold === 0) return { use: 'counted', coverage, stock };
    const currentStreak = profile?.inventoryBiasStreak ?? 0;
    return currentStreak >= threshold && !lessWaste
      ? { use: 'left_out', round: 'left_out' }
      : { use: 'counted', coverage, round: 'counted', stock };
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

/** What the other profile of a joint plan asks of the plan chosen first, whose dishes at the shared times both eat. */
interface JointAsk {
  /** The times of day both plans have. */
  sharedSlots: readonly MealType[];
  /** The recipes the other profile may be given, on its own diet. */
  theirs: ReadonlySet<string>;
  /** The other profile's favourite recipes. */
  favorites: ReadonlySet<string>;
  /** The other profile's preferences: what it would rather not eat, its favourites, kitchens and limits. */
  preferences:
    | (Parameters<typeof capsOnARecipe>[0] &
        Parameters<typeof mealsPerKind>[0] & {
          dislikedIngredientIds: string[];
          favoriteIngredientIds: string[];
          preferredCuisines: string[];
        })
    | null;
  /** The other profile, whose pantry the plan counts as well. */
  profileId: string;
}

/** A plan read for days of it to be filled again (`prepare`). */
type Prepared = Awaited<ReturnType<PlanGenerationService['prepare']>>;

/** A meal the planner placed, sized, with its topping and the rests of packs it finishes. */
type PlacedMeal = SizedAssignment & {
  topping?: ToppedAssignment['topping'];
  rests?: StoredRest[];
};

/** A plan the optimiser made for a profile, finished: its meals with their toppings, and its report. */
interface Optimised {
  assignments: PlacedMeal[];
  ingredientReuseScore: number;
  report: StoredReport;
  pantryRound?: PantryRound;
  /** Of a joint ask, the times of day the plan holds a dish both may be given at. */
  shared: MealType[];
}

/** A plan the optimiser placed, before its packs are closed (`closePacks`) and it is finished. */
interface Drawn {
  closing: ClosingPlan;
  /** What stays in the plan, and another plan of its kitchen, take of the packs on each day. */
  fixed: Map<string, number[]>;
  packs: Map<string, Pack>;
  /** What the pantry holds of each ingredient, where the plan counts it: closing the packs takes no less of it. */
  pantry?: Map<string, number>;
  /** The toppings its meals may be given: what they take of the packs, and what they hold. */
  toppingOptions: readonly ToppingOption[];
  /** The level of a plan that wastes less it was drawn at: how its packs are closed and what rests its meals take. */
  level: WasteLevel;
  /** Of a joint ask, the times of day the plan holds a dish both may be given at. */
  shared: MealType[];
  /**
   * The plan with `closed` as its meals: their toppings given, its report said.
   * `kitchen`, in a plan that wastes less, holds the packs of the plans cooked
   * together, which the toppings are chosen by and taken from.
   */
  finish: (closed: readonly SizedAssignment[], kitchen?: PackKitchen) => Promise<Optimised>;
}

/** A rest as a meal keeps it: its amount and what that holds, to a tenth; null for one too small to keep. */
function storedRestOf(
  food: {
    canonicalUnit: Unit;
    caloriesPer100: number;
    proteinPer100: number;
    fatPer100: number;
    carbsPer100: number;
    fiberPer100: number | null;
    sugarsPer100: number | null;
    saltPer100: number | null;
    saturatedFatPer100: number | null;
  },
  rest: MealRest,
): StoredRest | null {
  const tenth = (value: number): number => Math.round(value * 10) / 10;
  const amount = tenth(rest.amount);
  if (amount <= 0) return null;
  return {
    ingredientId: rest.ingredientId,
    amount,
    unit: food.canonicalUnit,
    figures: {
      calories: tenth((food.caloriesPer100 * amount) / 100),
      protein: tenth((food.proteinPer100 * amount) / 100),
      fat: tenth((food.fatPer100 * amount) / 100),
      carbs: tenth((food.carbsPer100 * amount) / 100),
    },
    label: roundLabel(labelOfAmount(food, amount)),
  };
}

/**
 * What a run of the optimiser comes to once the packs were closed after it: the
 * meals as closed, the ingredients they share, and no word of a limit that gave
 * way at a meal that was given another recipe, which is inside every limit.
 */
function closedResult(
  result: OptimizerResult,
  closed: readonly SizedAssignment[],
  days: readonly OptimizerDay[],
  recipes: OptimizerRecipe[],
): OptimizerResult {
  const placeOf = (meal: { dayIndex: number; slot: MealType }) => `${meal.dayIndex}:${meal.slot}`;
  const before = new Map(result.assignments.map((meal) => [placeOf(meal), meal.recipeId]));
  const same = new Set(
    closed.filter((meal) => before.get(placeOf(meal)) === meal.recipeId).map(placeOf),
  );
  const staying = days.flatMap((day) =>
    (day.kept ?? []).flatMap((meal) =>
      meal.recipeId !== undefined ? [{ recipeId: meal.recipeId }] : [],
    ),
  );
  return {
    assignments: [...closed],
    ingredientReuseScore: reuseScore([...staying, ...closed], recipes),
    report: {
      ...result.report,
      relaxations: result.report.relaxations.filter((at) => same.has(placeOf(at))),
    },
  };
}

/**
 * The packs of the two plans of a joint plan closed together, in a plan that
 * wastes less: one kitchen, and a meal both eat (at `shared`) swapped in both.
 * Otherwise the plans as they were drawn.
 */
async function closeTogether(
  first: Drawn,
  second: Drawn,
  shared: readonly { dayIndex: number; slot: MealType }[],
  lessWaste: boolean,
): Promise<[Optimised, Optimised]> {
  if (!lessWaste)
    return [
      await first.finish(first.closing.assignments),
      await second.finish(second.closing.assignments),
    ];
  const [mine, theirs] = closePacks({
    plans: [first.closing, second.closing],
    shared,
    fixed: fixedOf([first, second]),
    packs: new Map([...first.packs, ...second.packs]),
    // The first plan counts both pantries (`resolveInventoryBias`).
    pantry: first.pantry ?? second.pantry,
    splitSlack: first.level.splitSlack,
  });
  // One kitchen for the toppings of both: those of the first are there when the second's are chosen.
  const kitchen = kitchenOf(
    [
      { ...first.closing, assignments: mine! },
      { ...second.closing, assignments: theirs! },
    ],
    [first, second],
  );
  return [await first.finish(mine!, kitchen), await second.finish(theirs!, kitchen)];
}

/** What stays in the plans of a kitchen takes of the packs, all of them together. */
function fixedOf(drawn: readonly Drawn[]): Map<string, number[]> {
  const fixed = new Map<string, number[]>();
  for (const [ingredientId, row] of drawn.flatMap((one) => [...one.fixed])) {
    const ours = fixed.get(ingredientId);
    if (ours) row.forEach((amount, day) => (ours[day] = (ours[day] ?? 0) + amount));
    else fixed.set(ingredientId, [...row]);
  }
  return fixed;
}

/** The packs of a kitchen whose plans were closed (`plans`), as their toppings are given. */
function kitchenOf(plans: readonly ClosingPlan[], drawn: readonly Drawn[]): PackKitchen {
  const packs = new Map(drawn.flatMap((one) => [...one.packs]));
  return packKitchen(
    kitchenNeeds(plans, fixedOf(drawn), packs),
    Math.max(0, ...plans.map((plan) => plan.days.length)),
  );
}

/** The dates of the days a re-roll fills again. */
const datesOf = (prepared: Prepared): Date[] =>
  prepared.filled.map(({ dayIndex }) => prepared.plan.days[dayIndex]!.date);

/**
 * Link each dish the two plans of a joint plan hold at the same day and shared
 * time of day as one shared meal, of the meals linked to none: on the days of
 * `dates`, or on every day. A pair linked already keeps its link, and how it
 * is cooked.
 */
async function linkShared(
  tx: Prisma.TransactionClient,
  jointPlanId: string,
  planIds: readonly string[],
  dates: readonly Date[] | null,
  slots: readonly MealType[],
): Promise<void> {
  const meals = await tx.plannedMeal.findMany({
    where: {
      day: { planId: { in: [...planIds] }, ...(dates ? { date: { in: [...dates] } } : {}) },
      mealType: { in: [...slots] },
      sharedMealId: null,
    },
    select: { id: true, mealType: true, recipeId: true, day: { select: { date: true } } },
  });
  const byPlace = new Map<string, typeof meals>();
  for (const meal of meals) {
    const place = `${isoDate(meal.day.date)} ${meal.mealType}`;
    byPlace.set(place, [...(byPlace.get(place) ?? []), meal]);
  }
  for (const both of byPlace.values()) {
    if (both.length !== 2 || !both[0]!.recipeId || both[0]!.recipeId !== both[1]!.recipeId)
      continue;
    // A link of the place whose meals gave place to these two is left with none of them.
    await tx.sharedMeal.deleteMany({
      where: { jointPlanId, date: both[0]!.day.date, mealType: both[0]!.mealType },
    });
    await tx.sharedMeal.create({
      data: {
        jointPlanId,
        date: both[0]!.day.date,
        mealType: both[0]!.mealType,
        meals: { connect: both.map((meal) => ({ id: meal.id })) },
      },
    });
  }
}

/** The times of day a refusal to fill a plan names: of a meal with no recipe left, or of the meals outside a limit. */
function slotsNamedBy(err: unknown): MealType[] {
  if (!(err instanceof BadRequestException || err instanceof UnprocessableEntityException))
    return [];
  const answer = err.getResponse() as { error?: string; details?: unknown };
  if (answer.error === 'NO_ELIGIBLE_RECIPE') {
    const slot = (answer.details as UnfilledMeal | undefined)?.slot;
    return slot ? [slot] : [];
  }
  if (answer.error === 'PLAN_NEEDS_RELAXATION')
    return [...new Set((answer.details as RelaxationNeeded).meals.map((meal) => meal.slot))];
  return [];
}

/** The tighter of two profiles' limits of how often a recipe comes, where there is a second. */
function stricterCaps(
  own: ReturnType<typeof capsOnARecipe>,
  theirs: ReturnType<typeof capsOnARecipe> | null,
): ReturnType<typeof capsOnARecipe> {
  return theirs
    ? {
        consecutive: Math.min(own.consecutive, theirs.consecutive),
        perWeek: Math.min(own.perWeek, theirs.perWeek),
      }
    : own;
}

/** The tighter of two profiles' limits of each kind of protein, where there is a second: a limit of either holds. */
function stricterKinds(
  own: ReturnType<typeof mealsPerKind>,
  theirs: ReturnType<typeof mealsPerKind> | null,
): ReturnType<typeof mealsPerKind> {
  if (!theirs) return own;
  const tighter = (a?: number, b?: number): number | undefined =>
    a === undefined ? b : b === undefined ? a : Math.min(a, b);
  const both = new Map(own);
  for (const [kind, limit] of theirs) {
    const mine = both.get(kind);
    both.set(kind, {
      perDay: tighter(mine?.perDay, limit.perDay),
      perWeek: tighter(mine?.perWeek, limit.perWeek),
    });
  }
  return both;
}

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
function buildDays(resolved: ResolvedDay[], assignments: PlacedMeal[]) {
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
          ...(a.topping ? { toppingKey: a.topping.key, toppingAmount: a.topping.amount } : {}),
          ...(a.rests ? { rests: a.rests } : {}),
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
