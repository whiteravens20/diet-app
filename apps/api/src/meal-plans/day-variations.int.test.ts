// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { DayVariations, MealPlan, Profile } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { DayVariationsService } from './day-variations.service.js';
import { MealPlansService } from './meal-plans.service.js';

describe('other ways to fill a day of a plan', () => {
  let t: TestApp;
  let variations: DayVariationsService;
  let plans: MealPlansService;
  let user: TestUser;
  let profile: Profile;
  let plan: MealPlan;

  beforeAll(async () => {
    t = await createTestApp();
    variations = t.app.get(DayVariationsService);
    plans = t.app.get(MealPlansService);
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await resetUserData(t.prisma);
    t.model.reset();
    user = await aUser(t);
    profile = await aProfile(t, user);
    // Three days of three meals from Monday 5 January 2026.
    plan = await aPlan(t, user, profile, { durationDays: 3 });
  });

  const day = (index = 1) => plan.days[index]!;
  /** The ways for the second day, as somebody is offered them for whom it is the plan's first day. */
  const offered = (weigh = false, locale: 'en' | 'pl' = 'en', index = 1): Promise<DayVariations> =>
    variations.offer(user.id, locale, plan.id, day(index).id, { weigh }, plan.startDate);
  const recipesOf = (meals: { recipeId: string | null }[]): (string | null)[] =>
    meals.map((meal) => meal.recipeId);
  const read = (): Promise<MealPlan> => plans.get(user.id, 'en', plan.id);

  describe('as the engine makes them', () => {
    it('are up to three, each with the meals of the day in order, and none is the day as it is or another of them', async () => {
      const { variations: ways, date, calorieTarget, aiMeta } = await offered();

      expect(date).toBe(day().date);
      expect(calorieTarget).toBe(day().calorieTarget);
      expect(aiMeta).toBeNull();
      expect(ways.length).toBeGreaterThan(0);
      expect(ways.length).toBeLessThanOrEqual(3);
      const now = recipesOf(day().meals.map((meal) => ({ recipeId: meal.recipe!.id }))).join(' ');
      const seen = new Set([now]);
      for (const way of ways) {
        expect(way.meals.map((meal) => meal.mealType)).toEqual(['breakfast', 'lunch', 'dinner']);
        expect(way.meals.every((meal) => !meal.stays && meal.title !== '')).toBe(true);
        const made = recipesOf(way.meals).join(' ');
        expect(seen.has(made), 'a way that was there already').toBe(false);
        seen.add(made);
        expect(way.reason).toBeNull();
      }
    });

    it('are other days and not the same day with a meal changed: no way holds a recipe the day holds, or one a way before it holds', async () => {
      const { variations: ways } = await offered();

      const held = new Set(day().meals.map((meal) => meal.recipe!.id));
      for (const way of ways) {
        // The test catalogue has four recipes and more for every meal of a balanced day: enough for three ways and the day.
        for (const meal of way.meals)
          expect(held.has(meal.recipeId!), `${meal.title} twice`).toBe(false);
        for (const meal of way.meals) held.add(meal.recipeId!);
      }
      expect(ways).toHaveLength(3);
    });

    it('are the same ways when they are asked for again of the plan as it stands, and others once the plan has changed', async () => {
      const first = await offered();
      const again = await offered();

      expect(again.variations.map((way) => recipesOf(way.meals))).toEqual(
        first.variations.map((way) => recipesOf(way.meals)),
      );

      await variations.take(user.id, 'en', plan.id, day().id, {
        offer: first.variations[0]!.offer,
      });
      const after = await offered();
      // The day now holds what the first way held: no way offers that again.
      expect(after.variations.map((way) => recipesOf(way.meals).join(' '))).not.toContain(
        recipesOf(first.variations[0]!.meals).join(' '),
      );
    });

    it('say what each way comes to: the day, and the packs of the whole plan', async () => {
      const { variations: ways, current } = await offered();

      expect(current.dayNutrition).toEqual(day().dayNutrition);
      expect(current.packs).toEqual({
        bought: plan.packs.bought,
        used: plan.packs.used,
        wasted: plan.packs.open.filter((pack) => pack.wasted).length,
      });
      for (const way of ways) {
        expect(way.dayNutrition.calories).toBe(
          way.meals.reduce((sum, meal) => sum + meal.nutrition.calories, 0),
        );
        // A day the engine makes is inside the tenth around its target.
        expect(Math.abs(way.dayNutrition.calories - day().calorieTarget)).toBeLessThanOrEqual(
          day().calorieTarget * 0.1 + 1,
        );
        expect(way.packs.used).toBeLessThanOrEqual(way.packs.bought);
      }
    });

    it("keep on the day what was eaten and what is the user's own, and say so", async () => {
      const lunch = day().meals.find((meal) => meal.mealType === 'lunch')!;
      await t
        .http()
        .patch(`/api/meal-plans/${plan.id}/meals/${lunch.id}/eaten`)
        .set(as(user))
        .send({ eaten: true })
        .expect(200);
      await t
        .http()
        .post(`/api/meal-plans/${plan.id}/days/${day().date}/custom-meal`)
        .set(as(user))
        .send({
          name: 'A slice of cake',
          mealType: 'snack',
          nutrition: { calories: 250, protein: 3, fat: 10, carbs: 35 },
        })
        .expect(201);

      const { variations: ways } = await offered();

      expect(ways.length).toBeGreaterThan(0);
      for (const way of ways) {
        expect(
          way.meals
            .filter((meal) => meal.stays)
            .map((meal) => [meal.mealType, meal.title, meal.recipeId]),
        ).toEqual([
          ['lunch', lunch.recipe!.title, lunch.recipe!.id],
          ['snack', 'A slice of cake', null],
        ]);
        expect(way.meals.map((meal) => meal.mealType)).toEqual([
          'breakfast',
          'lunch',
          'snack',
          'dinner',
        ]);
      }
    });

    it('name recipes in the language asked for', async () => {
      const { variations: ways } = await offered(false, 'pl');

      expect(ways[0]!.meals.every((meal) => meal.title.endsWith('(pl)'))).toBe(true);
    });

    it('are not made for a day that has passed', async () => {
      await expect(
        variations.offer(user.id, 'en', plan.id, day(0).id, { weigh: false }, day(1).date),
      ).rejects.toMatchObject({ response: { error: 'NOTHING_TO_REGENERATE' } });
    });
  });

  describe('when one is taken', () => {
    it('the day gets its meals as the offer had them, and the other days stay as they were', async () => {
      const [way] = (await offered()).variations;

      const after = await variations.take(user.id, 'en', plan.id, day().id, { offer: way!.offer });

      expect(
        after.days[1]!.meals.map((meal) => [meal.mealType, meal.recipe!.id, meal.servings]),
      ).toEqual(way!.meals.map((meal) => [meal.mealType, meal.recipeId, meal.servings]));
      expect(after.days[1]!.dayNutrition).toEqual(way!.dayNutrition);
      expect(after.days[0]).toEqual(plan.days[0]);
      expect(after.days[2]).toEqual(plan.days[2]);
      expect(after.revision).toBe(plan.revision + 1);
      // The engine's own order: no model is said to have chosen anything.
      expect(after.days[1]!.meals.every((meal) => meal.modelPick === null)).toBe(true);
      expect(after.generationMode).toBe('deterministic');
      expect({
        bought: after.packs.bought,
        used: after.packs.used,
        wasted: after.packs.open.filter((pack) => pack.wasted).length,
      }).toEqual(way!.packs);
    });

    it("keeps what was eaten and what is the user's own on the day", async () => {
      const lunch = day().meals.find((meal) => meal.mealType === 'lunch')!;
      await t
        .http()
        .patch(`/api/meal-plans/${plan.id}/meals/${lunch.id}/eaten`)
        .set(as(user))
        .send({ eaten: true })
        .expect(200);
      const [way] = (await offered()).variations;

      const after = await variations.take(user.id, 'en', plan.id, day().id, { offer: way!.offer });

      const kept = after.days[1]!.meals.find((meal) => meal.mealType === 'lunch')!;
      expect([kept.id, kept.recipe!.id, kept.eatenAt !== null]).toEqual([
        lunch.id,
        lunch.recipe!.id,
        true,
      ]);
      expect(after.days[1]!.meals).toHaveLength(3);
    });

    it('is refused on a plan that changed since the offer, and the plan stays as it is', async () => {
      const [way] = (await offered()).variations;
      const breakfast = day(2).meals[0]!;
      await t
        .http()
        .patch(`/api/meal-plans/${plan.id}/meals/${breakfast.id}/eaten`)
        .set(as(user))
        .send({ eaten: true })
        .expect(200);
      const before = await read();

      await expect(
        variations.take(user.id, 'en', plan.id, day().id, { offer: way!.offer }),
      ).rejects.toMatchObject({ response: { error: 'PLAN_CHANGED' } });

      expect(await read()).toEqual(before);
    });

    it('is refused with a note that is not for this day of this plan, or that somebody made up', async () => {
      const [way] = (await offered()).variations;

      await expect(
        variations.take(user.id, 'en', plan.id, day(2).id, { offer: way!.offer }),
      ).rejects.toMatchObject({ response: { error: 'OFFER_INVALID' } });
      await expect(
        variations.take(user.id, 'en', plan.id, day().id, { offer: 'a-note-of-my-own' }),
      ).rejects.toMatchObject({ response: { error: 'OFFER_INVALID' } });
      // The note of another account's offer is no note of this account's.
      const other = await aUser(t);
      const theirs = await aPlan(t, other, await aProfile(t, other), { durationDays: 3 });
      const [stolen] = (
        await variations.offer(
          other.id,
          'en',
          theirs.id,
          theirs.days[1]!.id,
          { weigh: false },
          theirs.startDate,
        )
      ).variations;
      await expect(
        variations.take(user.id, 'en', plan.id, day().id, { offer: stolen!.offer }),
      ).rejects.toMatchObject({ response: { error: 'OFFER_INVALID' } });
    });

    it('judges every recipe again: one the profile has ruled out since is not written', async () => {
      const [way] = (await offered()).variations;
      const ruledOut = way!.meals[0]!.recipeId!;
      await t
        .http()
        .post('/api/favorites')
        .set(as(user))
        .send({ profileId: profile.id, recipeId: ruledOut, sentiment: 'avoid' })
        .expect(201);
      const before = await read();

      await expect(
        variations.take(user.id, 'en', plan.id, day().id, { offer: way!.offer }),
      ).rejects.toMatchObject({ response: { error: 'RECIPE_NOT_ELIGIBLE' } });

      expect((await read()).days[1]!.meals.map((meal) => meal.recipe!.id)).toEqual(
        before.days[1]!.meals.map((meal) => meal.recipe!.id),
      );
    });
  });

  describe('as a model weighs them', () => {
    beforeEach(async () => {
      await t.prisma.user.update({ where: { id: user.id }, data: { aiMode: 'admin' } });
    });

    it('are put before the model under letters, with what the day aims at and what each way comes to', async () => {
      t.model.reply({ text: JSON.stringify({ order: ['a'] }) });

      const { variations: ways } = await offered(true);

      expect(t.model.requests).toHaveLength(1);
      const { prompt } = t.model.requests[0]!;
      expect(prompt).toContain(
        `Ways to fill ${day().date} of a balanced meal plan. The day aims at ${Math.round(day().calorieTarget)} kcal`,
      );
      expect(prompt).toContain(`breakfast: ${ways.find((way) => way.offer)!.meals[0]!.title}`);
      expect(prompt).toContain('opened packs left more than a fifth full: ');
      expect(prompt).not.toContain(plan.id);
    });

    it("come back in the model's order with its sentences; the way it put first is written as its pick, and the plan says a model had a part in it", async () => {
      const plain = (await offered()).variations;
      t.model.reset();
      const last = String.fromCharCode(97 + plain.length - 1);
      t.model.reply({
        text: JSON.stringify({
          order: [last],
          reasons: { [last]: 'Closest to the target, and it finishes the chicken.' },
        }),
      });

      const { variations: ways, aiMeta } = await offered(true);

      expect(aiMeta).toMatchObject({ provider: 'ollama', usedDeterministicFallback: false });
      expect(ways[0]!.reason).toBe('Closest to the target, and it finishes the chicken.');
      expect(ways.slice(1).every((way) => way.reason === null)).toBe(true);

      const after = await variations.take(user.id, 'en', plan.id, day().id, {
        offer: ways[0]!.offer,
      });

      expect(after.days[1]!.meals.map((meal) => meal.modelPick)).toEqual(
        after.days[1]!.meals.map(() => ({
          reason: 'Closest to the target, and it finishes the chicken.',
        })),
      );
      expect(after.generationMode).toBe('ai_assisted');
    });

    it("write a way the model did not put first as nobody's pick", async () => {
      t.model.reply({
        text: JSON.stringify({
          order: ['a', 'b', 'c'],
          reasons: { a: 'Best.', b: 'Fine.', c: 'Heavier.' },
        }),
      });
      const { variations: ways } = await offered(true);
      // Where the catalogue leaves one other way only, there is no second to take.
      if (ways.length < 2) return;

      const after = await variations.take(user.id, 'en', plan.id, day().id, {
        offer: ways[1]!.offer,
      });

      expect(after.days[1]!.meals.every((meal) => meal.modelPick === null)).toBe(true);
      expect(after.generationMode).toBe('deterministic');
    });

    it("stay in the engine's order, as nobody's pick, when the model's answer cannot be used", async () => {
      t.model.reply({ text: 'All of them look fine to me.' });

      const { variations: ways, aiMeta } = await offered(true);

      expect(aiMeta).toMatchObject({
        usedDeterministicFallback: true,
        fallbackReason: 'invalid_output',
      });
      const after = await variations.take(user.id, 'en', plan.id, day().id, {
        offer: ways[0]!.offer,
      });
      expect(after.days[1]!.meals.every((meal) => meal.modelPick === null)).toBe(true);
    });

    it("count against the account's allowance like any request to a model", async () => {
      t.model.reply({ text: JSON.stringify({ order: ['a'] }) });

      await offered(true);

      expect(
        (await t.prisma.aiUsageLog.findMany({ where: { userId: user.id } })).map(
          (call) => call.operation,
        ),
      ).toEqual(['day-variations']);
    });
  });

  it('are answered and taken by the routes, by the owner of the plan alone', async () => {
    // A plan that begins today: the routes go by the day it is.
    const today = new Date().toISOString().slice(0, 10);
    const current = await aPlan(t, user, profile, { startDate: today, durationDays: 2 });
    const path = `/api/meal-plans/${current.id}/days/${current.days[1]!.id}/variations`;

    const answer = await t.http().post(path).set(as(user)).send({}).expect(200);
    expect(answer.body.variations.length).toBeGreaterThan(0);
    const taken = await t
      .http()
      .post(`${path}/take`)
      .set(as(user))
      .send({ offer: answer.body.variations[0].offer })
      .expect(200);
    expect(taken.body.revision).toBe(current.revision + 1);

    const other = await aUser(t);
    await t.http().post(path).set(as(other)).send({}).expect(404);
    await t
      .http()
      .post(`${path}/take`)
      .set(as(other))
      .send({ offer: answer.body.variations[0].offer })
      .expect(404);
    await t.http().post(`${path}/take`).set(as(user)).send({}).expect(400);
  });
});
