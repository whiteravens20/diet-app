// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import {
  ProfileInput,
  type CookingReminderPayload,
  type Profile,
  type WaterReminderPayload,
} from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { PlanGenerationService } from '../meal-plans/plan-generation.service.js';
import { CookingReminderService } from './cooking-reminder.service.js';
import { WaterReminderService } from './water-reminder.service.js';

describe('the reminders that keep the hours of an account', () => {
  let t: TestApp;
  let user: TestUser;
  let profile: Profile;
  let cooking: CookingReminderService;
  let water: WaterReminderService;
  const at = (moment: string) => new Date(moment);

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
    cooking = t.app.get(CookingReminderService);
    water = t.app.get(WaterReminderService);
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await resetUserData(t.prisma);
    user = await aUser(t);
    profile = await aProfile(t, user);
  });

  const zone = (timeZone: string | null) =>
    t.prisma.user.update({ where: { id: user.id }, data: { timeZone } });
  const reminders = (type: 'water_reminder' | 'cooking_reminder') =>
    t.prisma.notification.findMany({
      where: { profileId: profile.id, type },
      orderBy: { createdAt: 'asc' },
    });

  describe('water', () => {
    const day = '2026-11-09';
    const drink = (ml: number) =>
      t.prisma.waterEntry.create({ data: { profileId: profile.id, day: new Date(day), ml } });

    beforeEach(async () => {
      await zone('UTC');
      // Switched on as a client switches it: the rest of the profile as it is.
      const saved = await t
        .http()
        .put(`/api/profiles/${profile.id}`)
        .set(as(user))
        .send({ ...ProfileInput.parse(profile), waterReminders: true })
        .expect(200);
      expect(saved.body).toMatchObject({ waterReminders: true, cookingReminders: true });
    });

    it('reminds a day behind its pace between 9 and 21, at most every three hours, one unread at a time', async () => {
      expect(await water.scan(at(`${day}T08:30:00Z`))).toBe(0);
      // At noon a third of the day's target is due: 667 ml, and nothing was drunk.
      expect(await water.scan(at(`${day}T12:00:00Z`))).toBe(1);
      expect((await reminders('water_reminder'))[0]!.payload).toEqual({
        day,
        ml: 0,
        target: 2000,
      } satisfies WaterReminderPayload);
      expect(await water.scan(at(`${day}T13:00:00Z`))).toBe(0);

      // Three hours on, 600 ml are still more than 250 ml behind 1167.
      await drink(600);
      expect(await water.scan(at(`${day}T15:00:00Z`))).toBe(1);
      const kept = await reminders('water_reminder');
      expect(kept).toHaveLength(1);
      expect(kept[0]!.payload).toMatchObject({ ml: 600 });

      expect(await water.scan(at(`${day}T21:30:00Z`))).toBe(0);
    });

    it('says nothing to a day near its pace, nor once the target is reached', async () => {
      await drink(500);
      // At noon 667 ml are due: 500 ml are within 250 of it.
      expect(await water.scan(at(`${day}T12:00:00Z`))).toBe(0);
      await drink(1500);
      expect(await water.scan(at(`${day}T20:30:00Z`))).toBe(0);
    });

    it('reminds nobody whose profile stopped tracking water, and again once it tracks it, the reminder kept on all along', async () => {
      const tracking = (on: boolean) =>
        t
          .http()
          .put(`/api/profiles/${profile.id}`)
          .set(as(user))
          .send({ ...ProfileInput.parse(profile), waterReminders: true, waterTracking: on })
          .expect(200);
      expect((await tracking(false)).body).toMatchObject({
        waterTracking: false,
        waterReminders: true,
        waterTargetMl: 2000,
      });
      expect(await water.scan(at(`${day}T14:00:00Z`))).toBe(0);

      await tracking(true);
      expect(await water.scan(at(`${day}T14:00:00Z`))).toBe(1);
    });

    it('reminds nobody who switched it off, names no target, or whose account sent no time zone', async () => {
      await zone(null);
      expect(await water.scan(at(`${day}T14:00:00Z`))).toBe(0);
      await zone('UTC');
      await t.prisma.profile.update({ where: { id: profile.id }, data: { waterTargetMl: null } });
      expect(await water.scan(at(`${day}T14:00:00Z`))).toBe(0);
      await t.prisma.profile.update({
        where: { id: profile.id },
        data: { waterTargetMl: 2000, waterReminders: false },
      });
      expect(await water.scan(at(`${day}T14:00:00Z`))).toBe(0);
    });
  });

  describe('cooking ahead', () => {
    beforeEach(async () => {
      await zone('UTC');
    });

    it('reminds once, from 18 the evening before, of every dish cooked ahead tomorrow', async () => {
      const plan = await aPlan(t, user, profile, {
        startDate: '2026-11-10',
        durationDays: 4,
        mealPrepFriendly: true,
      });
      const cookedThere = plan.days[0]!.meals.filter((meal) => meal.cookAhead === 'cook');
      expect(cookedThere.length).toBeGreaterThan(0);

      expect(await cooking.scan(at('2026-11-09T17:59:00Z'))).toBe(0);
      expect(await cooking.scan(at('2026-11-09T18:05:00Z'))).toBe(1);
      expect(await cooking.scan(at('2026-11-09T21:00:00Z'))).toBe(0);

      const [made] = await reminders('cooking_reminder');
      const payload = made!.payload as CookingReminderPayload;
      expect(payload.date).toBe('2026-11-10');
      expect(payload.dishes.map((dish) => dish.plannedMealId).sort()).toEqual(
        cookedThere.map((meal) => meal.id).sort(),
      );
      for (const dish of payload.dishes) {
        expect(dish.dish.length).toBeGreaterThan(0);
        expect(['2026-11-10', '2026-11-11']).toContain(dish.alsoDate);
      }
    });

    it('says the evening before what tomorrow takes out of the freezer, in a plan that does not cook ahead', async () => {
      // An account in Polish reads the food's Polish name.
      await t.prisma.user.update({ where: { id: user.id }, data: { locale: 'pl' } });
      const chicken = await t.prisma.ingredient.findFirstOrThrow({
        where: { slug: 'chicken-breast' },
      });
      await t.prisma.inventoryItem.create({
        data: {
          profileId: profile.id,
          ingredientId: chicken.id,
          quantity: 286,
          unit: 'g',
          bestBefore: new Date('2026-12-09'),
          frozen: true,
        },
      });
      const generation = t.app.get(PlanGenerationService);
      const today = generation.today;
      generation.today = () => '2026-11-09';
      const plan = await aPlan(t, user, profile, {
        startDate: '2026-11-10',
        durationDays: 3,
      }).finally(() => (generation.today = today));
      // As a plan that eats the portion whole keeps it.
      const kept = await t.prisma.mealPlan.findUniqueOrThrow({ where: { id: plan.id } });
      await t.prisma.mealPlan.update({
        where: { id: plan.id },
        data: {
          report: {
            ...(kept.report as object),
            freezer: { from: '2026-11-10', stock: [{ ingredientId: chicken.id, amount: 286 }] },
          },
        },
      });
      // Chicken at Wednesday's lunch alone: the whole 286 g the freezer held come out for it.
      const [tofu, chickenRice] = await Promise.all(
        ['tofu-rice-bowl', 'chicken-rice-broccoli'].map((slug) =>
          t.prisma.recipe.findUniqueOrThrow({ where: { slug } }),
        ),
      );
      for (const [index, day] of plan.days.entries())
        for (const meal of day.meals)
          await t.prisma.plannedMeal.update({
            where: { id: meal.id },
            data: {
              recipeId: (index === 1 && meal.mealType === 'lunch' ? chickenRice! : tofu!).id,
              servings: 1,
              quantityScale: 1,
              source: 'CATALOGUE',
              leftoverFromDate: null,
              leftoverFromMealType: null,
              toppingKey: null,
              toppingAmount: null,
            },
          });
      const lunch = plan.days[1]!.meals.find((meal) => meal.mealType === 'lunch')!;

      // Monday evening: Tuesday takes nothing out of the freezer, and cooks nothing ahead.
      expect(await cooking.scan(at('2026-11-09T18:05:00Z'))).toBe(0);
      expect(await cooking.scan(at('2026-11-10T18:05:00Z'))).toBe(1);

      const [made] = await reminders('cooking_reminder');
      expect(made!.payload).toEqual({
        date: '2026-11-11',
        dishes: [],
        thaw: [
          {
            planId: plan.id,
            plannedMealId: lunch.id,
            mealType: 'lunch',
            name: 'Pierś z kurczaka',
            amount: 286,
            unit: 'g',
          },
        ],
      });
    });

    it('reminds nobody who switched it off, nor of a plan that is not for cooking ahead', async () => {
      await aPlan(t, user, profile, { startDate: '2026-11-10', durationDays: 4 });
      expect(await cooking.scan(at('2026-11-09T18:30:00Z'))).toBe(0);
      await aPlan(t, user, profile, {
        startDate: '2026-11-10',
        durationDays: 4,
        mealPrepFriendly: true,
      });
      await t.prisma.profile.update({
        where: { id: profile.id },
        data: { cookingReminders: false },
      });
      expect(await cooking.scan(at('2026-11-09T18:30:00Z'))).toBe(0);
    });
  });
});
