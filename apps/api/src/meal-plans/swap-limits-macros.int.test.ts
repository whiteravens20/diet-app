// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { MealPlan, MealSwapPreview, PlannedMeal, Profile } from '@diet-app/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

describe('what a swap offers', () => {
  let t: TestApp;
  let user: TestUser;
  let profile: Profile;

  /** The recipes as the catalogue has them: a test here changes what they hold and take. */
  let asSeeded: Awaited<ReturnType<typeof readRecipes>>;
  const readRecipes = () =>
    t.prisma.recipe.findMany({
      select: {
        id: true,
        prepMinutes: true,
        cookMinutes: true,
        caloriesPerServing: true,
        proteinPerServing: true,
        fatPerServing: true,
        carbsPerServing: true,
      },
    });

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
    asSeeded = await readRecipes();
  });

  afterAll(async () => {
    await t.close();
  });

  afterEach(async () => {
    for (const { id, ...figures } of asSeeded)
      await t.prisma.recipe.update({ where: { id }, data: figures });
  });

  beforeEach(async () => {
    await resetUserData(t.prisma);
    t.model.reset();
    user = await aUser(t);
    profile = await aProfile(t, user);
  });

  const lunchOf = (plan: MealPlan, day = 0): PlannedMeal =>
    plan.days[day]!.meals.find((meal) => meal.mealType === 'lunch')!;
  const offer = async (
    plan: MealPlan,
    meal: PlannedMeal,
    over: Record<string, unknown> = {},
  ): Promise<MealSwapPreview> =>
    (
      await t
        .http()
        .post('/api/meal-plans/swap-meal/preview')
        .set(as(user))
        .send({ planId: plan.id, plannedMealId: meal.id, strategy: 'random', ...over })
        .expect(201)
    ).body;
  const take = (plan: MealPlan, meal: PlannedMeal, offered: MealSwapPreview) =>
    t
      .http()
      .post('/api/meal-plans/swap-meal')
      .set(as(user))
      .send({
        planId: plan.id,
        plannedMealId: meal.id,
        recipeId: offered.recipe.id,
        revision: offered.revision,
        strategy: 'random',
      })
      .expect(201);
  /** Mark every recipe for lunch as avoided, but these: what a swap can offer is then known. */
  const leaveForLunch = async (slugs: string[]): Promise<void> => {
    const rows = await t.prisma.recipe.findMany({
      where: { mealTypes: { has: 'lunch' }, createdByUserId: null },
      select: { id: true, slug: true },
    });
    await t.prisma.favorite.createMany({
      data: rows
        .filter((row) => !slugs.includes(row.slug!))
        .map((row) => ({ profileId: profile.id, recipeId: row.id, sentiment: 'avoid', tags: [] })),
    });
  };
  /** The recipes that can stand in for a lunch of this plan, whatever it holds. */
  const lunches = async (): Promise<{ id: string; slug: string; minutes: number }[]> =>
    (
      await t.prisma.recipe.findMany({
        where: { mealTypes: { has: 'lunch' }, createdByUserId: null, deletedAt: null },
        select: { id: true, slug: true, prepMinutes: true, cookMinutes: true },
      })
    ).map((row) => ({ id: row.id, slug: row.slug!, minutes: row.prepMinutes + row.cookMinutes }));

  describe('for the limits of the plan', () => {
    it('keeps to the cooking time of the day where something does', async () => {
      const plan = await aPlan(t, user, profile, {
        durationDays: 1,
        dayOverrides: [{ date: '2026-01-05', cookTimeBudgetMinutes: 60 }],
      });
      const meal = lunchOf(plan);
      const quick = (await lunches()).find((row) => row.id !== meal.recipe!.id)!;
      await t.prisma.recipe.updateMany({
        where: { mealTypes: { has: 'lunch' }, id: { not: quick.id } },
        data: { prepMinutes: 200 },
      });
      await t.prisma.recipe.update({
        where: { id: quick.id },
        data: { prepMinutes: 5, cookMinutes: 5 },
      });

      const offered = await offer(plan, meal);

      expect(offered.recipe.id).toBe(quick.id);
      expect(offered.outsideLimits).toEqual([]);
    });

    it('offers what is over it where nothing else is, says so, and the meal says so once it holds it', async () => {
      const plan = await aPlan(t, user, profile, {
        durationDays: 1,
        dayOverrides: [{ date: '2026-01-05', cookTimeBudgetMinutes: 60 }],
      });
      const meal = lunchOf(plan);
      await t.prisma.recipe.updateMany({
        where: { mealTypes: { has: 'lunch' } },
        data: { prepMinutes: 200 },
      });

      const offered = await offer(plan, meal);
      expect(offered.outsideLimits).toEqual(['cook_time']);

      const after = (await take(plan, meal, offered)).body.plan as MealPlan;
      expect(after.report!.relaxations).toEqual([
        { date: '2026-01-05', slot: 'lunch', gaveWay: ['cook_time'] },
      ]);
    });

    it('stops saying so once the meal holds another recipe', async () => {
      const plan = await aPlan(t, user, profile, {
        durationDays: 1,
        dayOverrides: [{ date: '2026-01-05', cookTimeBudgetMinutes: 60 }],
      });
      const meal = lunchOf(plan);
      await t.prisma.recipe.updateMany({
        where: { mealTypes: { has: 'lunch' } },
        data: { prepMinutes: 200 },
      });
      const first = (await take(plan, meal, await offer(plan, meal))).body.plan as MealPlan;
      await t.prisma.recipe.updateMany({
        where: { mealTypes: { has: 'lunch' } },
        data: { prepMinutes: 5, cookMinutes: 5 },
      });

      const after = (await take(first, lunchOf(first), await offer(first, lunchOf(first)))).body
        .plan as MealPlan;

      expect(after.report!.relaxations).toEqual([]);
    });

    it('keeps to the kinds of protein of the day where something does', async () => {
      await t.prisma.profilePreference.update({
        where: { profileId: profile.id },
        data: { maxMealsPerDaySameKind: 1 },
      });
      const plan = await aPlan(t, user, profile, {
        durationDays: 1,
        allowRelaxations: ['kind_same_day'],
      });
      const meal = lunchOf(plan);
      const seen: string[] = [];
      for (let click = 0; click < 6; click += 1) {
        const offered = await offer(plan, meal, { skip: seen });
        seen.push(offered.recipe.id);
        // What is outside is offered only when nothing else was left of the pool.
        if (offered.outsideLimits.length > 0) expect(seen.length).toBeGreaterThan(1);
      }
    });

    it('lets a favourite picked by hand through, and says what it is outside of', async () => {
      const plan = await aPlan(t, user, profile, {
        durationDays: 1,
        dayOverrides: [{ date: '2026-01-05', cookTimeBudgetMinutes: 60 }],
      });
      const meal = lunchOf(plan);
      const slow = (await lunches()).find((row) => row.id !== meal.recipe!.id)!;
      await t.prisma.recipe.update({ where: { id: slow.id }, data: { prepMinutes: 200 } });
      await t.prisma.favorite.create({
        data: { profileId: profile.id, recipeId: slow.id, sentiment: 'favorite', tags: [] },
      });

      const offered = await offer(plan, meal, { strategy: 'favorite', favoriteRecipeId: slow.id });

      expect(offered.recipe.id).toBe(slow.id);
      expect(offered.outsideLimits).toEqual(['cook_time']);
    });
  });

  describe('for the macros of the day', () => {
    /** Three recipes for lunch, one nearly all protein, one nearly all carbohydrate, one nearly all fat. */
    const threeLunches = async () => {
      const [lean, starch, rich] = (await lunches()).slice(0, 3);
      const figures = (protein: number, fat: number, carbs: number) => ({
        caloriesPerServing: protein * 4 + fat * 9 + carbs * 4,
        proteinPerServing: protein,
        fatPerServing: fat,
        carbsPerServing: carbs,
      });
      await t.prisma.recipe.update({ where: { id: lean!.id }, data: figures(120, 5, 10) });
      await t.prisma.recipe.update({ where: { id: starch!.id }, data: figures(5, 5, 125) });
      await t.prisma.recipe.update({ where: { id: rich!.id }, data: figures(5, 55, 5) });
      await leaveForLunch([lean!.slug, starch!.slug, rich!.slug]);
      return { lean: lean!, starch: starch!, rich: rich! };
    };

    it('offers first what brings the day nearest what it aims at, and the others after it', async () => {
      const { lean, starch, rich } = await threeLunches();
      const plan = await aPlan(t, user, profile, { durationDays: 1 });
      const meal = lunchOf(plan);
      const others = [lean, starch, rich].filter((row) => row.id !== meal.recipe!.id);
      const rest = plan.days[0]!.meals.filter((one) => one.id !== meal.id);
      const held = {
        protein: rest.reduce((sum, one) => sum + one.nutrition.protein, 0),
        fat: rest.reduce((sum, one) => sum + one.nutrition.fat, 0),
        carbs: rest.reduce((sum, one) => sum + one.nutrition.carbs, 0),
      };
      const aim = plan.days[0]!.targetMacros;
      const atThePortion = async (id: string) => {
        const row = await t.prisma.recipe.findUniqueOrThrow({ where: { id } });
        const servings = meal.nutrition.calories / row.caloriesPerServing;
        return (
          4 * Math.abs(held.protein + row.proteinPerServing * servings - aim.protein) +
          9 * Math.abs(held.fat + row.fatPerServing * servings - aim.fat) +
          4 * Math.abs(held.carbs + row.carbsPerServing * servings - aim.carbs)
        );
      };
      const away = await Promise.all(others.map((row) => atThePortion(row.id)));
      const nearestFirst = others
        .map((row, index) => ({ id: row.id, away: away[index]! }))
        .sort((a, b) => a.away - b.away)
        .map((row) => row.id);

      const first = await offer(plan, meal);
      const second = await offer(plan, meal, { skip: [first.recipe.id] });

      expect([first.recipe.id, second.recipe.id]).toEqual(nearestFirst);
    });

    it('says what the day would come to against what it aims at', async () => {
      const plan = await aPlan(t, user, profile, { durationDays: 1 });

      const offered = await offer(plan, lunchOf(plan));

      expect(offered.targetMacros).toEqual(plan.days[0]!.targetMacros);
      expect(offered.dayAfter.protein).toBeGreaterThan(0);
    });

    it('tells a model what the day lacks, with the nearest first', async () => {
      await t.prisma.user.update({ where: { id: user.id }, data: { aiMode: 'admin' } });
      const plan = await aPlan(t, user, profile, { durationDays: 1 });
      t.model.reply({ text: 'no answer to read' });

      await t
        .http()
        .post('/api/meal-plans/ai-swap-meal/preview')
        .set(as(user))
        .send({ planId: plan.id, plannedMealId: lunchOf(plan).id })
        .expect(201);

      const prompt = t.model.requests.at(-1)!.prompt;
      expect(prompt).toContain('the whole day aims at');
      expect(prompt).toContain('brings the day nearest what it aims at');
    });
  });

  it('leaves the limits of the plan to a substitution, and says what it is outside of', async () => {
    const plan = await aPlan(t, user, profile, { durationDays: 1 });
    const meal = plan.days[0]!.meals.find((one) => one.mealType === 'dinner')!;
    const suggestions = (
      await t
        .http()
        .get(`/api/meal-plans/${plan.id}/meals/${meal.id}/substitutes`)
        .set(as(user))
        .expect(200)
    ).body as { fromIngredientId: string; to: { id: string } }[];
    if (suggestions.length === 0) return;

    const preview = (
      await t
        .http()
        .post('/api/meal-plans/swap-ingredient/preview')
        .set(as(user))
        .send({
          planId: plan.id,
          plannedMealId: meal.id,
          fromIngredientId: suggestions[0]!.fromIngredientId,
          toIngredientId: suggestions[0]!.to.id,
        })
        .expect(201)
    ).body as { outsideLimits: string[] };

    expect(preview.outsideLimits).toEqual([]);
  });
});
