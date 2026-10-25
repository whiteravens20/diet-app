// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Injectable } from '@nestjs/common';
import type { PlanCalendar, PlanCalendarQuery } from '@diet-app/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { MealPlansService } from './meal-plans.service.js';
import { isoDate, isSkipped, mealNutrition, standingOf, sumNutrition } from './plan-days.js';

/**
 * The days of a profile's plans, as a calendar shows them: read from the
 * plans as they are, and worked out as the view of a plan works a day out.
 * Nothing is written.
 */
@Injectable()
export class PlanCalendarService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: MealPlansService,
  ) {}

  /**
   * The days of the span that a plan holds. A day that several plans hold is
   * the day of the plan made last, and says how many hold it.
   *
   * However many plans a profile has, no more is read than one day of a plan
   * for each day of the span: the database picks the plan of each day, and
   * only those days are read with their meals.
   */
  async calendar(userId: string, asked: PlanCalendarQuery): Promise<PlanCalendar> {
    await this.plans.loadProfile(userId, asked.profileId);
    const held = await this.prisma.$queryRaw<{ id: string; plans: number }[]>`
      SELECT DISTINCT ON (d."date") d."id", (COUNT(*) OVER (PARTITION BY d."date"))::int AS plans
      FROM "MealPlanDay" d JOIN "MealPlan" p ON p."id" = d."planId"
      WHERE p."profileId" = ${asked.profileId} AND d."date" >= ${asked.from}::date AND d."date" <= ${asked.to}::date
      ORDER BY d."date", p."createdAt" DESC, p."id"`;
    const plansOn = new Map(held.map((day) => [day.id, day.plans]));

    const amount = {
      caloriesPerServing: true,
      proteinPerServing: true,
      fatPerServing: true,
      carbsPerServing: true,
    } as const;
    const days = await this.prisma.mealPlanDay.findMany({
      where: { id: { in: held.map((day) => day.id) } },
      select: {
        id: true,
        date: true,
        planId: true,
        calorieTarget: true,
        overrides: true,
        meals: {
          select: {
            servings: true,
            quantityScale: true,
            source: true,
            customMacros: true,
            eatenAt: true,
            recipe: { select: amount },
          },
        },
      },
      orderBy: { date: 'asc' },
    });

    return {
      days: days.map((day) => {
        const calories = sumNutrition(day.meals.map(mealNutrition)).calories;
        const skipped = isSkipped(day);
        return {
          date: isoDate(day.date),
          planId: day.planId,
          // A plan deleted between the two reads took its day with it; one that is read was counted.
          plans: plansOn.get(day.id) ?? 1,
          calories,
          target: day.calorieTarget,
          offTarget: standingOf(calories, day.calorieTarget, skipped).offTarget,
          eaten: {
            meals: day.meals.filter((meal) => meal.eatenAt !== null).length,
            of: day.meals.length,
          },
          skipped,
        };
      }),
    };
  }
}
