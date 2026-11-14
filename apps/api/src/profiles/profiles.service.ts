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
  PACES_OF_LOSS,
  type Profile,
  type ProfileInput,
  type ProfilePatch,
  ProfilePreferences,
  type LabelLimits,
  type ProfilePreferencesPatch,
  type ProfileUpdate,
  riskOfLosingWeight,
  TARGET_REACHED_LATER_DAYS,
  WeightReminderCadence,
} from '@diet-app/shared';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { holdAccount } from '../common/hold.js';
import { storedKindLimits } from '../common/stored-kind-limits.js';
import { labelLimitsOf } from '../common/label-limits.js';
import { storedSplit } from '../common/stored-split.js';
import type { Env } from '../config/env.js';
import { calculateCalories, sharesOf } from '../engine/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { settleHouseholds } from '../shopping-lists/shopping-lists.service.js';
import { calorieInputOf } from './calorie-input.js';

type WeeklyTarget = '0.25' | '0.5' | '0.75' | '1.0' | null;

/**
 * When the risk of losing weight counts as acknowledged, after this save.
 * Only somebody under 18 or underweight has anything to acknowledge: for
 * anybody else the time is cleared. Sent as true it is set (and an earlier
 * time kept), sent as false it is withdrawn, not sent it stays as it was.
 */
function acknowledgedAt(
  input: { age: number; heightCm: number; weightKg: number; acknowledgeRisk?: boolean },
  before: Date | null,
): Date | null {
  if (riskOfLosingWeight(input).length === 0) return null;
  if (input.acknowledgeRisk === undefined) return before;
  return input.acknowledgeRisk ? (before ?? new Date()) : null;
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
          riskAcknowledgedAt: acknowledgedAt(input, null),
          customMacroSplit: input.customMacroSplit ?? Prisma.JsonNull,
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
        riskAcknowledgedAt: acknowledgedAt(input, before.riskAcknowledgedAt),
        customMacroSplit: input.customMacroSplit ?? Prisma.JsonNull,
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
   * split. The word given about the risk of losing weight goes by the figures
   * the profile has after the change.
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
    const { acknowledgeRisk, customMacroSplit, ...parts } = patch;
    const row = await this.prisma.profile.update({
      where: { id },
      data: {
        ...parts,
        ...(customMacroSplit === undefined
          ? {}
          : { customMacroSplit: customMacroSplit ?? Prisma.JsonNull }),
        riskAcknowledgedAt: acknowledgedAt(
          { ...after, acknowledgeRisk },
          before.riskAcknowledgedAt,
        ),
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
    // that plan's list alone.
    await this.prisma.$transaction(async (tx) => {
      const parts = await tx.shoppingList.findMany({
        where: { plan: { profileId: id }, householdId: { not: null } },
        select: { householdId: true },
      });
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
      riskAcknowledged: typed.acknowledgeRisk,
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
    riskAcknowledgedAt: Date | null;
    customMacroSplit: unknown;
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
      riskAcknowledgedAt: row.riskAcknowledgedAt?.toISOString() ?? null,
      mealCount: row.mealCount,
      weightReminderCadence: WeightReminderCadence.parse(row.weightReminderCadence),
      cookingReminders: row.cookingReminders,
      waterReminders: row.waterReminders,
      customMacroSplit: storedSplit(row.customMacroSplit),
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
