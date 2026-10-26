// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { MealPlan, PlannedMeal, SubstituteSuggestion, SwapPreview } from '@diet-app/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { MealPlansService } from './meal-plans.service.js';

describe('putting one ingredient of a planned meal in the place of another', () => {
  let t: TestApp;
  let user: TestUser;
  let plan: MealPlan;
  /** The first dinner of the plan: chicken with rice and broccoli, of 150 g, 80 g, 150 g and 10 ml of oil a serving. */
  let dinner: PlannedMeal;

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
    const recipe = await t.prisma.recipe.findUniqueOrThrow({
      where: { slug: 'chicken-rice-broccoli' },
    });
    plan = await aPlan(t, user, await aProfile(t, user), {
      durationDays: 1,
      dayOverrides: [
        { date: '2026-01-05', lockedSlots: [{ mealType: 'dinner', recipeId: recipe.id }] },
      ],
    });
    dinner = plan.days[0]!.meals.find((meal) => meal.mealType === 'dinner')!;
  });

  const id = async (slug: string): Promise<string> =>
    (await t.prisma.ingredient.findUniqueOrThrow({ where: { slug } })).id;
  const swap = async (from: string, to: string, over: Record<string, unknown> = {}) => ({
    planId: plan.id,
    plannedMealId: dinner.id,
    fromIngredientId: await id(from),
    toIngredientId: await id(to),
    ...over,
  });
  const preview = async (from: string, to: string): Promise<SwapPreview> =>
    (
      await t
        .http()
        .post('/api/meal-plans/swap-ingredient/preview')
        .set(as(user))
        .send(await swap(from, to))
        .expect(201)
    ).body;
  /** The answer to applying the swap, for which `status` says how it ended. */
  const apply = async (from: string, to: string, over: Record<string, unknown> = {}) =>
    t
      .http()
      .post('/api/meal-plans/swap-ingredient/apply')
      .set(as(user))
      .send(await swap(from, to, over));
  /** The lines of the recipe the dinner holds now, by ingredient. */
  const linesNow = async (): Promise<Record<string, number[]>> => {
    const meal = await t.prisma.plannedMeal.findUniqueOrThrow({
      where: { id: dinner.id },
      include: { recipe: { include: { ingredients: { include: { ingredient: true } } } } },
    });
    const lines: Record<string, number[]> = {};
    for (const line of meal.recipe!.ingredients)
      (lines[line.ingredient.slug!] ??= []).push(line.quantity);
    return lines;
  };
  const taken = (slug: string) =>
    dinner.ingredients.find((line) => line.name.toLowerCase() === slug.replace(/-/g, ' '))!;

  describe('the preview', () => {
    it('shows the meal as it is planned, before and after, and what it takes of the two ingredients', async () => {
      const shown = await preview('white-rice', 'chickpeas');

      // The dinner is more than one serving of the recipe: the figures are those of the plate.
      expect(dinner.servings).toBeGreaterThan(1);
      expect(shown.before).toEqual(dinner.nutrition);
      expect(shown.from).toMatchObject({
        ingredientId: await id('white-rice'),
        name: 'White rice',
        unit: 'g',
      });
      expect(shown.from.quantity).toBeCloseTo(taken('white-rice').quantity, 5);
      expect(shown.from.quantity).toBeCloseTo(80 * dinner.servings, 5);
      expect(shown.to).toMatchObject({
        ingredientId: await id('chickpeas'),
        name: 'Chickpeas',
        unit: 'g',
      });
      expect(shown.calorieDelta).toBe(shown.after.calories - shown.before.calories);
      expect(shown.macroDelta.protein).toBe(shown.after.protein - shown.before.protein);
    });

    it('gives as much of the substitute as holds the same energy', async () => {
      const shown = await preview('white-rice', 'chickpeas');

      // 80 g of rice hold 288 kcal; so do 175.6 g of chickpeas.
      expect(shown.sizing).toBe('energy');
      expect(shown.to.quantity / dinner.servings).toBeCloseTo((80 * 360) / 164, 1);
      expect(Math.abs(shown.calorieDelta)).toBeLessThanOrEqual(3);
      expect(shown).toMatchObject({ merged: false, violations: [], valid: true });
    });

    it('gives no more than three times what leaves, and says that what a serving holds moves', async () => {
      // 10 ml of oil hold the energy of 239 g of broccoli, and weigh 9.2 g.
      const shown = await preview('olive-oil', 'broccoli');

      expect(shown.sizing).toBe('capped');
      expect(shown.to.quantity / dinner.servings).toBeCloseTo(27.6, 5);
      // The recipe has broccoli already: its line takes the amount on.
      expect(shown.merged).toBe(true);
      expect(shown.moved).toEqual(['calories', 'fat']);
      expect(shown.valid).toBe(true);
    });

    it("names what stands in the way of a substitute, as the plan's gate would", async () => {
      const profile = await t.prisma.profile.findFirstOrThrow({ where: { userId: user.id } });
      await t.prisma.profilePreference.update({
        where: { profileId: profile.id },
        data: { allergens: ['fish'], excludedIngredientIds: [await id('salmon')] },
      });

      const shown = await preview('chicken-breast', 'salmon');

      expect(shown.violations).toEqual(['allergen', 'excluded_ingredient']);
      expect(shown.valid).toBe(false);
    });

    it('takes an ingredient that lists no diet for one that suits none of the diets decided by ingredients', async () => {
      // Nobody has said what diets it suits: a vegetarian plan cannot take it, a balanced one can.
      const unknown = await t.prisma.ingredient.create({
        data: {
          slug: 'mystery-grain',
          name: 'Mystery grain',
          category: 'grains',
          canonicalUnit: 'g',
          caloriesPer100: 350,
          proteinPer100: 8,
          fatPer100: 1,
          carbsPer100: 76,
        },
      });
      try {
        expect((await preview('white-rice', 'mystery-grain')).violations).toEqual([]);

        await t.prisma.mealPlan.update({
          where: { id: plan.id },
          data: { dietType: 'vegetarian' },
        });
        // The dinner has chicken in it, which the plan's new diet would not have let in: only what the substitute adds is held against it.
        const tofu = await t.prisma.recipe.findUniqueOrThrow({ where: { slug: 'tofu-rice-bowl' } });
        await t.prisma.plannedMeal.update({
          where: { id: dinner.id },
          data: { recipeId: tofu.id },
        });
        expect(await preview('white-rice', 'mystery-grain')).toMatchObject({
          violations: ['off_diet'],
          valid: false,
        });
      } finally {
        await t.prisma.plannedMeal.deleteMany({ where: { id: dinner.id } });
        await t.prisma.ingredient.delete({ where: { id: unknown.id } });
      }
    });

    it('takes the same amount where one of the two holds no energy', async () => {
      const water = await t.prisma.ingredient.create({
        data: {
          slug: 'still-water',
          name: 'Still water',
          category: 'beverages',
          canonicalUnit: 'ml',
          caloriesPer100: 0,
          proteinPer100: 0,
          fatPer100: 0,
          carbsPer100: 0,
        },
      });
      try {
        const shown = await preview('olive-oil', 'still-water');

        expect(shown.sizing).toBe('mass');
        expect(shown.to.quantity / dinner.servings).toBeCloseTo(10, 5);
        expect(shown.to.unit).toBe('ml');
      } finally {
        await t.prisma.ingredient.delete({ where: { id: water.id } });
      }
    });

    it('writes nothing', async () => {
      await preview('white-rice', 'chickpeas');

      expect((await t.app.get(MealPlansService).get(user.id, 'en', plan.id)).revision).toBe(
        plan.revision,
      );
      expect(await linesNow()).toEqual({
        'chicken-breast': [150],
        'white-rice': [80],
        broccoli: [150],
        'olive-oil': [10],
      });
    });
  });

  describe('what the catalogue suggests', () => {
    const suggested = async (locale = 'en'): Promise<SubstituteSuggestion[]> =>
      (
        await t
          .http()
          .get(`/api/meal-plans/${plan.id}/meals/${dinner.id}/substitutes`)
          .set(as(user))
          .set('Accept-Language', locale)
          .expect(200)
      ).body;

    it('is the substitute its rules name for an ingredient of the meal, with what it would move', async () => {
      // The catalogue has one rule for an ingredient of this dinner: tofu for chicken.
      const suggestions = await suggested();

      expect(suggestions).toHaveLength(1);
      expect(suggestions[0]).toMatchObject({
        fromIngredientId: await id('chicken-breast'),
        to: { id: await id('firm-tofu'), name: 'Firm tofu' },
        moved: ['protein', 'fat'],
      });
      expect((await suggested('pl'))[0]!.to.name).toBe('Tofu twarde');
    });

    it('is what the preview of that substitution says', async () => {
      const [suggestion] = await suggested();

      const shown = await preview('chicken-breast', 'firm-tofu');

      expect(shown.moved).toEqual(suggestion!.moved);
      expect(shown.valid).toBe(true);
    });

    it('leaves out a substitute the profile rules out', async () => {
      const profile = await t.prisma.profile.findFirstOrThrow({ where: { userId: user.id } });
      await t.prisma.profilePreference.update({
        where: { profileId: profile.id },
        data: { allergens: ['soy'] },
      });

      expect(await suggested()).toEqual([]);
    });

    it('is, of several the rules name, the one that changes a serving least', async () => {
      // Turkey is nearly what chicken is; tofu has less protein and more fat.
      const turkey = await t.prisma.ingredient.create({
        data: {
          slug: 'turkey-breast',
          name: 'Turkey breast',
          category: 'meat',
          canonicalUnit: 'g',
          caloriesPer100: 118,
          proteinPer100: 23,
          fatPer100: 2.4,
          carbsPer100: 0,
        },
      });
      await t.prisma.substitutionRule.create({
        data: { fromIngredientId: await id('chicken-breast'), toIngredientId: turkey.id },
      });
      try {
        expect(await suggested()).toMatchObject([{ to: { name: 'Turkey breast' }, moved: [] }]);
      } finally {
        await t.prisma.ingredient.delete({ where: { id: turkey.id } });
      }
    });

    describe('where a model was asked for a substitute and named none', () => {
      /** Another meat, so that the model has something to choose from for the chicken. */
      let turkeyId: string;
      const askedForChicken = async () =>
        (
          await t
            .http()
            .post('/api/meal-plans/swap-ingredient/ai-suggest')
            .set(as(user))
            .send({
              planId: plan.id,
              plannedMealId: dinner.id,
              fromIngredientId: await id('chicken-breast'),
            })
            .expect(201)
        ).body;

      beforeEach(async () => {
        t.model.reset();
        t.model.reply({ text: 'no idea' });
        await t.prisma.user.update({ where: { id: user.id }, data: { aiMode: 'admin' } });
        const turkey = await t.prisma.ingredient.create({
          data: {
            slug: 'turkey-breast',
            name: 'Turkey breast',
            category: 'meat',
            canonicalUnit: 'g',
            caloriesPer100: 118,
            proteinPer100: 23,
            fatPer100: 2.4,
            carbsPer100: 0,
            dietCompatibility: ['balanced'],
          },
        });
        turkeyId = turkey.id;
      });

      afterEach(async () => {
        await t.prisma.ingredient.delete({ where: { id: turkeyId } });
      });

      it("is what is suggested in the model's place", async () => {
        const answer = await askedForChicken();

        expect(answer.toIngredient).toMatchObject({ id: await id('firm-tofu'), name: 'Firm tofu' });
        expect(answer.aiMeta).toMatchObject({
          usedDeterministicFallback: true,
          fallbackReason: 'invalid_output',
        });
      });

      it('gives way to an ingredient of the same kind where the profile rules out what the rules name', async () => {
        const profile = await t.prisma.profile.findFirstOrThrow({ where: { userId: user.id } });
        await t.prisma.profilePreference.update({
          where: { profileId: profile.id },
          data: { allergens: ['soy'] },
        });

        expect((await askedForChicken()).toIngredient.id).toBe(turkeyId);
      });

      it('is not asked where the model names one of what it was shown', async () => {
        t.model.reset();
        t.model.reply({ text: JSON.stringify({ ingredientId: turkeyId, reason: 'Leaner.' }) });

        const answer = await askedForChicken();

        expect(answer.toIngredient.id).toBe(turkeyId);
        expect(answer.aiMeta).toMatchObject({
          usedDeterministicFallback: false,
          reason: 'Leaner.',
        });
      });
    });
  });

  describe('applying it', () => {
    it('writes what the preview showed, and refuses on what the preview warned of', async () => {
      // Chickpeas for rice hold the same energy, with more protein and fat and less carbohydrate.
      const shown = await preview('white-rice', 'chickpeas');
      expect(shown.moved).toEqual(['protein', 'fat', 'carbs']);

      expect(await apply('white-rice', 'chickpeas')).toMatchObject({
        status: 422,
        body: { details: { moved: shown.moved } },
      });
      const applied = await apply('white-rice', 'chickpeas', { acceptChange: true });

      expect(applied.status).toBe(201);
      expect(await linesNow()).toEqual({
        'chicken-breast': [150],
        chickpeas: [175.6],
        broccoli: [150],
        'olive-oil': [10],
      });
      // Before the day is rebalanced around it, the meal holds what the preview said it would.
      const now = (applied.body.plan as MealPlan).days[0]!.meals.find(
        (meal) => meal.id === dinner.id,
      )!;
      expect(now.nutrition.protein / now.quantityScale).toBeCloseTo(shown.after.protein, -1);
    });

    it('needs nothing accepted where a serving holds much the same afterwards', async () => {
      // Tomato for broccoli: a few grams of anything either way.
      expect((await preview('broccoli', 'tomato')).moved).toEqual([]);

      expect((await apply('broccoli', 'tomato')).status).toBe(201);
    });

    it('is refused when what a serving holds moves by more than a tenth, until the request accepts that', async () => {
      const refused = await apply('olive-oil', 'broccoli');

      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject({
        error: 'SUBSTITUTION_MOVES_NUTRITION',
        details: { moved: ['calories', 'fat'] },
      });
      expect(await linesNow()).toHaveProperty('olive-oil');

      expect((await apply('olive-oil', 'broccoli', { acceptChange: true })).status).toBe(201);
      // One line of broccoli, the old amount and the substitute together; no oil.
      expect(await linesNow()).toEqual({
        'chicken-breast': [150],
        'white-rice': [80],
        broccoli: [177.6],
      });
    });

    it('is refused for a substitute the profile rules out, whatever the request accepts', async () => {
      const profile = await t.prisma.profile.findFirstOrThrow({ where: { userId: user.id } });
      await t.prisma.profilePreference.update({
        where: { profileId: profile.id },
        data: { allergens: ['fish'] },
      });

      const refused = await apply('chicken-breast', 'salmon', { acceptChange: true });

      expect(refused.status).toBe(400);
      expect(refused.body).toMatchObject({
        error: 'INVALID_SUBSTITUTION',
        details: { violations: ['allergen'] },
      });
    });

    it('refuses an ingredient in its own place, one the recipe does not have, and one that is not there', async () => {
      expect(await apply('white-rice', 'white-rice')).toMatchObject({
        status: 400,
        body: { error: 'SAME_INGREDIENT' },
      });
      expect(await apply('salmon', 'chickpeas')).toMatchObject({
        status: 404,
        body: { error: 'INGREDIENT_NOT_IN_RECIPE' },
      });
      const gone = await t
        .http()
        .post('/api/meal-plans/swap-ingredient/apply')
        .set(as(user))
        .send({
          ...(await swap('white-rice', 'chickpeas')),
          toIngredientId: '00000000-0000-4000-8000-000000000000',
        });
      expect(gone.status).toBe(404);
      expect(gone.body.error).toBe('INGREDIENT_NOT_FOUND');
    });

    it('takes every line the recipe has of the ingredient, and writes one for the substitute', async () => {
      // The oil is in the recipe twice: for the pan and for the plate.
      const meal = await t.prisma.plannedMeal.findUniqueOrThrow({ where: { id: dinner.id } });
      await t.prisma.recipeIngredient.create({
        data: {
          recipeId: meal.recipeId!,
          ingredientId: await id('olive-oil'),
          quantity: 5,
          unit: 'ml',
          note: 'to finish',
        },
      });
      try {
        const shown = await preview('olive-oil', 'peanut-butter');
        // 15 ml of oil hold 122 kcal; so do 20.7 g of peanut butter.
        expect(shown.from.quantity / dinner.servings).toBeCloseTo(15, 5);
        expect(shown.to.quantity / dinner.servings).toBeCloseTo((15 * 813) / 588, 1);

        expect((await apply('olive-oil', 'peanut-butter', { acceptChange: true })).status).toBe(
          201,
        );
        expect(await linesNow()).toEqual({
          'chicken-breast': [150],
          'white-rice': [80],
          broccoli: [150],
          'peanut-butter': [20.7],
        });
      } finally {
        await t.prisma.recipeIngredient.deleteMany({
          where: { recipeId: meal.recipeId!, note: 'to finish' },
        });
      }
    });
  });
});
