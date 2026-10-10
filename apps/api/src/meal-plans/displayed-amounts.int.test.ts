// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { MealPlan, PlannedMeal, Recipe } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

describe('quantities as a client receives them', () => {
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
    plan = await aPlan(t, user, await aProfile(t, user));
  });

  const amounts = (lines: { name: string; display: { quantity: number; unit: string } }[]): Record<string, string> =>
    Object.fromEntries(lines.map((line) => [line.name, `${line.display.quantity} ${line.display.unit}`]));

  /** The first breakfast of the plan as eggs on toast, with the given servings and rebalancer scale. */
  async function eggsOnToast(servings: number, quantityScale: number): Promise<PlannedMeal> {
    const breakfast = plan.days[0]!.meals.find((meal) => meal.mealType === 'breakfast')!;
    const recipe = await t.prisma.recipe.findUniqueOrThrow({ where: { slug: 'scrambled-eggs-on-toast' } });
    await t.prisma.plannedMeal.update({ where: { id: breakfast.id }, data: { recipeId: recipe.id, servings, quantityScale } });
    const res = await t.http().get(`/api/meal-plans/${plan.id}`).set(as(user)).expect(200);
    return (res.body as MealPlan).days[0]!.meals.find((meal) => meal.id === breakfast.id)!;
  }

  describe('a recipe', () => {
    it('shows eggs and bread in pieces of their own and the rest rounded, next to the exact line', async () => {
      const row = await t.prisma.recipe.findUniqueOrThrow({ where: { slug: 'scrambled-eggs-on-toast' } });

      const recipe = (await t.http().get(`/api/recipes/${row.id}`).set(as(user)).expect(200)).body as Recipe;

      // 165 g of egg at 55 g each, 70 g of bread at 35 g a slice, 5 ml of oil.
      expect(amounts(recipe.ingredients)).toEqual({ 'Large egg': '3 piece', 'Wholegrain bread': '2 slice', 'Olive oil': '5 ml' });
      expect(recipe.ingredients.find((line) => line.name === 'Large egg')).toMatchObject({ quantity: 165, unit: 'g' });
    });

    it('rounds grams to the nearest five', async () => {
      const row = await t.prisma.recipe.findUniqueOrThrow({
        where: { slug: 'chicken-rice-broccoli' },
        include: { ingredients: { include: { ingredient: true } } },
      });
      const chicken = row.ingredients.find((line) => line.ingredient.slug === 'chicken-breast')!;
      await t.prisma.recipeIngredient.update({ where: { id: chicken.id }, data: { quantity: 212.6 } });

      const recipe = (await t.http().get(`/api/recipes/${row.id}`).set(as(user)).expect(200)).body as Recipe;

      expect(amounts(recipe.ingredients)['Chicken breast']).toBe('215 g');
      await t.prisma.recipeIngredient.update({ where: { id: chicken.id }, data: { quantity: 150 } });
    });
  });

  describe('a planned meal', () => {
    it('carries its ingredients in the amounts it takes: servings and the rebalancer both counted', async () => {
      const meal = await eggsOnToast(1.5, 0.9);

      // 1.35 of a serving: 222.75 g of egg, 94.5 g of bread, 6.75 ml of oil.
      expect(amounts(meal.ingredients)).toEqual({ 'Large egg': '4 piece', 'Wholegrain bread': '2.5 slice', 'Olive oil': '7 ml' });
      const egg = meal.ingredients.find((line) => line.name === 'Large egg')!;
      expect(egg.quantity).toBeCloseTo(222.75, 6);
      expect(egg.unit).toBe('g');
      // The recipe itself stays as written.
      expect(amounts(meal.recipe!.ingredients)).toEqual({ 'Large egg': '3 piece', 'Wholegrain bread': '2 slice', 'Olive oil': '5 ml' });
    });

    it('names its ingredients in the language of the request', async () => {
      await eggsOnToast(1, 1);

      const polish = (await t.http().get(`/api/meal-plans/${plan.id}`).set(as(user)).set('Accept-Language', 'pl').expect(200)).body as MealPlan;

      const breakfast = polish.days[0]!.meals.find((meal) => meal.mealType === 'breakfast')!;
      expect(breakfast.ingredients.map((line) => line.name)).toContain('Jajko');
    });

    it('has no ingredients when the user wrote it in by hand', async () => {
      const res = await t
        .http()
        .post(`/api/meal-plans/${plan.id}/days/${plan.days[0]!.date}/custom-meal`)
        .set(as(user))
        .send({ mealType: 'snack', name: 'Protein bar', nutrition: { calories: 200, protein: 20, fat: 7, carbs: 15 } });
      expect(res.status).toBe(201);

      const body = res.body as { plan: MealPlan };
      const custom = body.plan.days[0]!.meals.find((meal) => meal.source === 'USER_CUSTOM')!;

      expect(custom.ingredients).toEqual([]);
    });
  });
});
