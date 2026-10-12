// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Locale, PlanOverview, PlanOverviewAnswer } from '@diet-app/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { MealPlansService } from './meal-plans.service.js';
import { isoDate } from './plan-days.js';

/**
 * What a profile's plan of the moment comes to, for somebody who opens the
 * application to see how they stand: read from the plan as it is, and from
 * what was ticked on its shopping lists. Nothing is written.
 */
@Injectable()
export class PlanOverviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: MealPlansService,
  ) {}

  /** The overview of the plan of the moment, or none for a profile without a plan. `clientToday` is the day it is for whoever asks. */
  async overview(userId: string, locale: Locale, profileId: string, clientToday: string | null = null): Promise<PlanOverviewAnswer> {
    await this.plans.loadProfile(userId, profileId);
    const today = clientToday ?? isoDate(new Date());
    const found = await this.planOfTheMoment(profileId, today);
    if (!found) return { overview: null };

    const plan = await this.plans.get(userId, locale, found.id);
    const planned = plan.days.filter((day) => !day.skipped);
    const meals = plan.days.flatMap((day) => day.meals);
    const cooked = meals.filter((meal) => meal.recipe !== null);
    // The days that have come: what was due to be eaten by now.
    const due = plan.days.filter((day) => day.date <= today).flatMap((day) => day.meals);

    const liked = new Set(
      (await this.prisma.favorite.findMany({ where: { profileId, sentiment: { in: ['favorite', 'often'] } }, select: { recipeId: true } })).map((marked) => marked.recipeId),
    );
    const [lists, entries, ticked] = await Promise.all([
      this.prisma.shoppingList.count({ where: { planId: plan.id } }),
      this.prisma.shoppingListItem.count({ where: { list: { planId: plan.id } } }),
      this.prisma.shoppingListItem.count({ where: { list: { planId: plan.id }, checked: true } }),
    ]);

    const overview: PlanOverview = {
      plan: { id: plan.id, startDate: plan.startDate, durationDays: plan.durationDays, dietType: plan.dietType, status: found.status },
      energy: {
        planned: plan.averageDailyNutrition.calories,
        target: planned.length === 0 ? 0 : Math.round(planned.reduce((sum, day) => sum + day.calorieTarget, 0) / planned.length),
      },
      macros: {
        planned: { protein: plan.averageDailyNutrition.protein, fat: plan.averageDailyNutrition.fat, carbs: plan.averageDailyNutrition.carbs },
        target: plan.targetMacros,
      },
      eaten: { meals: due.filter((meal) => meal.eatenAt !== null).length, of: due.length },
      onDiet: { meals: cooked.filter((meal) => !meal.dietOverride).length, of: cooked.length },
      favourites: { meals: cooked.filter((meal) => liked.has(meal.recipe!.id)).length, of: cooked.length },
      ingredientReuse: plan.ingredientReuseScore,
      shopping: { lists, entries, ticked },
      days: plan.days.map((day) => ({ date: day.date, calories: day.dayNutrition.calories, target: day.calorieTarget, skipped: day.skipped })),
    };
    return { overview };
  }

  /**
   * The plan a profile is living by: the one under way, the newest of them
   * when several overlap; with none under way, the one that begins next; with
   * none ahead, the one that ended last.
   */
  private async planOfTheMoment(profileId: string, today: string): Promise<{ id: string; status: PlanOverview['plan']['status'] } | null> {
    const day = Prisma.sql`${today}::date`;
    // The last day of a plan is its first plus its length less one.
    const lastDay = Prisma.sql`("startDate" + ("durationDays" - 1))`;
    const first = async (narrowed: Prisma.Sql, order: Prisma.Sql): Promise<string | null> => {
      const rows = await this.prisma.$queryRaw<{ id: string }[]>`SELECT "id" FROM "MealPlan" WHERE "profileId" = ${profileId} AND ${narrowed} ORDER BY ${order}, "createdAt" DESC, "id" LIMIT 1`;
      return rows[0]?.id ?? null;
    };
    const active = await first(Prisma.sql`"startDate" <= ${day} AND ${lastDay} >= ${day}`, Prisma.sql`"startDate" DESC`);
    if (active) return { id: active, status: 'active' };
    const upcoming = await first(Prisma.sql`"startDate" > ${day}`, Prisma.sql`"startDate" ASC`);
    if (upcoming) return { id: upcoming, status: 'upcoming' };
    const past = await first(Prisma.sql`${lastDay} < ${day}`, Prisma.sql`"startDate" DESC`);
    return past ? { id: past, status: 'past' } : null;
  }
}
