// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { MealPlan } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { MealPlansService } from './meal-plans.service.js';

interface Text {
  title: string;
  description: string;
  steps: string[];
}

describe('the text of a recipe after an ingredient swap', () => {
  let t: TestApp;
  let plans: MealPlansService;
  let user: TestUser;
  let plan: MealPlan;
  let mealId: string;

  beforeAll(async () => {
    t = await createTestApp();
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
    plan = await aPlan(t, user, await aProfile(t, user));
    // The tofu rice bowl in the first lunch: "Combine firm tofu, white rice,
    // broccoli, olive oil." and, in Polish, "Połącz: tofu twarde, ryż biały,
    // brokuł, oliwa z oliwek."
    mealId = plan.days[0]!.meals.find((meal) => meal.mealType === 'lunch')!.id;
    const bowl = await t.prisma.recipe.findUniqueOrThrow({ where: { slug: 'tofu-rice-bowl' } });
    await t.prisma.plannedMeal.update({ where: { id: mealId }, data: { recipeId: bowl.id } });
  });

  const ingredientId = async (slug: string): Promise<string> => (await t.prisma.ingredient.findUniqueOrThrow({ where: { slug } })).id;

  /** Swap the broccoli of the bowl for tomato and return the text of what the meal holds now. */
  async function broccoliForTomato(): Promise<Record<string, Text>> {
    await plans.applyIngredientSwap(user.id, 'en', {
      planId: plan.id,
      plannedMealId: mealId,
      fromIngredientId: await ingredientId('broccoli'),
      toIngredientId: await ingredientId('tomato'),
    });
    const { recipeId } = await t.prisma.plannedMeal.findUniqueOrThrow({ where: { id: mealId } });
    const rows = await t.prisma.recipeTranslation.findMany({ where: { recipeId: recipeId! } });
    return Object.fromEntries(rows.map((row) => [row.locale, { title: row.title, description: row.description, steps: row.steps }]));
  }

  const everyWord = (text: Record<string, Text>): string =>
    Object.values(text)
      .flatMap((slice) => [slice.title, slice.description, ...slice.steps])
      .join(' ')
      .toLowerCase();

  it('names the substitute where the removed ingredient was, in English and in Polish', async () => {
    const text = await broccoliForTomato();

    expect(text.en!.steps).toEqual(['Combine firm tofu, white rice, tomato, olive oil.']);
    // "brokuł" ends in a letter outside ASCII, next to a comma.
    expect(text.pl!.steps).toEqual(['Połącz: tofu twarde, ryż biały, pomidor, oliwa z oliwek.']);
    // The title names the substitute as the catalogue writes it.
    expect(text.en!.title).toBe('Tofu rice bowl (with Tomato)');
    expect(text.pl!.title).toBe('Tofu rice bowl (pl) (z Pomidor)');
    expect(everyWord(text)).not.toContain('broccoli');
    expect(everyWord(text)).not.toContain('brokuł');
  });
});
