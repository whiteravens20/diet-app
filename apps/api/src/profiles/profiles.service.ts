import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  type CalorieCalculation,
  MAX_PROFILES_PER_ACCOUNT,
  type Profile,
  type ProfileInput,
  WeightReminderCadence,
} from '@diet-app/shared';
import { calculateCalories } from '../engine/index.js';
import { PrismaService } from '../prisma/prisma.service.js';

type WeeklyTarget = '0.25' | '0.5' | '0.75' | '1.0' | null;

@Injectable()
export class ProfilesService {
  constructor(private readonly prisma: PrismaService) {}

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
    const count = await this.prisma.profile.count({ where: { userId } });
    if (count >= MAX_PROFILES_PER_ACCOUNT) {
      throw new ConflictException({
        error: 'PROFILE_LIMIT_REACHED',
        message: `An account can have at most ${MAX_PROFILES_PER_ACCOUNT} profiles. Delete one to add another.`,
      });
    }
    const row = await this.prisma.profile.create({
      data: {
        userId,
        name: input.name,
        age: input.age,
        sex: input.sex,
        heightCm: input.heightCm,
        weightKg: input.weightKg,
        activityLevel: input.activityLevel,
        dietType: input.dietType,
        weeklyLossTarget: input.weeklyLossTarget,
        manualCalorieTarget: input.manualCalorieTarget,
        mealCount: input.mealCount,
        weightReminderCadence: input.weightReminderCadence,
        preferences: { create: input.preferences },
      },
      include: { preferences: true },
    });
    return this.toDto(row);
  }

  async update(userId: string, id: string, input: ProfileInput): Promise<Profile> {
    await this.load(userId, id);
    const row = await this.prisma.profile.update({
      where: { id },
      data: {
        name: input.name,
        age: input.age,
        sex: input.sex,
        heightCm: input.heightCm,
        weightKg: input.weightKg,
        activityLevel: input.activityLevel,
        dietType: input.dietType,
        weeklyLossTarget: input.weeklyLossTarget,
        manualCalorieTarget: input.manualCalorieTarget,
        mealCount: input.mealCount,
        weightReminderCadence: input.weightReminderCadence,
        preferences: { upsert: { create: input.preferences, update: input.preferences } },
      },
      include: { preferences: true },
    });
    return this.toDto(row);
  }

  async remove(userId: string, id: string): Promise<void> {
    await this.load(userId, id);
    await this.prisma.profile.delete({ where: { id } });
  }

  /** Deterministic calorie/macro calculation for a profile. */
  async calories(userId: string, id: string): Promise<CalorieCalculation> {
    const p = await this.load(userId, id);
    return calculateCalories({
      age: p.age,
      sex: p.sex,
      heightCm: p.heightCm,
      weightKg: p.weightKg,
      activityLevel: p.activityLevel,
      dietType: p.dietType,
      weeklyLossTarget: p.weeklyLossTarget as WeeklyTarget,
      manualCalorieTarget: p.manualCalorieTarget,
    });
  }

  private async load(userId: string, id: string) {
    const row = await this.prisma.profile.findUnique({ where: { id }, include: { preferences: true } });
    if (!row) throw new NotFoundException({ error: 'PROFILE_NOT_FOUND', message: 'Profile not found.' });
    if (row.userId !== userId) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Profile belongs to another user.' });
    }
    return row;
  }

  /** Maps a Prisma row (+ preferences) to the shared Profile contract. */
  private toDto(row: {
    id: string;
    userId: string;
    name: string;
    age: number;
    sex: 'male' | 'female' | null;
    heightCm: number;
    weightKg: number;
    activityLevel: Profile['activityLevel'];
    dietType: Profile['dietType'];
    weeklyLossTarget: string | null;
    manualCalorieTarget: number | null;
    mealCount: number;
    weightReminderCadence: string;
    createdAt: Date;
    updatedAt: Date;
    preferences: {
      favoriteIngredientIds: string[];
      excludedIngredientIds: string[];
      allergens: string[];
      dislikedFoods: string[];
      preferredCuisines: string[];
      maxConsecutiveDaysSameMeal: number;
      maxTimesPerWeekSameMeal: number;
      inventoryBiasResetEvery: number;
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
      activityLevel: row.activityLevel,
      dietType: row.dietType,
      weeklyLossTarget: row.weeklyLossTarget as WeeklyTarget,
      manualCalorieTarget: row.manualCalorieTarget,
      mealCount: row.mealCount,
      weightReminderCadence: WeightReminderCadence.parse(row.weightReminderCadence),
      preferences: {
        favoriteIngredientIds: row.preferences?.favoriteIngredientIds ?? [],
        excludedIngredientIds: row.preferences?.excludedIngredientIds ?? [],
        allergens: (row.preferences?.allergens ?? []) as Profile['preferences']['allergens'],
        dislikedFoods: row.preferences?.dislikedFoods ?? [],
        preferredCuisines: row.preferences?.preferredCuisines ?? [],
        maxConsecutiveDaysSameMeal: row.preferences?.maxConsecutiveDaysSameMeal ?? 2,
        maxTimesPerWeekSameMeal: row.preferences?.maxTimesPerWeekSameMeal ?? 3,
        inventoryBiasResetEvery: row.preferences?.inventoryBiasResetEvery ?? 5,
      },
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
