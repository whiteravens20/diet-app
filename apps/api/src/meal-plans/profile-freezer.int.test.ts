// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { dayAfter, type MealPlan, type Profile } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { freezerOf } from './generation-report.js';

/**
 * One freezer under every plan of a profile: what a plan takes out of it follows what the freezer holds, and a
 * package removed by hand leaves the plan that named it.
 */
describe('the freezer under the plans of a profile', () => {
  let t: TestApp;
  let user: TestUser;
  let profile: Profile;
  // The server's day, which a client may name as its own.
  const today = new Date().toISOString().slice(0, 10);

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

  const read = async (planId: string): Promise<MealPlan> =>
    (await t.http().get(`/api/meal-plans/${planId}`).set(as(user)).expect(200)).body as MealPlan;

  /**
   * A package of 150 g of chicken in the freezer, and a plan from tomorrow that keeps it to take out for the lunch of
   * its third day, the only meal with chicken, which eats it whole: the plan and the package's row.
   */
  const chickenOnTheThirdDay = async () => {
    const chicken = await t.prisma.ingredient.findFirstOrThrow({
      where: { slug: 'chicken-breast' },
    });
    const row = await t.prisma.inventoryItem.create({
      data: {
        profileId: profile.id,
        ingredientId: chicken.id,
        quantity: 150,
        unit: 'g',
        bestBefore: new Date(dayAfter(today, 30)),
        frozen: true,
      },
    });
    const plan = await aPlan(t, user, profile, {
      startDate: dayAfter(today, 1),
      durationDays: 3,
    });
    const [tofu, chickenRice] = await Promise.all(
      ['tofu-rice-bowl', 'chicken-rice-broccoli'].map((slug) =>
        t.prisma.recipe.findUniqueOrThrow({ where: { slug } }),
      ),
    );
    for (const [index, day] of plan.days.entries())
      for (const meal of day.meals)
        await t.prisma.plannedMeal.update({
          where: { id: meal.id },
          data: {
            recipeId: (index === 2 && meal.mealType === 'lunch' ? chickenRice! : tofu!).id,
            servings: 1,
            quantityScale: 1,
            source: 'CATALOGUE',
            leftoverFromDate: null,
            leftoverFromMealType: null,
            toppingKey: null,
            toppingAmount: null,
          },
        });
    // As a plan that eats the package whole keeps it.
    const kept = await t.prisma.mealPlan.findUniqueOrThrow({ where: { id: plan.id } });
    await t.prisma.mealPlan.update({
      where: { id: plan.id },
      data: {
        report: {
          ...(kept.report as object),
          freezer: {
            from: plan.days[0]!.date,
            stock: [{ ingredientId: chicken.id, amount: 150, parcel: row.parcel }],
          },
        },
      },
    });
    return { plan, row };
  };

  it('lets a plan go of a package removed from the freezer by hand before its day: the plan names it no more', async () => {
    const { plan, row } = await chickenOnTheThirdDay();
    expect((await read(plan.id)).packs.fromFreezer).toEqual([
      expect.objectContaining({ amount: 150, date: plan.days[2]!.date }),
    ]);

    await t
      .http()
      .delete(`/api/inventory/${row.id}`)
      .set(as(user))
      .set('X-Client-Date', today)
      .expect(204);

    expect((await read(plan.id)).packs.fromFreezer).toEqual([]);
    const report = (await t.prisma.mealPlan.findUniqueOrThrow({ where: { id: plan.id } })).report;
    expect(freezerOf(report)).toBeNull();
  });

  it('keeps a package changed by hand while the freezer still holds it', async () => {
    const { plan, row } = await chickenOnTheThirdDay();

    await t
      .http()
      .patch(`/api/inventory/${row.id}`)
      .set(as(user))
      .set('X-Client-Date', today)
      .send({ bestBefore: dayAfter(today, 20) })
      .expect(200);

    expect((await read(plan.id)).packs.fromFreezer).toEqual([
      expect.objectContaining({ amount: 150, date: plan.days[2]!.date }),
    ]);
  });
});
