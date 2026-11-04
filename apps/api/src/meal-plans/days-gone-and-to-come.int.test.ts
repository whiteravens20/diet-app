// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { MealPlan, PlannedMeal, SubstituteSuggestion } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { plansTodayIs } from '../testing/plans-today.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { MealPlansService } from './meal-plans.service.js';

describe('a day that has passed, and a day still to come', () => {
  let t: TestApp;
  let user: TestUser;
  let plan: MealPlan;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await resetUserData(t.prisma);
    user = await aUser(t);
    plan = await aPlan(t, user, await aProfile(t, user), { durationDays: 3 });
  });

  const now = (): Promise<MealPlan> => t.app.get(MealPlansService).get(user.id, 'en', plan.id);
  const portions = (day: MealPlan['days'][number]): [string, number][] =>
    day.meals
      .filter((meal) => meal.source === 'CATALOGUE')
      .map((meal) => [meal.id, meal.servings * meal.quantityScale]);
  const swapAsked = (meal: PlannedMeal) => ({
    planId: plan.id,
    plannedMealId: meal.id,
    strategy: 'random',
  });
  const refusedWith = async (
    request: PromiseLike<{ status: number; body: { error?: string } }>,
  ) => {
    const answer = await request;
    return [answer.status, answer.body.error];
  };

  describe('that has passed', () => {
    const past = () => plan.days[0]!;
    const meal = () => past().meals[0]!;

    beforeEach(() => {
      plansTodayIs(plan.days[1]!.date);
    });

    it('offers no swap of a meal, by the engine or by a model', async () => {
      expect(
        await refusedWith(
          t.http().post('/api/meal-plans/swap-meal/preview').set(as(user)).send(swapAsked(meal())),
        ),
      ).toEqual([409, 'DAY_IN_THE_PAST']);
      expect(
        await refusedWith(
          t
            .http()
            .post('/api/meal-plans/ai-swap-meal/preview')
            .set(as(user))
            .send({ planId: plan.id, plannedMealId: meal().id }),
        ),
      ).toEqual([409, 'DAY_IN_THE_PAST']);
    });

    it('takes no swap that was offered before the day passed', async () => {
      plansTodayIs(plan.days[0]!.date);
      const offer = (
        await t
          .http()
          .post('/api/meal-plans/swap-meal/preview')
          .set(as(user))
          .send(swapAsked(meal()))
          .expect(201)
      ).body as { recipe: { id: string }; revision: number };
      plansTodayIs(plan.days[1]!.date);

      expect(
        await refusedWith(
          t.http().post('/api/meal-plans/swap-meal').set(as(user)).send({
            planId: plan.id,
            plannedMealId: meal().id,
            recipeId: offer.recipe.id,
            revision: offer.revision,
            strategy: 'random',
          }),
        ),
      ).toEqual([409, 'DAY_IN_THE_PAST']);
    });

    it('offers no substitute for an ingredient', async () => {
      expect(
        await refusedWith(
          t.http().get(`/api/meal-plans/${plan.id}/meals/${meal().id}/substitutes`).set(as(user)),
        ),
      ).toEqual([409, 'DAY_IN_THE_PAST']);
    });

    it('takes an own meal, with the portions of the rest as they were', async () => {
      const before = portions(past());

      const answer = (
        await t
          .http()
          .post(`/api/meal-plans/${plan.id}/days/${past().date}/custom-meal`)
          .set(as(user))
          .send({
            name: 'Out',
            mealType: 'snack',
            servings: 1,
            nutrition: { calories: 900, protein: 20, fat: 40, carbs: 100 },
          })
          .expect(201)
      ).body as { plan: MealPlan; rebalance: unknown };

      expect(portions(answer.plan.days[0]!)).toEqual(before);
      expect(answer.rebalance).toBeNull();
    });

    it('has a meal taken off and marked as eaten, with the portions of the rest as they were', async () => {
      const [gone, eaten, ...rest] = past().meals;
      const left = rest.map((one): [string, number] => [one.id, one.servings * one.quantityScale]);

      await t
        .http()
        .delete(`/api/meal-plans/${plan.id}/meals/${gone!.id}`)
        .set(as(user))
        .expect(200);
      await t
        .http()
        .patch(`/api/meal-plans/${plan.id}/meals/${eaten!.id}/eaten`)
        .set(as(user))
        .send({ eaten: true })
        .expect(200);

      const after = (await now()).days[0]!;
      expect(after.meals.find((one) => one.id === eaten!.id)!.eatenAt).not.toBeNull();
      expect(portions(after).filter(([id]) => id !== eaten!.id)).toEqual(left);
    });

    it('is left as it is by a rebalance of the day', async () => {
      const before = portions(past());

      const answer = (
        await t
          .http()
          .post(`/api/meal-plans/${plan.id}/rebalance`)
          .set(as(user))
          .send({ scope: 'day', date: past().date })
          .expect(201)
      ).body as { plan: MealPlan; rebalance: unknown };

      expect(portions(answer.plan.days[0]!)).toEqual(before);
      expect(answer.rebalance).toBeNull();
    });

    it('takes no set; a day still to come named with it does', async () => {
      const recipe = meal().recipe!;
      const set = (
        await t
          .http()
          .post('/api/favorite-sets')
          .set(as(user))
          .send({
            profileId: plan.profileId,
            label: 'Mine',
            slots: { [meal().mealType]: recipe.id },
          })
          .expect(201)
      ).body as { id: string };
      const apply = (dayDates: string[]) =>
        t
          .http()
          .post(`/api/favorite-sets/${set.id}/apply`)
          .set(as(user))
          .send({ planId: plan.id, dayDates });
      const before = portions(past());

      expect(await refusedWith(apply([past().date]))).toEqual([409, 'DAY_IN_THE_PAST']);
      await apply([past().date, plan.days[2]!.date]).expect(201);

      expect(portions((await now()).days[0]!)).toEqual(before);
    });
  });

  describe('still to come', () => {
    const ahead = () => plan.days[1]!.meals[0]!;

    it('has no meal marked as eaten', async () => {
      expect(
        await refusedWith(
          t
            .http()
            .patch(`/api/meal-plans/${plan.id}/meals/${ahead().id}/eaten`)
            .set(as(user))
            .send({ eaten: true }),
        ),
      ).toEqual([409, 'MEAL_NOT_EATEN_YET']);
      expect((await now()).days[1]!.meals[0]!.eatenAt).toBeNull();
    });

    it('has the mark taken back of a meal marked before', async () => {
      await t.prisma.plannedMeal.update({
        where: { id: ahead().id },
        data: { eatenAt: new Date() },
      });

      await t
        .http()
        .patch(`/api/meal-plans/${plan.id}/meals/${ahead().id}/eaten`)
        .set(as(user))
        .send({ eaten: false })
        .expect(200);

      expect((await now()).days[1]!.meals[0]!.eatenAt).toBeNull();
    });

    it('is changed as any day is', async () => {
      const found = (
        await t
          .http()
          .post('/api/meal-plans/swap-meal/preview')
          .set(as(user))
          .send(swapAsked(ahead()))
          .expect(201)
      ).body as { recipe: { id: string } };
      expect(found.recipe.id).not.toBe(ahead().recipe!.id);
      (
        await t
          .http()
          .get(`/api/meal-plans/${plan.id}/meals/${ahead().id}/substitutes`)
          .set(as(user))
          .expect(200)
      ).body satisfies SubstituteSuggestion[];
    });
  });

  it('offers no change of a meal on a day the user skips', async () => {
    const meal = plan.days[1]!.meals[0]!;
    await t.prisma.mealPlanDay.update({
      where: { id: plan.days[1]!.id },
      data: { overrides: { skip: true } },
    });

    expect(
      await refusedWith(
        t.http().post('/api/meal-plans/swap-meal/preview').set(as(user)).send(swapAsked(meal)),
      ),
    ).toEqual([409, 'DAY_SKIPPED']);
  });
});
