// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { dayAfter, type Profile, type ShoppingList } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { othersTake, type OwnPlans } from '../shopping-lists/shopping-lists.service.js';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

/**
 * One pantry under every plan of a profile: a plan made or made again counts it less what the profile's other plans
 * still take of it, what their lists count on and the days no list covers, and nothing a list took already.
 */
describe('the pantry under the plans of a profile', () => {
  let t: TestApp;
  let user: TestUser;
  let profile: Profile;
  let chickenId: string;
  // The server's day, which a client may name as its own.
  const today = new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
    chickenId = (await t.prisma.ingredient.findFirstOrThrow({ where: { slug: 'chicken-breast' } }))
      .id;
  });

  beforeEach(async () => {
    await resetUserData(t.prisma);
    user = await aUser(t);
    profile = await aProfile(t, user);
  });

  afterAll(async () => {
    await t.close();
  });

  /** A plan of three days from tomorrow whose lunch every day is chicken, every other meal tofu. */
  const chickenLunches = async () => {
    const plan = await aPlan(t, user, profile, { startDate: dayAfter(today, 1), durationDays: 3 });
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
            source: 'CATALOGUE',
            leftoverFromDate: null,
            leftoverFromMealType: null,
            toppingKey: null,
            toppingAmount: null,
          },
        });
    return plan;
  };
  const NONE: OwnPlans = { planIds: [], jointPlanId: null };
  /** What the profile's plans other than `self` take of its chicken, in grams. */
  const take = async (self: OwnPlans = NONE) =>
    (await othersTake(t.prisma, [profile.id], [chickenId], today, self)).get(chickenId) ?? 0;

  it('counts what another plan eats of a food on the days no list of it covers', async () => {
    const plan = await chickenLunches();

    const all = await take();

    // Three lunches of chicken, from tomorrow on.
    expect(all).toBeGreaterThan(0);
    const oneLunch = await t.prisma.plannedMeal.findFirstOrThrow({
      where: { day: { planId: plan.id }, mealType: 'lunch' },
      include: { recipe: { include: { ingredients: true } } },
    });
    const line = oneLunch.recipe!.ingredients.find((one) => one.ingredientId === chickenId)!;
    expect(all).toBeCloseTo((3 * line.quantity) / oneLunch.recipe!.servings, 0);
  });

  it('counts of the days a list covers what the list counts on at home, and nothing the list took already', async () => {
    const plan = await chickenLunches();
    const all = await take();
    const lunch = all / 3;
    // Part of the first day's chicken at home, fresh: the list counts on it and buys the rest. (With all of it at
    // home the row would have nothing to buy, be ticked as it is made, and take the chicken out at once.)
    const atHome = lunch - 50;
    await t.prisma.inventoryItem.create({
      data: {
        profileId: profile.id,
        ingredientId: chickenId,
        quantity: atHome,
        unit: 'g',
        bestBefore: new Date(dayAfter(today, 10)),
      },
    });
    const list = (
      await t
        .http()
        .post('/api/shopping-lists/generate')
        .set(as(user))
        .set('X-Client-Date', today)
        .send({ planId: plan.id, fromDate: plan.days[0]!.date, toDate: plan.days[0]!.date })
        .expect(201)
    ).body as ShoppingList;
    const row = list.groups
      .flatMap((group) => group.items)
      .find((item) => item.ingredientId === chickenId)!;
    // The list counts on the chicken at home for the first day; the other two days are counted as the menu eats them.
    expect({
      atHome: row.alreadyHaveQuantity,
      ticked: row.checked,
      take: Math.round(await take()),
    }).toEqual({ atHome, ticked: false, take: Math.round(atHome + 2 * lunch) });

    await t
      .http()
      .patch(`/api/shopping-lists/${list.id}/items/${row.id}`)
      .set(as(user))
      .set('X-Client-Date', today)
      .send({ checked: true })
      .expect(200);

    // Ticked, the list took it out of the pantry: what is left to take is what the two days no list covers eat.
    expect(await take()).toBeCloseTo(2 * lunch, 0);
  });

  it('leaves out what the plan made again takes: it counts the pantry for itself', async () => {
    const plan = await chickenLunches();

    expect(await take({ planIds: [plan.id], jointPlanId: null })).toBe(0);
  });
});
