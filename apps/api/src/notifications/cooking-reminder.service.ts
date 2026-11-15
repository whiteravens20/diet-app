// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Injectable, Logger } from '@nestjs/common';
import {
  COOKING_REMINDER_HOUR,
  dayAfter,
  MealType,
  NotificationType,
  PlanOptions,
  type CookedAhead,
  type CookingReminderPayload,
  type Locale,
  type ThawAhead,
} from '@diet-app/shared';
import { holdProfile } from '../common/hold.js';
import { freezerOf } from '../meal-plans/generation-report.js';
import { isoDate } from '../meal-plans/plan-days.js';
import { cookingsOf } from '../meal-plans/plan-menu.js';
import { packsOfPlan } from '../meal-plans/plan-packs-store.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { localClock } from './local-clock.js';

/**
 * The scan that reminds a profile of cooking ahead (`cooking_reminder`), run
 * by the worker every hour. From `COOKING_REMINDER_HOUR` by its account's
 * clock, a profile whose plans for cooking ahead cook dishes tomorrow for two
 * days or two meals is reminded of them, once a day, every dish in one
 * reminder, and so is one whose plans' meals tomorrow take something out of
 * the freezer, which is taken out the evening before. A profile that switched
 * the reminder off, or whose account's clients sent no time zone, is not.
 */
@Injectable()
export class CookingReminderService {
  private readonly logger = new Logger('CookingReminderService');

  constructor(private readonly prisma: PrismaService) {}

  /** One pass. Returns the number of reminders made. */
  async scan(now: Date = new Date()): Promise<number> {
    const profiles = await this.prisma.profile.findMany({
      where: { cookingReminders: true, user: { timeZone: { not: null } } },
      select: { id: true, user: { select: { id: true, timeZone: true, locale: true } } },
    });
    let made = 0;
    for (const profile of profiles) {
      try {
        const clock = localClock(now, profile.user.timeZone!);
        if (clock.hour < COOKING_REMINDER_HOUR) continue;
        made += await this.remind(profile.id, profile.user, dayAfter(clock.day, 1), now);
      } catch (err) {
        this.logger.warn(
          `The cooking reminder of profile ${profile.id} was not made: ${(err as Error).message}`,
        );
      }
    }
    if (made > 0) this.logger.log(`Made ${made} cooking_reminder notification(s)`);
    return made;
  }

  /** Remind a profile, once, of what it cooks ahead `tomorrow` in any of its plans, and of what it takes out of the freezer for it. */
  private async remind(
    profileId: string,
    user: { id: string; locale: string },
    tomorrow: string,
    now: Date,
  ) {
    const locale = user.locale;
    const plans = await this.prisma.mealPlan.findMany({
      where: { profileId, days: { some: { date: new Date(tomorrow) } } },
      orderBy: { startDate: 'asc' },
      select: {
        id: true,
        options: true,
        report: true,
        jointPlanId: true,
        days: {
          orderBy: { date: 'asc' },
          select: {
            date: true,
            meals: {
              select: {
                id: true,
                mealType: true,
                recipeId: true,
                leftoverFromDate: true,
                leftoverFromMealType: true,
                recipe: {
                  select: {
                    id: true,
                    title: true,
                    translations: { where: { locale }, select: { title: true } },
                  },
                },
              },
            },
          },
        },
      },
    });
    const dishes: CookedAhead[] = [];
    for (const plan of plans) {
      if (!PlanOptions.parse(plan.options).mealPrepFriendly) continue;
      // A leftover is cooked already, and where it stands for a meal that left its day, so is what was cooked there.
      const { cookings } = cookingsOf(plan.days);
      for (const [first, also] of cookings) {
        if (!first || !also || first.stand || isoDate(plan.days[first.day]!.date) !== tomorrow)
          continue;
        const meal = first.meal;
        dishes.push({
          planId: plan.id,
          plannedMealId: meal.id,
          dish: meal.recipe?.translations[0]?.title ?? meal.recipe?.title ?? '',
          alsoDate: isoDate(plan.days[also.day]!.date),
          alsoMealType: MealType.parse(
            also.stand ? also.meal.leftoverFromMealType : also.meal.mealType,
          ),
        });
      }
    }
    const thaw: ThawAhead[] = [];
    for (const plan of plans) {
      // Only a plan that freezes, or was made with something in the freezer, or shares its kitchen, has anything to thaw.
      if (!PlanOptions.parse(plan.options).noWaste && !freezerOf(plan.report) && !plan.jointPlanId)
        continue;
      const packs = await packsOfPlan(this.prisma, user.id, plan.id, locale as Locale);
      if (!packs) continue;
      const mealTypeOf = new Map(
        plan.days.flatMap((day) => day.meals.map((meal) => [meal.id, meal.mealType] as const)),
      );
      // A portion of what the freezer held comes out whole; a rest frozen in the plan comes out a portion at a time.
      const portions = [
        ...packs.fromFreezer.map((held) => ({ ...held, thawed: [held] })),
        ...packs.frozen,
      ];
      for (const held of portions) {
        if (held.unit === 'piece') continue;
        for (const taken of held.thawed) {
          if (taken.date !== tomorrow) continue;
          // A meal of the other plan of the kitchen is not this profile's: what it takes is said without a meal.
          const mealType = taken.mealId ? (mealTypeOf.get(taken.mealId) ?? null) : null;
          thaw.push({
            planId: plan.id,
            plannedMealId: mealType ? taken.mealId : null,
            mealType: mealType ? MealType.parse(mealType) : null,
            name: held.name,
            amount: taken.amount,
            unit: held.unit,
          });
        }
      }
    }
    if (dishes.length === 0 && thaw.length === 0) return 0;
    return (await this.once(profileId, { date: tomorrow, dishes, thaw }, now)) ? 1 : 0;
  }

  /** Make the reminder of a day unless one was made for it: two scans at once make it once. */
  private once(profileId: string, payload: CookingReminderPayload, now: Date): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      // The profile's row is the lock two scans take turns at.
      await holdProfile(tx, profileId);
      const made = await tx.notification.count({
        where: {
          profileId,
          type: NotificationType.enum.cooking_reminder,
          payload: { path: ['date'], equals: payload.date },
        },
      });
      if (made > 0) return false;
      await tx.notification.create({
        data: { profileId, type: NotificationType.enum.cooking_reminder, payload, createdAt: now },
      });
      return true;
    });
  }
}
