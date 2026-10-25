// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { ListProposals, MealPlan, Profile, ShoppingList } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { ListProposalsService } from './list-proposals.service.js';
import { ShoppingListsService } from './shopping-lists.service.js';

/**
 * The fixture recipes of the day below. Chicken comes in packs of 500 g and
 * milk by the litre, and neither keeps; tofu is sold loose. The catalogue
 * names tofu as a substitute for chicken.
 */
const PORRIDGE = 'milk-porridge'; // 250 ml of milk
const CHICKEN_RICE = 'chicken-rice-broccoli'; // 150 g of chicken
const TOFU_BOWL = 'tofu-rice-bowl'; // 180 g of tofu
const STEW = 'chickpea-tomato-stew'; // no chicken and no tofu

describe('what a shopping list could do without', () => {
  let t: TestApp;
  let proposals: ListProposalsService;
  let lists: ShoppingListsService;
  let user: TestUser;
  let profile: Profile;
  let plan: MealPlan;
  let list: ShoppingList;

  beforeAll(async () => {
    t = await createTestApp();
    proposals = t.app.get(ListProposalsService);
    lists = t.app.get(ShoppingListsService);
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
  });

  afterAll(async () => {
    await t.close();
  });

  const mealOf = (mealType: string) =>
    plan.days[0]!.meals.find((meal) => meal.mealType === mealType)!;
  const rowOf = (name: string) =>
    list.groups.flatMap((group) => group.items).find((row) => row.name === name)!;
  const proposed = (weigh = false, locale: 'en' | 'pl' = 'en'): Promise<ListProposals> =>
    proposals.propose(user.id, locale, list.id, { weigh });
  const listOfTheDay = async (): Promise<ShoppingList> =>
    (list = await lists.generate(user.id, 'en', {
      planId: plan.id,
      fromDate: plan.days[0]!.date,
      toDate: plan.days[0]!.date,
    }));

  beforeEach(async () => {
    await resetUserData(t.prisma);
    t.model.reset();
    user = await aUser(t);
    profile = await aProfile(t, user);
    plan = await aPlan(t, user, profile, { durationDays: 2 });
    for (const [mealType, slug] of [
      ['breakfast', PORRIDGE],
      ['lunch', CHICKEN_RICE],
      ['dinner', TOFU_BOWL],
    ] as const) {
      const recipe = await t.prisma.recipe.findUniqueOrThrow({ where: { slug } });
      await t.prisma.plannedMeal.update({
        where: { id: mealOf(mealType).id },
        data: {
          recipeId: recipe.id,
          servings: 1,
          quantityScale: 1,
          source: 'CATALOGUE',
          eatenAt: null,
        },
      });
    }
    await listOfTheDay();
  });

  describe('as the engine works it out', () => {
    it('names a row that another row could stand for, the meals it is made in and the packs it saves, and then the packs that will be left over', async () => {
      const { proposals: found, planId, aiMeta } = await proposed();

      expect(planId).toBe(plan.id);
      expect(aiMeta).toBeNull();
      expect(found).toEqual([
        {
          kind: 'merge',
          from: { ingredientId: rowOf('Chicken breast').ingredientId, name: 'Chicken breast' },
          to: { ingredientId: rowOf('Firm tofu').ingredientId, name: 'Firm tofu' },
          meals: [
            {
              plannedMealId: mealOf('lunch').id,
              date: plan.days[0]!.date,
              mealType: 'lunch',
              title: 'Chicken rice broccoli',
            },
          ],
          packsSaved: 1,
          reason: null,
        },
        // Three quarters of a litre of milk, and seven tenths of a pack of chicken.
        {
          kind: 'leftover',
          ingredientId: rowOf('Whole milk').ingredientId,
          name: 'Whole milk',
          unit: 'ml',
          left: 750,
          packSize: 1000,
          reason: null,
        },
        {
          kind: 'leftover',
          ingredientId: rowOf('Chicken breast').ingredientId,
          name: 'Chicken breast',
          unit: 'g',
          left: 350,
          packSize: 500,
          reason: null,
        },
      ]);
    });

    it('proposes no merge the plan would not take: the profile has come to avoid what the substitute holds', async () => {
      await t
        .http()
        .patch(`/api/profiles/${profile.id}/preferences`)
        .set(as(user))
        .send({ allergens: ['soy'] })
        .expect(200);

      expect((await proposed()).proposals.map((proposal) => proposal.kind)).toEqual([
        'leftover',
        'leftover',
      ]);
    });

    it('proposes no merge where a meal that uses the row was eaten: the row cannot go', async () => {
      await t
        .http()
        .patch(`/api/meal-plans/${plan.id}/meals/${mealOf('lunch').id}/eaten`)
        .set(as(user))
        .send({ eaten: true })
        .expect(200);

      expect((await proposed()).proposals.map((proposal) => proposal.kind)).toEqual([
        'leftover',
        'leftover',
      ]);
    });

    /** Set every meal of a plan to the recipe `recipeOf` names for its day and meal, as if the user had swapped them so. */
    const setMeals = async (
      of: MealPlan,
      recipeOf: (day: number, mealType: string) => string,
    ): Promise<void> => {
      for (const [day, { meals }] of of.days.entries()) {
        for (const meal of meals) {
          const recipe = await t.prisma.recipe.findUniqueOrThrow({
            where: { slug: recipeOf(day, meal.mealType) },
          });
          await t.prisma.plannedMeal.update({
            where: { id: meal.id },
            data: { recipeId: recipe.id, servings: 1, quantityScale: 1 },
          });
        }
      }
    };

    it('proposes no merge that would change more than two meals: that is no small thing to do for a list', async () => {
      // Every meal of three days is set: tofu could stand for the chicken of each lunch, and that is
      // a week's cooking changed. Any other merge there could be would change three meals as well.
      const longer = await aPlan(t, user, profile, { durationDays: 3 });
      await setMeals(
        longer,
        (_day, mealType) =>
          ({ breakfast: PORRIDGE, lunch: CHICKEN_RICE, dinner: TOFU_BOWL })[mealType]!,
      );
      const whole = await lists.generate(user.id, 'en', { planId: longer.id });

      const found = (await proposals.propose(user.id, 'en', whole.id, { weigh: false })).proposals;

      expect(found.filter((proposal) => proposal.kind === 'merge')).toEqual([]);
    });

    it('proposes a merge that would change two meals, the most it may', async () => {
      // The chicken dish on two of three days, and a lunch without chicken on the third.
      const longer = await aPlan(t, user, profile, { durationDays: 3 });
      await setMeals(
        longer,
        (day, mealType) =>
          ({ breakfast: PORRIDGE, lunch: day < 2 ? CHICKEN_RICE : STEW, dinner: TOFU_BOWL })[
            mealType
          ]!,
      );
      const whole = await lists.generate(user.id, 'en', { planId: longer.id });
      const idOf = async (slug: string): Promise<string> =>
        (await t.prisma.ingredient.findUniqueOrThrow({ where: { slug } })).id;
      const lunchOf = (day: number) =>
        longer.days[day]!.meals.find((meal) => meal.mealType === 'lunch')!;

      const found = (await proposals.propose(user.id, 'en', whole.id, { weigh: false })).proposals;

      expect(found.filter((proposal) => proposal.kind === 'merge')).toEqual([
        {
          kind: 'merge',
          from: { ingredientId: await idOf('chicken-breast'), name: 'Chicken breast' },
          to: { ingredientId: await idOf('firm-tofu'), name: 'Firm tofu' },
          meals: [0, 1].map((day) => ({
            plannedMealId: lunchOf(day).id,
            date: longer.days[day]!.date,
            mealType: 'lunch',
            title: 'Chicken rice broccoli',
          })),
          packsSaved: 1,
          reason: null,
        },
      ]);
    });

    it('proposes no merge of a row the pantry covers in part', async () => {
      await t.prisma.inventoryItem.create({
        data: {
          profileId: profile.id,
          ingredientId: rowOf('Chicken breast').ingredientId,
          quantity: 100,
          unit: 'g',
        },
      });
      await listOfTheDay();

      const found = (await proposed()).proposals;

      expect(found.filter((proposal) => proposal.kind === 'merge')).toEqual([]);
      // 50 g are left to buy: a pack of 500 g leaves nine tenths of itself.
      expect(
        found.find(
          (proposal) => proposal.kind === 'leftover' && proposal.name === 'Chicken breast',
        ),
      ).toMatchObject({ left: 450 });
    });

    it('says nothing of a row that is ticked: it is bought', async () => {
      await lists.updateItem(user.id, 'en', list.id, rowOf('Chicken breast').id, { checked: true });

      expect((await proposed()).proposals).toEqual([
        expect.objectContaining({ kind: 'leftover', name: 'Whole milk' }),
      ]);
    });

    it('says nothing of a pack that keeps, or of one that is used well enough', async () => {
      const names = (await proposed()).proposals.flatMap((proposal) =>
        proposal.kind === 'leftover' ? [proposal.name] : [],
      );

      // Rice comes by the kilogram and keeps; oats and broccoli are no packs here.
      expect(names).toEqual(['Whole milk', 'Chicken breast']);
    });

    it('names things in the language asked for', async () => {
      list = await lists.get(user.id, 'pl', list.id);

      const [merge, milk] = (await proposed(false, 'pl')).proposals;

      expect(merge).toMatchObject({
        from: { name: 'Pierś z kurczaka' },
        to: { name: 'Tofu twarde' },
        meals: [{ title: 'Chicken rice broccoli (pl)' }],
      });
      expect(milk).toMatchObject({ name: 'Mleko pełne' });
    });

    it('is nothing for a list with nothing left to buy', async () => {
      for (const row of list.groups.flatMap((group) => group.items))
        await lists.updateItem(user.id, 'en', list.id, row.id, { checked: true });

      expect(await proposed()).toEqual({ planId: plan.id, proposals: [], aiMeta: null });
    });
  });

  describe('as a model weighs it', () => {
    beforeEach(async () => {
      await t.prisma.user.update({ where: { id: user.id }, data: { aiMode: 'admin' } });
    });

    it('is put before the model under letters, in words, with the figures the engine counted', async () => {
      t.model.reply({ text: JSON.stringify({ order: ['a', 'b', 'c'] }) });

      await proposed(true);

      const { prompt } = t.model.requests[0]!;
      expect(prompt).toContain(
        `A shopping list for the days ${list.fromDate} to ${list.toDate} of a meal plan.`,
      );
      expect(prompt).toContain(
        '- id=a | use Firm tofu in place of Chicken breast in 1 meal(s): "Chicken rice broccoli" | the list then asks for 1 pack(s) fewer, and Chicken breast leaves it',
      );
      expect(prompt).toContain(
        '- id=b | Whole milk: the packs to buy leave 750 ml of a pack of 1000 ml, and an opened pack of it does not keep',
      );
      expect(prompt).not.toContain(list.id);
    });

    it("comes back in the model's order, with its sentence on each", async () => {
      t.model.reply({
        text: JSON.stringify({
          order: ['c', 'a'],
          reasons: {
            c: 'Freeze what is left of the chicken.',
            a: 'Tofu twice that day, and no chicken.',
          },
        }),
      });

      const { proposals: found, aiMeta } = await proposed(true);

      expect(found.map((proposal) => [proposal.kind, proposal.reason])).toEqual([
        ['leftover', 'Freeze what is left of the chicken.'],
        ['merge', 'Tofu twice that day, and no chicken.'],
        ['leftover', null],
      ]);
      expect(aiMeta).toMatchObject({ provider: 'ollama', usedDeterministicFallback: false });
      expect(
        (await t.prisma.aiUsageLog.findMany({ where: { userId: user.id } })).map(
          (call) => call.operation,
        ),
      ).toEqual(['list-proposals']);
    });

    it("stays in the engine's order when the model's answer cannot be used, and asks no model about nothing", async () => {
      t.model.reply({ text: 'Buy less.' });

      const { proposals: found, aiMeta } = await proposed(true);

      expect(found.map((proposal) => proposal.kind)).toEqual(['merge', 'leftover', 'leftover']);
      expect(aiMeta).toMatchObject({
        usedDeterministicFallback: true,
        fallbackReason: 'invalid_output',
      });

      for (const row of list.groups.flatMap((group) => group.items))
        await lists.updateItem(user.id, 'en', list.id, row.id, { checked: true });
      t.model.reset();
      expect((await proposed(true)).aiMeta).toBeNull();
      expect(t.model.requests).toHaveLength(0);
    });
  });

  it('is answered by the route, to the owner of the list alone', async () => {
    const answer = await t
      .http()
      .post(`/api/shopping-lists/${list.id}/proposals`)
      .set(as(user))
      .send({})
      .expect(200);
    expect(answer.body.proposals.map((proposal: { kind: string }) => proposal.kind)).toEqual([
      'merge',
      'leftover',
      'leftover',
    ]);

    const other = await aUser(t);
    await t
      .http()
      .post(`/api/shopping-lists/${list.id}/proposals`)
      .set(as(other))
      .send({})
      .expect(404);
    await t
      .http()
      .post(`/api/shopping-lists/${list.id}/proposals`)
      .set(as(user))
      .send({ weigh: 1 })
      .expect(400);
  });
});
