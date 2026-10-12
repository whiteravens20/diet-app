// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { DietType, MEAL_SLOTS_BY_COUNT, MealType, fitsDiet } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { COVERAGE_TARGET } from '../engine/coverage.js';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPrivateRecipe, aProfile, aRecipeDraft, as, asAdmin, aUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { CatalogueCoverageService } from './catalogue-coverage.service.js';

describe('what the catalogue can serve', () => {
  let t: TestApp;
  const basic = asAdmin;

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
    await t.prisma.recipe.updateMany({ data: { retiredAt: null } });
    await t.app.get(CatalogueCoverageService).count();
  });

  /** The same count, straight from the rows a plan may use. */
  const counted = async (diet: DietType, meal: MealType): Promise<number> => {
    const shared = await t.prisma.recipe.findMany({ where: { createdByUserId: null, retiredAt: null, deletedAt: null }, select: { dietTags: true, mealTypes: true } });
    return shared.filter((r) => r.mealTypes.includes(meal) && fitsDiet(r.dietTags, diet)).length;
  };

  it('is published for every diet and number of meals: the recipes the thinnest meal can choose from', async () => {
    const { depth } = (await t.http().get('/api/config').expect(200)).body.catalogue;

    for (const diet of DietType.options) {
      for (const [count, meals] of Object.entries(MEAL_SLOTS_BY_COUNT)) {
        const thinnest = Math.min(...(await Promise.all(meals.map((meal) => counted(diet, meal)))));
        expect(depth[diet][count], `${diet}, ${count} meals`).toBe(thinnest);
      }
    }
    expect(depth.balanced['3']).toBeGreaterThan(0);
  });

  it('is shown to the administrator meal by meal, with how many a release needs for each', async () => {
    const { coverage, coverageTarget } = (await t.http().get('/api/admin/stats').set(basic).expect(200)).body;

    expect(coverage.vegan.lunch).toBe(await counted('vegan', 'lunch'));
    expect(Object.keys(coverage.balanced).sort()).toEqual([...MealType.options].sort());
    expect(coverageTarget).toBe(COVERAGE_TARGET);
  });

  it('shows the administrator the drafts that wait for each diet and meal: those nobody rejected and that have not shipped', async () => {
    // Oats, an oat drink and a banana: a breakfast for every diet but the two that keep carbohydrate low.
    await aRecipeDraft(t);
    await aRecipeDraft(t, { status: 'APPROVED', mealTypes: ['breakfast', 'snack'] });
    await aRecipeDraft(t, { status: 'REJECTED' });
    await aRecipeDraft(t, { status: 'SHIPPED' });

    const { coverageWaiting } = (await t.http().get('/api/admin/stats').set(basic).expect(200)).body;

    expect(coverageWaiting.vegan).toEqual({ breakfast: 2, second_breakfast: 0, lunch: 0, snack: 1, dinner: 0 });
    expect(coverageWaiting.balanced.breakfast).toBe(2);
    expect(coverageWaiting.keto.breakfast).toBe(0);
    expect(Object.keys(coverageWaiting).sort()).toEqual([...DietType.options].sort());
  });

  it('tells the administrator what each diet aims at and what its plans reach, as shares of a day\'s energy', async () => {
    const { macros } = (await t.http().get('/api/admin/stats').set(basic).expect(200)).body;

    expect(macros.outOfReach).toBe(0.1);
    expect(macros.diets.high_protein.target).toEqual({ protein: 0.4, fat: 0.3, carbs: 0.3 });
    // The catalogue has what a balanced plan needs, and too little that is rich in protein for a high-protein one.
    const { balanced, high_protein: highProtein } = macros.diets;
    expect(balanced.reached.protein + balanced.reached.fat + balanced.reached.carbs).toBeCloseTo(1);
    expect(balanced.reached.distance).toBeLessThan(0.1);
    expect(highProtein.reached.protein).toBeGreaterThan(balanced.reached.protein);
    expect(highProtein.reached.distance).toBeGreaterThan(0.1);
    // No plan can be made where a meal of the day has no recipe for the diet.
    expect(macros.diets.keto.reached).toBeNull();
  });

  it('leaves out what a user made for themselves', async () => {
    const before = (await t.http().get('/api/admin/stats').set(basic).expect(200)).body.coverage;
    await aPrivateRecipe(t, await aUser(t), { mealTypes: ['lunch'] });

    const after = (await t.http().get('/api/admin/stats').set(basic).expect(200)).body.coverage;

    expect(await t.prisma.recipe.count({ where: { createdByUserId: { not: null }, mealTypes: { has: 'lunch' }, dietTags: { has: 'vegan' } } })).toBe(1);
    expect(after).toEqual(before);
  });

  it('leaves out what an update retired, and is read anew once a minute or when the administrator looks', async () => {
    const before = (await t.http().get('/api/config')).body.catalogue.depth;
    const dinners = await t.prisma.recipe.findMany({ where: { createdByUserId: null, mealTypes: { has: 'dinner' } }, select: { id: true } });
    await t.prisma.recipe.updateMany({ where: { id: { in: dinners.map((r) => r.id) } }, data: { retiredAt: new Date() } });

    // Kept for a minute: the public configuration is asked for on every page.
    expect((await t.http().get('/api/config')).body.catalogue.depth).toEqual(before);
    // The administrator's statistics count anew, and what they found is what is published from then on.
    const { coverage } = (await t.http().get('/api/admin/stats').set(basic).expect(200)).body;
    const after = (await t.http().get('/api/config')).body.catalogue.depth;

    expect(before.balanced['2']).toBeGreaterThan(0);
    expect(coverage.balanced.dinner).toBe(0);
    expect(after.balanced['2']).toBe(0);
    expect(after.balanced['3']).toBe(0);
  });

  it('is named when a plan cannot be made: which meal, which diet', async () => {
    const user = await aUser(t);
    const profile = await aProfile(t, user, { dietType: 'vegan' });
    const lunches = await t.prisma.recipe.findMany({ where: { createdByUserId: null, mealTypes: { has: 'lunch' }, dietTags: { has: 'vegan' } }, select: { id: true } });
    await t.prisma.recipe.updateMany({ where: { id: { in: lunches.map((r) => r.id) } }, data: { retiredAt: new Date() } });

    const res = await t.http().post('/api/meal-plans/generate').set(as(user)).send({ profileId: profile.id, startDate: '2026-01-05', durationDays: 3, mealCount: 3 });

    expect(res.status).toBe(400);
    // Nothing was ruled out by the profile: the catalogue has no such recipe.
    expect(res.body).toMatchObject({ error: 'NO_ELIGIBLE_RECIPE', details: { slot: 'lunch', dietType: 'vegan', ruledOut: 0 } });
    // A day of two meals has no lunch, so fewer meals can help.
    expect(res.body.message).toBe('There is no recipe for lunch on the vegan diet. Choose another diet or fewer meals a day.');
  });

  it('does not advise fewer meals a day for a meal that every day has', async () => {
    const user = await aUser(t);
    const profile = await aProfile(t, user, { dietType: 'vegan' });
    const breakfasts = await t.prisma.recipe.findMany({ where: { createdByUserId: null, mealTypes: { has: 'breakfast' }, dietTags: { has: 'vegan' } }, select: { id: true } });
    await t.prisma.recipe.updateMany({ where: { id: { in: breakfasts.map((r) => r.id) } }, data: { retiredAt: new Date() } });

    const res = await t.http().post('/api/meal-plans/generate').set(as(user)).send({ profileId: profile.id, startDate: '2026-01-05', durationDays: 3, mealCount: 3 });

    expect(res.body).toMatchObject({ error: 'NO_ELIGIBLE_RECIPE', details: { slot: 'breakfast', dietType: 'vegan', ruledOut: 0 } });
    expect(res.body.message).toBe('There is no recipe for breakfast on the vegan diet. Choose another diet.');
  });

  it('is told apart from a profile that rules out every recipe there is', async () => {
    const user = await aUser(t);
    const lunches = await t.prisma.recipe.findMany({ where: { createdByUserId: null, mealTypes: { has: 'lunch' }, dietTags: { has: 'vegan' } }, select: { allergens: true, ingredients: { select: { ingredientId: true } } } });
    expect(lunches.length).toBeGreaterThan(0);
    // Skip one ingredient of every vegan lunch: each is ruled out, none is missing from the catalogue.
    const skipped = [...new Set(lunches.map((r) => r.ingredients[0]!.ingredientId))];
    const profile = await aProfile(t, user, {
      dietType: 'vegan',
      preferences: { favoriteIngredientIds: [], excludedIngredientIds: skipped, allergens: [], dislikedIngredientIds: [], preferredCuisines: [], maxConsecutiveDaysSameMeal: 2, maxTimesPerWeekSameMeal: 3, inventoryBiasResetEvery: 5 },
    });

    const res = await t.http().post('/api/meal-plans/generate').set(as(user)).send({ profileId: profile.id, startDate: '2026-01-05', durationDays: 3, mealCount: 3 });

    // Breakfast may share a skipped ingredient: whichever meal runs dry first, it had recipes before the profile's rules.
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('NO_ELIGIBLE_RECIPE');
    expect(res.body.details.dietType).toBe('vegan');
    expect(res.body.details.ruledOut).toBeGreaterThan(0);
    expect(res.body.message).toContain("is ruled out by this profile's allergens, skipped ingredients or avoided recipes");
  });
});
