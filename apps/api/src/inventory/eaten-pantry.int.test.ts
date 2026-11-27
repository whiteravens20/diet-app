// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { dayAfter, type EatenPantry, type MealPlan, type Profile } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

/**
 * What eating takes off the pantry on a day no shopping list covers: a meal marked eaten and an entry of the diary of
 * an ingredient or a recipe offer it, and take it once, only when the user confirms; giving it back undoes it.
 */
describe('what eating takes off the pantry', () => {
  let t: TestApp;
  let user: TestUser;
  let profile: Profile;
  let chickenId: string;
  let tofuId: string;
  // The server's day, which a client may name as its own.
  const today = new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
    [chickenId, tofuId] = await Promise.all(
      ['chicken-breast', 'firm-tofu'].map(
        async (slug) => (await t.prisma.ingredient.findFirstOrThrow({ where: { slug } })).id,
      ),
    );
  });

  beforeEach(async () => {
    await resetUserData(t.prisma);
    user = await aUser(t);
    profile = await aProfile(t, user);
  });

  afterAll(async () => {
    await t.close();
  });

  /** A plan of `days` days from `start` whose lunch every day is chicken, every other meal tofu, a serving each. */
  const chickenLunches = async (start: string, days: number, mealPrepFriendly = false) => {
    const plan = await aPlan(t, user, profile, {
      startDate: start,
      durationDays: days,
      mealPrepFriendly,
    });
    const [tofu, chickenRice] = await Promise.all(
      ['tofu-rice-bowl', 'chicken-rice-broccoli'].map((slug) =>
        t.prisma.recipe.findUniqueOrThrow({ where: { slug } }),
      ),
    );
    for (const day of plan.days)
      for (const meal of day.meals)
        await t.prisma.plannedMeal.update({
          where: { id: meal.id },
          data: {
            recipeId: (meal.mealType === 'lunch' ? chickenRice! : tofu!).id,
            servings: 1,
            quantityScale: 1,
            cookedServings: null,
            source: 'CATALOGUE',
            leftoverFromDate: null,
            leftoverFromMealType: null,
            toppingKey: null,
            toppingAmount: null,
            eatenAt: null,
          },
        });
    return plan;
  };
  /** Fresh stock, or a package of the freezer, of a food, good for `keeps` days. */
  const stock = (ingredientId: string, quantity: number, frozen = false, keeps = 10) =>
    t.prisma.inventoryItem.create({
      data: {
        profileId: profile.id,
        ingredientId,
        quantity,
        unit: 'g',
        frozen,
        bestBefore: new Date(dayAfter(today, keeps)),
      },
    });
  /** What the pantry holds of a food, in grams: fresh, or in the freezer. */
  const held = async (ingredientId: string, frozen = false) =>
    (
      await t.prisma.inventoryItem.aggregate({
        where: { profileId: profile.id, ingredientId, frozen },
        _sum: { quantity: true },
      })
    )._sum.quantity ?? 0;
  /** What a meal of the plan eats of a food as it stands, in grams. */
  const eatenOf = async (mealId: string, ingredientId: string) => {
    const meal = await t.prisma.plannedMeal.findUniqueOrThrow({
      where: { id: mealId },
      include: { recipe: { include: { ingredients: true } } },
    });
    const line = meal.recipe!.ingredients.find((one) => one.ingredientId === ingredientId);
    return line
      ? (line.quantity * (meal.cookedServings ?? meal.servings * meal.quantityScale)) /
          meal.recipe!.servings
      : 0;
  };
  const mark = (plan: MealPlan, mealId: string, eaten: boolean) =>
    t
      .http()
      .patch(`/api/meal-plans/${plan.id}/meals/${mealId}/eaten`)
      .set(as(user))
      .set('X-Client-Date', today)
      .send({ eaten })
      .expect(200);
  /** The meal's pantry: asked (`get`), taken or given back. */
  const pantry = async (
    path: string,
    act: 'get' | 'take' | 'return' = 'get',
  ): Promise<EatenPantry> =>
    (act === 'get'
      ? await t.http().get(`${path}/pantry`).set(as(user)).set('X-Client-Date', today).expect(200)
      : await t
          .http()
          .post(`${path}/pantry-${act}`)
          .set(as(user))
          .set('X-Client-Date', today)
          .expect(200)
    ).body as EatenPantry;
  const ofMeal = (plan: MealPlan, mealId: string) => `/api/meal-plans/${plan.id}/meals/${mealId}`;
  /** Of each food, the grams a line takes (or took), as it shows them. */
  const amounts = (lines: EatenPantry['offer']) =>
    Object.fromEntries(lines.map((line) => [line.ingredientId, grams(line.taken)]));
  const grams = (shown: EatenPantry['offer'][number]['taken']) => {
    expect(shown.unit).toBe('g');
    return shown.quantity;
  };

  it('offers what each meal of a day ate, takes it once when confirmed, and not again when the mark is taken back and set again', async () => {
    const plan = await chickenLunches(today, 1);
    await stock(chickenId, 1000);
    await stock(tofuId, 1000);
    const meals = plan.days[0]!.meals;
    const lunch = meals.find((meal) => meal.mealType === 'lunch')!;

    // Lunch first, so that sizing the day after the other marks moves no portion it is counted at.
    let chicken = 1000;
    let tofu = 1000;
    for (const meal of [lunch, ...meals.filter((one) => one.id !== lunch.id)]) {
      await mark(plan, meal.id, true);
      const [ofChicken, ofTofu] = await Promise.all([
        eatenOf(meal.id, chickenId),
        eatenOf(meal.id, tofuId),
      ]);
      const offered = await pantry(ofMeal(plan, meal.id));
      // It names what it would take, what was eaten and what the pantry holds, of the foods the pantry holds alone.
      expect(offered.taken).toEqual([]);
      expect(
        Object.fromEntries(
          offered.offer.map((line) => [
            line.ingredientId,
            [grams(line.eaten), grams(line.held), grams(line.taken)],
          ]),
        ),
      ).toEqual({
        ...(ofChicken > 0
          ? { [chickenId]: [Math.round(ofChicken), Math.round(chicken), Math.round(ofChicken)] }
          : {}),
        ...(ofTofu > 0
          ? { [tofuId]: [Math.round(ofTofu), Math.round(tofu), Math.round(ofTofu)] }
          : {}),
      });
      // Nothing is taken until it is confirmed.
      expect([await held(chickenId), await held(tofuId)]).toEqual([chicken, tofu]);

      const took = await pantry(ofMeal(plan, meal.id), 'take');
      // What is shown is what is taken: grams whole.
      chicken -= Math.round(ofChicken);
      tofu -= Math.round(ofTofu);
      expect(took.offer).toEqual([]);
      expect(amounts(took.taken)).toEqual(amounts(offered.offer));
      expect([await held(chickenId), await held(tofuId)]).toEqual([chicken, tofu]);
    }

    // The mark taken back takes nothing back by itself: it offers to give back what was taken.
    const lunchChicken = await eatenOf(lunch.id, chickenId);
    await mark(plan, lunch.id, false);
    const unmarked = await pantry(ofMeal(plan, lunch.id));
    expect(unmarked.offer).toEqual([]);
    expect(amounts(unmarked.taken)).toEqual({ [chickenId]: Math.round(lunchChicken) });
    expect(await held(chickenId)).toBe(chicken);

    // Marked again, it takes nothing a second time while the food has not come back.
    await mark(plan, lunch.id, true);
    expect((await pantry(ofMeal(plan, lunch.id))).offer).toEqual([]);
    await pantry(ofMeal(plan, lunch.id), 'take');
    expect(await held(chickenId)).toBe(chicken);

    // Given back, the pantry holds it again, and the meal, still eaten, offers it anew.
    const back = await pantry(ofMeal(plan, lunch.id), 'return');
    expect(back.taken).toEqual([]);
    expect(amounts(back.offer)).toEqual({ [chickenId]: Math.round(lunchChicken) });
    expect(await held(chickenId)).toBe(chicken + Math.round(lunchChicken));
  });

  it('offers nothing on a day a shopping list covers: the list is the pantry’s ledger there', async () => {
    const plan = await chickenLunches(today, 1);
    await stock(chickenId, 1000);
    await t
      .http()
      .post('/api/shopping-lists/generate')
      .set(as(user))
      .set('X-Client-Date', today)
      .send({ planId: plan.id, fromDate: today, toDate: today })
      .expect(201);
    const lunch = plan.days[0]!.meals.find((meal) => meal.mealType === 'lunch')!;
    await mark(plan, lunch.id, true);
    const before = await held(chickenId);

    expect(await pantry(ofMeal(plan, lunch.id))).toEqual({
      profileName: profile.name,
      offer: [],
      taken: [],
    });
    await pantry(ofMeal(plan, lunch.id), 'take');
    expect(await held(chickenId)).toBe(before);
  });

  it('takes the whole pot at the meal that cooks it ahead, and nothing at a meal eaten from it', async () => {
    // Yesterday's lunch cooks today's with it.
    const plan = await chickenLunches(dayAfter(today, -1), 2, true);
    await stock(chickenId, 1000);
    const [cooks, fromPot] = plan.days.map((day) =>
      day.meals.find((meal) => meal.mealType === 'lunch')!,
    );
    const pot = (await eatenOf(cooks!.id, chickenId)) + (await eatenOf(fromPot!.id, chickenId));

    await mark(plan, cooks!.id, true);
    const offered = await pantry(ofMeal(plan, cooks!.id));
    expect(amounts(offered.offer)[chickenId]).toBe(Math.round(pot));
    await pantry(ofMeal(plan, cooks!.id), 'take');
    expect(await held(chickenId)).toBe(1000 - Math.round(pot));

    await mark(plan, fromPot!.id, true);
    expect(amounts((await pantry(ofMeal(plan, fromPot!.id))).offer)[chickenId]).toBeUndefined();
  });

  it('takes nothing out of the freezer: it offers fresh stock alone, and takes no more of it', async () => {
    const plan = await chickenLunches(today, 1);
    // Tofu, which no plan takes out of the freezer by its packages, whose package goes off before the fresh stock.
    await stock(tofuId, 40);
    await stock(tofuId, 1000, true, 3);
    const breakfast = plan.days[0]!.meals.find((meal) => meal.mealType !== 'lunch')!;
    await mark(plan, breakfast.id, true);

    const offered = await pantry(ofMeal(plan, breakfast.id));
    expect(offered.offer.find((line) => line.ingredientId === tofuId)).toMatchObject({
      held: { quantity: 40, unit: 'g' },
      taken: { quantity: 40, unit: 'g' },
    });
    await pantry(ofMeal(plan, breakfast.id), 'take');
    expect([await held(tofuId), await held(tofuId, true)]).toEqual([0, 1000]);
  });

  it('takes once when it is confirmed twice at the same moment', async () => {
    const plan = await chickenLunches(today, 1);
    await stock(chickenId, 1000);
    const lunch = plan.days[0]!.meals.find((meal) => meal.mealType === 'lunch')!;
    await mark(plan, lunch.id, true);
    const entry = (
      await t
        .http()
        .post('/api/diary/entries')
        .set(as(user))
        .set('X-Client-Date', today)
        .send({
          profileId: profile.id,
          date: today,
          mealType: 'dinner',
          kind: 'ingredient',
          ingredientId: chickenId,
          amount: { quantity: 100, unit: 'g' },
        })
        .expect(201)
    ).body as { id: string };
    const lunchChicken = await eatenOf(lunch.id, chickenId);

    await Promise.all([
      pantry(ofMeal(plan, lunch.id), 'take'),
      pantry(ofMeal(plan, lunch.id), 'take'),
      pantry(`/api/diary/entries/${entry.id}`, 'take'),
      pantry(`/api/diary/entries/${entry.id}`, 'take'),
    ]);

    expect(await held(chickenId)).toBe(1000 - Math.round(lunchChicken) - 100);
  });

  it('offers what an entry of an ingredient or of a recipe ate, and nothing for one of a meal of one’s own', async () => {
    await stock(chickenId, 1000);
    const write = async (body: object) =>
      (
        await t
          .http()
          .post('/api/diary/entries')
          .set(as(user))
          .set('X-Client-Date', today)
          .send({ profileId: profile.id, date: today, mealType: 'lunch', ...body })
          .expect(201)
      ).body as { id: string };
    const ofEntry = (id: string) => `/api/diary/entries/${id}`;

    const ingredient = await write({
      kind: 'ingredient',
      ingredientId: chickenId,
      amount: { quantity: 150, unit: 'g' },
    });
    const offered = await pantry(ofEntry(ingredient.id));
    expect(offered.offer).toEqual([
      expect.objectContaining({
        ingredientId: chickenId,
        eaten: { quantity: 150, unit: 'g' },
        held: { quantity: 1000, unit: 'g' },
        taken: { quantity: 150, unit: 'g' },
      }),
    ]);
    await pantry(ofEntry(ingredient.id), 'take');
    await pantry(ofEntry(ingredient.id), 'take');
    expect(await held(chickenId)).toBe(850);
    // The entry says so, for its removal to offer to give it back.
    const entries = (
      await t
        .http()
        .get(`/api/diary/day?profileId=${profile.id}&date=${today}`)
        .set(as(user))
        .set('X-Client-Date', today)
        .expect(200)
    ).body as { entries: { id: string; takenFromPantry: boolean }[] };
    expect(entries.entries.find((entry) => entry.id === ingredient.id)?.takenFromPantry).toBe(true);

    const chickenRice = await t.prisma.recipe.findUniqueOrThrow({
      where: { slug: 'chicken-rice-broccoli' },
      include: { ingredients: true },
    });
    const line = chickenRice.ingredients.find((one) => one.ingredientId === chickenId)!;
    const recipe = await write({ kind: 'recipe', recipeId: chickenRice.id, servings: 2 });
    expect(amounts((await pantry(ofEntry(recipe.id))).offer)).toEqual({
      [chickenId]: Math.round((2 * line.quantity) / chickenRice.servings),
    });

    const own = await write({
      kind: 'meal',
      name: 'Kanapka',
      nutrition: { calories: 300, protein: 12, fat: 10, carbs: 40 },
    });
    expect(await pantry(ofEntry(own.id))).toEqual({
      profileName: profile.name,
      offer: [],
      taken: [],
    });

    // Given back, the ingredient's entry returns its chicken.
    await pantry(ofEntry(ingredient.id), 'return');
    expect(await held(chickenId)).toBe(1000);
  });

  it('shows and takes what is counted in its pieces, as the pantry keeps it', async () => {
    const eggId = (await t.prisma.ingredient.findFirstOrThrow({ where: { slug: 'large-egg' } })).id;
    await t.prisma.inventoryItem.create({
      data: {
        profileId: profile.id,
        ingredientId: eggId,
        quantity: 6,
        unit: 'piece',
        bestBefore: new Date(dayAfter(today, 10)),
      },
    });
    const entry = (
      await t
        .http()
        .post('/api/diary/entries')
        .set(as(user))
        .set('X-Client-Date', today)
        .send({
          profileId: profile.id,
          date: today,
          mealType: 'breakfast',
          kind: 'ingredient',
          ingredientId: eggId,
          amount: { quantity: 2, unit: 'piece' },
        })
        .expect(201)
    ).body as { id: string };
    const ofEntry = `/api/diary/entries/${entry.id}`;

    expect((await pantry(ofEntry)).offer).toEqual([
      expect.objectContaining({
        ingredientId: eggId,
        eaten: { quantity: 2, unit: 'piece', grams: 110 },
        held: { quantity: 6, unit: 'piece', grams: 330 },
        taken: { quantity: 2, unit: 'piece', grams: 110 },
      }),
    ]);
    const took = await pantry(ofEntry, 'take');
    expect(took.taken).toEqual([
      expect.objectContaining({ held: { quantity: 4, unit: 'piece', grams: 220 } }),
    ]);
    const rows = await t.prisma.inventoryItem.findMany({
      where: { profileId: profile.id, ingredientId: eggId },
    });
    expect(rows.map((row) => [row.quantity, row.unit])).toEqual([[4, 'piece']]);

    // A part of a piece is said as it is taken, by the half: 70 g of egg is a piece and a half, 83 g, in both.
    const part = (
      await t
        .http()
        .post('/api/diary/entries')
        .set(as(user))
        .set('X-Client-Date', today)
        .send({
          profileId: profile.id,
          date: today,
          mealType: 'lunch',
          kind: 'ingredient',
          ingredientId: eggId,
          amount: { quantity: 70, unit: 'g' },
        })
        .expect(201)
    ).body as { id: string };
    expect((await pantry(`/api/diary/entries/${part.id}`)).offer).toEqual([
      expect.objectContaining({
        eaten: { quantity: 1.5, unit: 'piece', grams: 83 },
        taken: { quantity: 1.5, unit: 'piece', grams: 83 },
      }),
    ]);
  });

  it('goes with a meal eaten into the diary when its plan is removed, and is given back from the entry', async () => {
    const plan = await chickenLunches(today, 1);
    await stock(chickenId, 1000);
    const lunch = plan.days[0]!.meals.find((meal) => meal.mealType === 'lunch')!;
    await mark(plan, lunch.id, true);
    await pantry(ofMeal(plan, lunch.id), 'take');
    const lunchChicken = await eatenOf(lunch.id, chickenId);

    await t
      .http()
      .delete(`/api/meal-plans/${plan.id}`)
      .set(as(user))
      .set('X-Client-Date', today)
      .expect(204);
    const day = (
      await t
        .http()
        .get(`/api/diary/day?profileId=${profile.id}&date=${today}`)
        .set(as(user))
        .set('X-Client-Date', today)
        .expect(200)
    ).body as { entries: { id: string; mealType: string; takenFromPantry: boolean }[] };
    const kept = day.entries.find((entry) => entry.mealType === 'lunch')!;

    // The entry says it took food, offers nothing more, and gives back what the meal took.
    expect(kept.takenFromPantry).toBe(true);
    const ofKept = `/api/diary/entries/${kept.id}`;
    expect((await pantry(ofKept)).offer).toEqual([]);
    await pantry(ofKept, 'return');
    expect(await held(chickenId)).toBe(1000);
    expect(lunchChicken).toBeGreaterThan(0);
  });

  it('answers a meal or an entry of another account as one that is not there', async () => {
    const plan = await chickenLunches(today, 1);
    await stock(chickenId, 1000);
    const lunch = plan.days[0]!.meals.find((meal) => meal.mealType === 'lunch')!;
    await mark(plan, lunch.id, true);
    const entry = (
      await t
        .http()
        .post('/api/diary/entries')
        .set(as(user))
        .set('X-Client-Date', today)
        .send({
          profileId: profile.id,
          date: today,
          mealType: 'dinner',
          kind: 'ingredient',
          ingredientId: chickenId,
          amount: { quantity: 100, unit: 'g' },
        })
        .expect(201)
    ).body as { id: string };
    const stranger = await aUser(t);

    for (const path of [ofMeal(plan, lunch.id), `/api/diary/entries/${entry.id}`])
      for (const [method, route] of [
        ['get', 'pantry'],
        ['post', 'pantry-take'],
        ['post', 'pantry-return'],
      ] as const)
        await t.http()[method](`${path}/${route}`).set(as(stranger)).expect(404);
    expect(await held(chickenId)).toBe(1000);
  });
});
