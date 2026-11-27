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

  /** A package of 150 g of chicken in the freezer: its row. */
  const aPackage = async () =>
    t.prisma.inventoryItem.create({
      data: {
        profileId: profile.id,
        ingredientId: (
          await t.prisma.ingredient.findFirstOrThrow({ where: { slug: 'chicken-breast' } })
        ).id,
        quantity: 150,
        unit: 'g',
        bestBefore: new Date(dayAfter(today, 30)),
        frozen: true,
        // Each its own package, numbered as the freezer numbers them.
        parcel:
          (await t.prisma.inventoryItem.count({ where: { profileId: profile.id, frozen: true } })) +
          1,
      },
    });

  /**
   * A plan of three days from `from` whose lunch on the days at `chickenOn` is chicken, 150 g, every other meal tofu,
   * and that keeps `packages` to take out for them, as a plan made with them in the freezer would.
   */
  const aPlanTaking = async (
    from: string,
    chickenOn: readonly number[],
    packages: readonly { parcel: number }[],
  ) => {
    const plan = await aPlan(t, user, profile, { startDate: from, durationDays: 3 });
    const [tofu, chickenRice, chicken] = await Promise.all([
      t.prisma.recipe.findUniqueOrThrow({ where: { slug: 'tofu-rice-bowl' } }),
      t.prisma.recipe.findUniqueOrThrow({ where: { slug: 'chicken-rice-broccoli' } }),
      t.prisma.ingredient.findFirstOrThrow({ where: { slug: 'chicken-breast' } }),
    ]);
    for (const [index, day] of plan.days.entries())
      for (const meal of day.meals)
        await t.prisma.plannedMeal.update({
          where: { id: meal.id },
          data: {
            recipeId: (chickenOn.includes(index) && meal.mealType === 'lunch' ? chickenRice : tofu)
              .id,
            servings: 1,
            quantityScale: 1,
            source: 'CATALOGUE',
            leftoverFromDate: null,
            leftoverFromMealType: null,
            toppingKey: null,
            toppingAmount: null,
          },
        });
    const kept = await t.prisma.mealPlan.findUniqueOrThrow({ where: { id: plan.id } });
    await t.prisma.mealPlan.update({
      where: { id: plan.id },
      data: {
        report: {
          ...(kept.report as object),
          freezer: {
            from: plan.days[0]!.date,
            stock: packages.map((one) => ({
              ingredientId: chicken.id,
              amount: 150,
              parcel: one.parcel,
            })),
          },
        },
      },
    });
    return plan;
  };
  /** A change of a package by hand, which makes the plans of the profile choose their packages again. */
  const touch = (row: { id: string }) =>
    t
      .http()
      .patch(`/api/inventory/${row.id}`)
      .set(as(user))
      .set('X-Client-Date', today)
      .send({ bestBefore: dayAfter(today, 25) })
      .expect(200);
  const fromFreezer = async (planId: string) =>
    (await read(planId)).packs.fromFreezer.map((one) => one.date).sort();

  it('names each package once over two plans: the plan that eats it first keeps it, the other buys fresh', async () => {
    const packages = [await aPackage(), await aPackage()];
    const first = await aPlanTaking(dayAfter(today, 1), [1, 2], packages);
    const second = await aPlanTaking(dayAfter(today, 8), [1, 2], packages);
    // As the walk found them: both plans name both packages.
    expect(await fromFreezer(second.id)).toHaveLength(2);

    await touch(packages[0]!);

    expect(await fromFreezer(first.id)).toEqual([first.days[1]!.date, first.days[2]!.date]);
    expect(await fromFreezer(second.id)).toEqual([]);
  });

  it('gives a package two plans want to the one that eats it on the earlier day, though it was made later', async () => {
    const chicken = await aPackage();
    const older = await aPlanTaking(dayAfter(today, 5), [1], [chicken]);
    const newer = await aPlanTaking(dayAfter(today, 1), [1], [chicken]);

    await touch(chicken);

    expect(await fromFreezer(newer.id)).toEqual([newer.days[1]!.date]);
    expect(await fromFreezer(older.id)).toEqual([]);
  });

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
