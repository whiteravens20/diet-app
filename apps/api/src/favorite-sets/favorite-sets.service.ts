import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  ApplyFavoriteSetRequest,
  CreateFavoriteSetRequest,
  FavoriteSet,
  FavoriteSetSlots,
  Locale,
  MealPlan,
  MealType,
  UpdateFavoriteSetRequest,
} from '@diet-app/shared';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { MealPlansService } from '../meal-plans/meal-plans.service.js';
import { fitServings, slotBudgets } from '../engine/index.js';

/**
 * Per-profile saved day templates. The "apply" action rewrites the planned
 * meals for the requested day-dates slot-by-slot from the set; slots the set
 * doesn't define are left untouched on the target day. Cross-cutting integrity
 * (recipe existence, plan ownership) is enforced here so the meal-plans
 * module's swap path stays focused on single-slot edits.
 */
@Injectable()
export class FavoriteSetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mealPlans: MealPlansService,
  ) {}

  async list(userId: string, profileId: string): Promise<FavoriteSet[]> {
    await this.assertProfile(userId, profileId);
    const rows = await this.prisma.favoriteSet.findMany({
      where: { profileId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toDto);
  }

  async create(userId: string, dto: CreateFavoriteSetRequest): Promise<FavoriteSet> {
    await this.assertProfile(userId, dto.profileId);
    await this.assertRecipes(Object.values(dto.slots));
    const row = await this.prisma.favoriteSet.create({
      data: {
        profileId: dto.profileId,
        label: dto.label,
        slots: dto.slots,
      },
    });
    return toDto(row);
  }

  async update(userId: string, id: string, dto: UpdateFavoriteSetRequest): Promise<FavoriteSet> {
    const set = await this.load(userId, id);
    if (dto.slots) await this.assertRecipes(Object.values(dto.slots));
    const row = await this.prisma.favoriteSet.update({
      where: { id: set.id },
      data: {
        ...(dto.label !== undefined ? { label: dto.label } : {}),
        ...(dto.slots !== undefined ? { slots: dto.slots } : {}),
      },
    });
    return toDto(row);
  }

  async remove(userId: string, id: string): Promise<void> {
    const set = await this.load(userId, id);
    await this.prisma.favoriteSet.delete({ where: { id: set.id } });
  }

  async apply(
    userId: string,
    locale: Locale,
    id: string,
    req: ApplyFavoriteSetRequest,
  ): Promise<MealPlan> {
    const set = await this.load(userId, id);
    const slots = parseSlots(set.slots);
    const slotEntries = Object.entries(slots);
    if (slotEntries.length === 0) {
      throw new BadRequestException({ error: 'EMPTY_SET', message: 'Favorite set has no slots.' });
    }

    const plan = await this.prisma.mealPlan.findUnique({
      where: { id: req.planId },
      include: { profile: true, days: true },
    });
    if (!plan) throw new NotFoundException({ error: 'PLAN_NOT_FOUND', message: 'Meal plan not found.' });
    if (plan.profile.userId !== userId) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Plan belongs to another user.' });
    }
    if (plan.profileId !== set.profileId) {
      throw new ForbiddenException({
        error: 'FORBIDDEN',
        message: 'Favorite set belongs to a different profile.',
      });
    }

    const requested = new Set(req.dayDates);
    const targetDays = plan.days.filter((d) => requested.has(d.date.toISOString().slice(0, 10)));
    if (targetDays.length === 0) {
      throw new NotFoundException({ error: 'DAY_NOT_FOUND', message: 'No matching day in plan.' });
    }

    // Recipe calories drive the per-slot serving rescale below; fetch once.
    const caloriesById = new Map(
      (
        await this.prisma.recipe.findMany({
          where: { id: { in: slotEntries.map(([, recipeId]) => recipeId) } },
          select: { id: true, caloriesPerServing: true },
        })
      ).map((r) => [r.id, r.caloriesPerServing]),
    );

    await this.prisma.$transaction(async (tx) => {
      for (const day of targetDays) {
        const existing = await tx.plannedMeal.findMany({
          where: { dayId: day.id },
          select: { id: true, mealType: true },
        });
        const existingByType = new Map(existing.map((m) => [m.mealType, m]));
        // Budgets weight by the full slot set the day will have after apply
        // (the meals already there plus the set's slots), so each slot gets its
        // correct share of the per-day calorie target. `day.calorieTarget` is
        // the per-day target the generator persisted — the same value F17 will
        // override per day and F22's quantity rebalancer reads at edit time —
        // so a set applied here lands inside the plan's calorie window via
        // `fitServings` instead of dumping a flat 1 serving of each recipe.
        const slotTypes = new Set<MealType>([
          ...existing.map((m) => m.mealType as MealType),
          ...slotEntries.map(([mealType]) => mealType as MealType),
        ]);
        const budgets = slotBudgets([...slotTypes], day.calorieTarget);

        for (const [mealType, recipeId] of slotEntries) {
          const budget = budgets.get(mealType as MealType) ?? day.calorieTarget;
          const servings = fitServings(caloriesById.get(recipeId) ?? 0, budget);
          const current = existingByType.get(mealType);
          if (current) {
            await tx.plannedMeal.update({
              where: { id: current.id },
              data: { recipeId, servings, swapHistory: [recipeId] },
            });
          } else {
            await tx.plannedMeal.create({
              data: { dayId: day.id, mealType, recipeId, servings, swapHistory: [recipeId] },
            });
          }
        }

        // F17: applying a set to a skipped day un-skips it — it now has meals,
        // so a lingering `skip` flag would misrender the day and exclude it from
        // the shopping list. Strip just that key, preserving the rest.
        const ov = day.overrides;
        if (ov && typeof ov === 'object' && !Array.isArray(ov) && (ov as { skip?: boolean }).skip) {
          const rest: Record<string, unknown> = { ...(ov as Record<string, unknown>) };
          delete rest.skip;
          await tx.mealPlanDay.update({
            where: { id: day.id },
            data: {
              overrides:
                Object.keys(rest).length > 0 ? (rest as Prisma.InputJsonValue) : Prisma.JsonNull,
            },
          });
        }
      }
    });

    return this.mealPlans.get(userId, locale, plan.id);
  }

  private async load(userId: string, id: string) {
    const row = await this.prisma.favoriteSet.findUnique({
      where: { id },
      include: { profile: true },
    });
    if (!row) throw new NotFoundException({ error: 'SET_NOT_FOUND', message: 'Favorite set not found.' });
    if (row.profile.userId !== userId) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Favorite set belongs to another user.' });
    }
    return row;
  }

  private async assertProfile(userId: string, profileId: string): Promise<void> {
    const profile = await this.prisma.profile.findUnique({ where: { id: profileId } });
    if (!profile) {
      throw new NotFoundException({ error: 'PROFILE_NOT_FOUND', message: 'Profile not found.' });
    }
    if (profile.userId !== userId) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Profile belongs to another user.' });
    }
  }

  private async assertRecipes(recipeIds: string[]): Promise<void> {
    if (recipeIds.length === 0) return;
    const found = await this.prisma.recipe.findMany({
      where: { id: { in: recipeIds } },
      select: { id: true },
    });
    const ok = new Set(found.map((r) => r.id));
    const missing = recipeIds.filter((id) => !ok.has(id));
    if (missing.length > 0) {
      throw new NotFoundException({
        error: 'RECIPE_NOT_FOUND',
        message: `Recipe not found: ${missing[0]}`,
      });
    }
  }
}

function toDto(row: {
  id: string;
  profileId: string;
  label: string;
  slots: unknown;
  createdAt: Date;
  updatedAt: Date;
}): FavoriteSet {
  return {
    id: row.id,
    profileId: row.profileId,
    label: row.label,
    slots: parseSlots(row.slots),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function parseSlots(raw: unknown): FavoriteSetSlots {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as FavoriteSetSlots;
  }
  return {};
}
