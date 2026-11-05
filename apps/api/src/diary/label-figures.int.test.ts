// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { DiaryDay, DiaryEntry, MealPlan, Profile, Recipe } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { roundLabel, scaleLabel, storedTotals, sumLabels } from '../engine/label-totals.js';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

const today = new Date().toISOString().slice(0, 10);
const known = (grams: number) => ({ grams: expect.closeTo(grams, 5), atLeast: false });
const atLeast = (grams: number) => ({ grams: expect.closeTo(grams, 5), atLeast: true });

describe('fibre, sugars, salt and saturated fat', () => {
  let t: TestApp;
  let user: TestUser;
  let profile: Profile;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
  });

  beforeEach(async () => {
    await resetUserData(t.prisma);
    user = await aUser(t);
    profile = await aProfile(t, user);
  });

  afterAll(async () => {
    await t.close();
  });

  const recipeId = async (slug: string) =>
    (await t.prisma.recipe.findUniqueOrThrow({ where: { slug } })).id;
  const ingredientId = async (slug: string) =>
    (await t.prisma.ingredient.findUniqueOrThrow({ where: { slug } })).id;
  const recipe = async (slug: string): Promise<Recipe> =>
    (
      await t
        .http()
        .get(`/api/recipes/${await recipeId(slug)}`)
        .set(as(user))
        .expect(200)
    ).body;
  const write = async (entry: Record<string, unknown>): Promise<DiaryEntry> =>
    (
      await t
        .http()
        .post('/api/diary/entries')
        .set(as(user))
        .set('X-Client-Date', today)
        .send({ profileId: profile.id, date: today, mealType: 'breakfast', ...entry })
        .expect(201)
    ).body;
  const diaryDay = async (): Promise<DiaryDay> =>
    (
      await t
        .http()
        .get(`/api/diary/day?profileId=${profile.id}&date=${today}`)
        .set(as(user))
        .expect(200)
    ).body;
  const aMealOfOnesOwn = () =>
    write({ kind: 'meal', name: 'Lunch out', servings: 1, nutrition: { calories: 600 } });
  const setLimits = (labelLimits: Record<string, number | null>) =>
    t.http().patch(`/api/profiles/${profile.id}/preferences`).set(as(user)).send({ labelLimits });

  it('of a recipe are those of a serving, and at least so much where an ingredient lacks one', async () => {
    // Oats and milk give all four.
    expect((await recipe('milk-porridge')).labelPerServing).toEqual({
      fiber: known(6),
      sugars: known(13.1),
      salt: known(0.3),
      saturatedFat: known(5.5),
    });
    // The oat drink and the banana give none.
    expect((await recipe('oat-porridge-with-banana')).labelPerServing).toEqual({
      fiber: atLeast(6),
      sugars: atLeast(0.6),
      salt: atLeast(0),
      saturatedFat: atLeast(0.7),
    });
  });

  it('are kept on an entry of a recipe and of an ingredient, and summed for the day with what is not known', async () => {
    const fromRecipe = await write({
      kind: 'recipe',
      recipeId: await recipeId('milk-porridge'),
      servings: 2,
    });
    expect(fromRecipe.label).toEqual({ fiber: 12, sugars: 26.2, salt: 0.5, saturatedFat: 10.9 });
    expect(fromRecipe.labelAtLeast).toEqual([]);

    const fromIngredient = await write({
      kind: 'ingredient',
      ingredientId: await ingredientId('rolled-oats'),
      amount: { quantity: 50, unit: 'g' },
    });
    expect(fromIngredient.label).toEqual({ fiber: 5, sugars: 0.5, salt: 0, saturatedFat: 0.6 });

    const partly = await write({
      kind: 'recipe',
      recipeId: await recipeId('oat-porridge-with-banana'),
      servings: 1,
    });
    expect(partly.labelAtLeast).toEqual(['fiber', 'sugars', 'salt', 'saturatedFat']);

    expect((await aMealOfOnesOwn()).label).toBeNull();
    expect((await diaryDay()).eatenLabel).toEqual({
      fiber: atLeast(23),
      sugars: atLeast(27.3),
      salt: atLeast(0.5),
      saturatedFat: atLeast(12.3),
    });
  });

  it("notes the limits of the profile that the day's eating crosses, and none it cannot know to be crossed", async () => {
    await setLimits({
      saltAtMost: null,
      fiberAtLeast: 25,
      saturatedFatAtMost: null,
      sugarsAtMost: 10,
    }).expect(200);
    await write({ kind: 'recipe', recipeId: await recipeId('milk-porridge'), servings: 2 });
    expect((await diaryDay()).labelNotes).toEqual([
      { nutrient: 'fiber', kind: 'atLeast', limit: 25, figure: known(12) },
      { nutrient: 'sugars', kind: 'atMost', limit: 10, figure: known(26.2) },
    ]);

    // A meal of one's own may hold the fibre that is missing: the day is no longer known to be short of it.
    await aMealOfOnesOwn();
    expect((await diaryDay()).labelNotes.map((note) => note.nutrient)).toEqual(['sugars']);
  });

  it('of a planned meal are its recipe’s for its servings, and its day sums its meals', async () => {
    const generated = await aPlan(t, user, profile);
    const plan: MealPlan = (
      await t.http().get(`/api/meal-plans/${generated.id}`).set(as(user)).expect(200)
    ).body;
    const first = plan.days[0]!;
    for (const meal of first.meals) {
      const stored = await t.prisma.recipe.findUniqueOrThrow({ where: { id: meal.recipe!.id } });
      expect(meal.label).toEqual(
        roundLabel(
          scaleLabel(storedTotals(stored.labelPerServing)!, meal.servings * meal.quantityScale),
        ),
      );
    }
    expect(first.dayLabel).toEqual(roundLabel(sumLabels(first.meals.map((meal) => meal.label))));
    // The profile sets no limits.
    expect(first.labelNotes).toEqual([]);
  });

  it('limits of a profile are set alone, kept by a whole profile that leaves them out, and refused outside their range', async () => {
    const limits = { saltAtMost: 5, fiberAtLeast: 25, saturatedFatAtMost: 20, sugarsAtMost: 90 };
    const set: Profile = (await setLimits(limits).expect(200)).body;
    expect(set.preferences.labelLimits).toEqual(limits);

    // A whole profile as a client from before the limits sends it.
    const { id, userId, riskAcknowledgedAt, createdAt, updatedAt, ...rest } = set;
    const { labelLimits, ...preferences } = rest.preferences;
    expect([id, userId, riskAcknowledgedAt, createdAt, updatedAt, labelLimits]).toBeDefined();
    const saved: Profile = (
      await t
        .http()
        .put(`/api/profiles/${profile.id}`)
        .set(as(user))
        .send({ ...rest, name: 'Me again', preferences })
        .expect(200)
    ).body;
    expect(saved.name).toBe('Me again');
    expect(saved.preferences.labelLimits).toEqual(limits);

    await setLimits({ ...limits, saltAtMost: 0.5 }).expect(400);
    await setLimits({ ...limits, fiberAtLeast: 200 }).expect(400);
  });
});
