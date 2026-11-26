// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  type CalorieCalculation,
  type CaloriePreview,
  type CaloriePreviewRequest,
  Cuisine,
  dayAfter,
  type MacroSplit,
  PACES_OF_LOSS,
  proteinPerKgThatFits,
  type Profile,
  type ProfileInput,
  type ProfilePatch,
  ProfilePreferences,
  type LabelLimits,
  type ProfilePreferencesPatch,
  type ProfileUpdate,
  TARGET_REACHED_LATER_DAYS,
  WeightReminderCadence,
} from '@diet-app/shared';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { holdAccount } from '../common/hold.js';
import { storedKindLimits } from '../common/stored-kind-limits.js';
import { labelLimitsOf } from '../common/label-limits.js';
import { storedSplit } from '../common/stored-split.js';
import { refuseUnderLeast } from '../common/typed-target.js';
import type { Env } from '../config/env.js';
import {
  calculateCalories,
  ownSplit,
  proteinKcalOf,
  sharesOf,
  wholePercent,
} from '../engine/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { forgetLender, settleHouseholds } from '../shopping-lists/shopping-lists.service.js';
import { calorieInputOf, type CalorieProfile } from './calorie-input.js';

type WeeklyTarget = '0.25' | '0.5' | '0.75' | '1.0' | null;

/**
 * Refuse a typed target under the least this body may type, where the request
 * changes it: a request that resends a target kept from before that least, or
 * changes the body under it, is not refused for it.
 */
function refuseTargetUnderLeast(
  profile: CalorieProfile,
  before?: { manualCalorieTarget: number | null },
): void {
  const typed = profile.manualCalorieTarget;
  if (typed === null || typed === before?.manualCalorieTarget) return;
  refuseUnderLeast(
    typed,
    calculateCalories(calorieInputOf(profile)).leastTypedTarget,
    'manualCalorieTarget',
  );
}

@Injectable()
export class ProfilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async list(userId: string): Promise<Profile[]> {
    const rows = await this.prisma.profile.findMany({
      where: { userId },
      include: { preferences: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => this.toDto(r));
  }

  async get(userId: string, id: string): Promise<Profile> {
    return this.toDto(await this.load(userId, id));
  }

  async create(userId: string, input: ProfileInput): Promise<Profile> {
    refuseHeldProtein({ ...input, expenditureCorrectionKcal: null });
    refuseTargetUnderLeast({ ...input, expenditureCorrectionKcal: null });
    const row = await this.prisma.$transaction(async (tx) => {
      await holdAccount(tx, userId);
      // The instance's own number. An account that holds more than a lowered number keeps what it has.
      const most = this.config.get('MAX_PROFILES_PER_ACCOUNT', { infer: true });
      const count = await tx.profile.count({ where: { userId } });
      if (count >= most) {
        throw new ConflictException({
          error: 'PROFILE_LIMIT_REACHED',
          message: `An account can have at most ${most} profiles on this instance. Delete one to add another.`,
        });
      }
      return tx.profile.create({
        data: {
          userId,
          name: input.name,
          age: input.age,
          sex: input.sex,
          heightCm: input.heightCm,
          weightKg: input.weightKg,
          targetWeightKg: input.targetWeightKg,
          waterTargetMl: input.waterTargetMl,
          waterTracking: input.waterTracking,
          activityLevel: input.activityLevel,
          dietType: input.dietType,
          weeklyLossTarget: input.weeklyLossTarget,
          manualCalorieTarget: input.manualCalorieTarget,
          customMacroSplit: input.customMacroSplit ?? Prisma.JsonNull,
          customProteinPerKg: input.customProteinPerKg,
          mealCount: input.mealCount,
          weightReminderCadence: input.weightReminderCadence,
          cookingReminders: input.cookingReminders,
          waterReminders: input.waterReminders,
          preferences: { create: preferenceColumns(input.preferences) },
        },
        include: { preferences: true },
      });
    });
    return this.toDto(row);
  }

  /**
   * Change some preferences of a profile. A profile gets its preferences
   * when it is made; one from before that was so gets them here, with what a
   * new profile starts with for the parts the change does not name.
   */
  async patchPreferences(
    userId: string,
    id: string,
    patch: ProfilePreferencesPatch,
  ): Promise<Profile> {
    await this.load(userId, id);
    const row = await this.prisma.profile.update({
      where: { id },
      data: {
        preferences: {
          upsert: {
            create: preferenceColumns(ProfilePreferences.parse(patch)),
            update: preferenceColumns(patch),
          },
        },
      },
      include: { preferences: true },
    });
    return this.toDto(row);
  }

  async update(userId: string, id: string, input: ProfileUpdate): Promise<Profile> {
    const before = await this.load(userId, id);
    refuseHeldProtein({ ...before, ...input }, before);
    refuseTargetUnderLeast({ ...before, ...input }, before);
    const row = await this.prisma.profile.update({
      where: { id },
      data: {
        name: input.name,
        age: input.age,
        sex: input.sex,
        heightCm: input.heightCm,
        weightKg: input.weightKg,
        targetWeightKg: input.targetWeightKg,
        // Left out by a client from before the target of water, it stays as it is.
        ...(input.waterTargetMl === undefined ? {} : { waterTargetMl: input.waterTargetMl }),
        ...(input.waterTracking === undefined ? {} : { waterTracking: input.waterTracking }),
        activityLevel: input.activityLevel,
        dietType: input.dietType,
        weeklyLossTarget: input.weeklyLossTarget,
        manualCalorieTarget: input.manualCalorieTarget,
        customMacroSplit: input.customMacroSplit ?? Prisma.JsonNull,
        customProteinPerKg: input.customProteinPerKg,
        mealCount: input.mealCount,
        weightReminderCadence: input.weightReminderCadence,
        // Left out by a client from before the reminders, they stay as they are.
        ...(input.cookingReminders === undefined
          ? {}
          : { cookingReminders: input.cookingReminders }),
        ...(input.waterReminders === undefined ? {} : { waterReminders: input.waterReminders }),
        preferences: {
          upsert: {
            create: preferenceColumns(input.preferences),
            update: preferenceColumns(input.preferences),
          },
        },
      },
      include: { preferences: true },
    });
    return this.toDto(row);
  }

  /**
   * Change some parts of a profile: what the patch names, and nothing else.
   * Its preferences stay as they are, so a change of the profile sent while
   * another of its preferences was on its way takes nothing back. The profile
   * it makes is held to what a whole one is: on the custom diet it has its
   * split. A client of before may still send its word about the risk of
   * losing weight: it is taken and ignored.
   */
  async patch(userId: string, id: string, patch: ProfilePatch): Promise<Profile> {
    const before = await this.load(userId, id);
    const after = {
      dietType: patch.dietType ?? before.dietType,
      customMacroSplit:
        patch.customMacroSplit !== undefined
          ? patch.customMacroSplit
          : storedSplit(before.customMacroSplit),
      age: patch.age ?? before.age,
      heightCm: patch.heightCm ?? before.heightCm,
      weightKg: patch.weightKg ?? before.weightKg,
    };
    // A change that names the split without protein per kilogram is of the split's way: a client
    // that knows only the split says the whole of what the custom diet aims at.
    const customProteinPerKg =
      patch.customProteinPerKg !== undefined
        ? patch.customProteinPerKg
        : patch.customMacroSplit !== undefined
          ? null
          : before.customProteinPerKg;
    if (after.dietType === 'custom' && after.customMacroSplit === null)
      throw new BadRequestException({
        statusCode: 400,
        error: 'VALIDATION_FAILED',
        message: 'Request payload failed validation.',
        issues: [
          {
            path: 'customMacroSplit',
            message: 'The custom diet needs its split of protein, fat and carbohydrate.',
            code: 'custom',
          },
        ],
      });
    refuseHeldProtein(
      { ...before, ...patch, customMacroSplit: after.customMacroSplit, customProteinPerKg },
      before,
    );
    const { customMacroSplit, ...parts } = patch;
    // A client of before may still send its word about the risk of losing weight: it is no part of the profile.
    delete parts.acknowledgeRisk;
    refuseTargetUnderLeast(
      { ...before, ...parts, customMacroSplit: after.customMacroSplit, customProteinPerKg },
      before,
    );
    const row = await this.prisma.profile.update({
      where: { id },
      data: {
        ...parts,
        ...(customMacroSplit === undefined
          ? {}
          : { customMacroSplit: customMacroSplit ?? Prisma.JsonNull }),
        customProteinPerKg,
      },
      include: { preferences: true },
    });
    return this.toDto(row);
  }

  /**
   * Keep the weight once the target weight is reached: the pace becomes
   * keeping the weight, and the offer goes. A running plan then says that the
   * profile's target moved, and offers it from today.
   */
  async keepWeight(userId: string, id: string): Promise<Profile> {
    await this.load(userId, id);
    const row = await this.prisma.profile.update({
      where: { id },
      data: { weeklyLossTarget: null, targetReachedLaterUntil: null },
      include: { preferences: true },
    });
    return this.toDto(row);
  }

  /** Put the offer to keep the weight off for `TARGET_REACHED_LATER_DAYS` days from `today`, the client's day. */
  async putOffKeepingWeight(userId: string, id: string, today: string | null): Promise<Profile> {
    await this.load(userId, id);
    const from = today ?? new Date().toISOString().slice(0, 10);
    const row = await this.prisma.profile.update({
      where: { id },
      data: { targetReachedLaterUntil: new Date(dayAfter(from, TARGET_REACHED_LATER_DAYS)) },
      include: { preferences: true },
    });
    return this.toDto(row);
  }

  async remove(userId: string, id: string): Promise<void> {
    await this.load(userId, id);
    // The profile takes its plans and their lists with it, and the household
    // lists they were parts of their parts: one left with a single part is
    // that plan's list alone. What those lists and the profile's pantry were
    // counted on for in each other's is settled first.
    await this.prisma.$transaction(async (tx) => {
      const parts = await tx.shoppingList.findMany({
        where: { plan: { profileId: id }, householdId: { not: null } },
        select: { householdId: true },
      });
      await forgetLender(tx, id);
      // A plan made together with one of the profile's leaves the other a plan of its own.
      await tx.jointPlan.deleteMany({ where: { plans: { some: { profileId: id } } } });
      await tx.profile.delete({ where: { id } });
      await settleHouseholds(
        tx,
        parts.map((part) => part.householdId!),
      );
    });
  }

  /** Deterministic calorie/macro calculation for a profile. */
  async calories(userId: string, id: string): Promise<CalorieCalculation> {
    return calculateCalories(calorieInputOf(await this.load(userId, id)));
  }

  /**
   * The same calculation for figures somebody typed, and for the same body at
   * each pace of loss: nothing is read from a profile and nothing is kept.
   */
  previewCalories(typed: CaloriePreviewRequest): CaloriePreview {
    const body = {
      age: typed.age,
      sex: typed.sex,
      heightCm: typed.heightCm,
      weightKg: typed.weightKg,
      activityLevel: typed.activityLevel,
      dietType: typed.dietType,
      customMacroSplit: sharesOf(typed.customMacroSplit),
      customProteinPerKg: typed.customProteinPerKg,
      expenditureCorrection: typed.expenditureCorrection,
    };
    return {
      calculation: calculateCalories({
        ...body,
        weeklyLossTarget: typed.weeklyLossTarget,
        manualCalorieTarget: typed.manualCalorieTarget,
      }),
      paces: PACES_OF_LOSS.map((pace) =>
        calculateCalories({ ...body, weeklyLossTarget: pace, manualCalorieTarget: null }),
      ),
    };
  }

  private async load(userId: string, id: string) {
    const row = await this.prisma.profile.findUnique({
      where: { id },
      include: { preferences: true },
    });
    if (!row || row.userId !== userId)
      throw new NotFoundException({ error: 'PROFILE_NOT_FOUND', message: 'Profile not found.' });
    return row;
  }

  /** Maps a Prisma row (+ preferences) to the shared Profile contract. */
  private toDto(row: {
    id: string;
    userId: string;
    name: string;
    age: number;
    sex: Profile['sex'];
    heightCm: number;
    weightKg: number;
    targetWeightKg: number | null;
    waterTargetMl: number | null;
    waterTracking: boolean;
    expenditureCorrectionKcal: number | null;
    targetReachedLaterUntil: Date | null;
    activityLevel: Profile['activityLevel'];
    dietType: Profile['dietType'];
    weeklyLossTarget: string | null;
    manualCalorieTarget: number | null;
    customMacroSplit: unknown;
    customProteinPerKg: number | null;
    mealCount: number;
    weightReminderCadence: string;
    cookingReminders: boolean;
    waterReminders: boolean;
    createdAt: Date;
    updatedAt: Date;
    preferences: {
      favoriteIngredientIds: string[];
      excludedIngredientIds: string[];
      allergens: string[];
      dislikedIngredientIds: string[];
      preferredCuisines: string[];
      maxConsecutiveDaysSameMeal: number;
      maxTimesPerWeekSameMeal: number;
      maxMealsPerDaySameKind: number | null;
      maxMealsPerWeekSameKind: number | null;
      kindLimits: unknown;
      inventoryBiasResetEvery: number;
      saltAtMost: number | null;
      fiberAtLeast: number | null;
      saturatedFatAtMost: number | null;
      sugarsAtMost: number | null;
    } | null;
  }): Profile {
    return {
      id: row.id,
      userId: row.userId,
      name: row.name,
      age: row.age,
      sex: row.sex,
      heightCm: row.heightCm,
      weightKg: row.weightKg,
      targetWeightKg: row.targetWeightKg,
      waterTargetMl: row.waterTargetMl,
      waterTracking: row.waterTracking,
      expenditureCorrectionKcal: row.expenditureCorrectionKcal,
      // The newest weight came down to the one worked towards, and the pace that loses still sets the target.
      targetWeightReached:
        row.targetWeightKg !== null &&
        row.weightKg <= row.targetWeightKg &&
        row.weeklyLossTarget !== null &&
        row.manualCalorieTarget === null,
      targetReachedLaterUntil: row.targetReachedLaterUntil
        ? row.targetReachedLaterUntil.toISOString().slice(0, 10)
        : null,
      activityLevel: row.activityLevel,
      dietType: row.dietType,
      weeklyLossTarget: row.weeklyLossTarget as WeeklyTarget,
      manualCalorieTarget: row.manualCalorieTarget,
      mealCount: row.mealCount,
      weightReminderCadence: WeightReminderCadence.parse(row.weightReminderCadence),
      cookingReminders: row.cookingReminders,
      waterReminders: row.waterReminders,
      customMacroSplit: splitAsItComesOut(row),
      customProteinPerKg: row.customProteinPerKg,
      preferences: {
        favoriteIngredientIds: row.preferences?.favoriteIngredientIds ?? [],
        excludedIngredientIds: row.preferences?.excludedIngredientIds ?? [],
        allergens: (row.preferences?.allergens ?? []) as Profile['preferences']['allergens'],
        dislikedIngredientIds: row.preferences?.dislikedIngredientIds ?? [],
        preferredCuisines: (row.preferences?.preferredCuisines ?? []).filter(
          (kept): kept is Cuisine => Cuisine.safeParse(kept).success,
        ),
        maxConsecutiveDaysSameMeal: row.preferences?.maxConsecutiveDaysSameMeal ?? 2,
        maxTimesPerWeekSameMeal: row.preferences?.maxTimesPerWeekSameMeal ?? 3,
        maxMealsPerDaySameKind: row.preferences?.maxMealsPerDaySameKind ?? null,
        maxMealsPerWeekSameKind: row.preferences?.maxMealsPerWeekSameKind ?? null,
        kindLimits: storedKindLimits(row.preferences?.kindLimits),
        inventoryBiasResetEvery: row.preferences?.inventoryBiasResetEvery ?? 5,
        labelLimits: labelLimitsOf(row.preferences),
      },
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

/**
 * Preferences as their row keeps them: the limits of a label in columns of their own. Limits that
 * are left out are left as they are.
 */
function preferenceColumns<T extends { labelLimits?: LabelLimits }>(
  preferences: T,
): Omit<T, 'labelLimits'> & Partial<LabelLimits> {
  const { labelLimits, ...rest } = preferences;
  return { ...rest, ...labelLimits };
}

/** What a profile's target and its custom diet's split are worked out from. */
type OwnSplitOf = CalorieProfile;

/**
 * The custom diet's split of a profile at its target, as whole per cent: the
 * split as it is, or, where protein is per kilogram, what that and the
 * split's fat come to. A client that reads the split alone is shown it.
 */
function splitAsItComesOut(profile: OwnSplitOf): MacroSplit | null {
  const split = storedSplit(profile.customMacroSplit);
  if (!split || profile.customProteinPerKg == null) return split;
  const target = calculateCalories({ ...calorieInputOf(profile), dietType: 'custom' }).dailyTarget;
  const own = ownSplit(
    sharesOf(split)!,
    proteinKcalOf(profile.customProteinPerKg, profile.weightKg),
    target,
  );
  return wholePercent(own.shares) as MacroSplit;
}

/**
 * Refuse protein per kilogram that, at the profile's target and weight, puts
 * a share of the day outside the limits of a split: the form says which grams
 * fit, here they are named for a client that sent others. Only targets set
 * anew are refused, protein per kilogram or the share of fat it goes with, as
 * they are on a new profile or differ from those of the profile `before` the
 * change. Later, a weight or a target that takes them outside holds protein
 * at the limit, and the profile says so (`customSplitHeld`).
 */
function refuseHeldProtein(profile: OwnSplitOf, before?: OwnSplitOf): void {
  const split = storedSplit(profile.customMacroSplit);
  if (!split || profile.customProteinPerKg == null) return;
  const kept =
    before !== undefined &&
    before.customProteinPerKg === profile.customProteinPerKg &&
    storedSplit(before.customMacroSplit)?.fat === split.fat;
  if (kept) return;
  const target = calculateCalories({ ...calorieInputOf(profile), dietType: 'custom' }).dailyTarget;
  const asked = proteinKcalOf(profile.customProteinPerKg, profile.weightKg);
  if (!ownSplit(sharesOf(split)!, asked, target).held) return;
  const fits = proteinPerKgThatFits(split.fat / 100, target, profile.weightKg);
  throw new BadRequestException({
    statusCode: 400,
    error: 'VALIDATION_FAILED',
    message: 'Request payload failed validation.',
    issues: [
      {
        path: 'customProteinPerKg',
        message: fits
          ? `At this target and weight protein per kilogram fits from ${fits.from} to ${fits.to} g.`
          : 'At this target, weight and share of fat no protein per kilogram keeps every share inside its limits.',
        code: 'custom',
      },
    ],
  });
}
