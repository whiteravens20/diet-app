// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { MealPlan, Profile } from '@diet-app/shared';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { restsOf } from './plan-days.js';
import { PlanGenerationService } from './plan-generation.service.js';
import { followRests, RestsFollowOnStart } from './rests-follow.js';

/** 200 g of Greek yogurt a serving, from a pack of 400 g that keeps a week once opened. */
const YOGURT = 'yogurt-with-banana';
/** Neither takes from a pack that does not keep. */
const TOFU_BOWL = 'tofu-rice-bowl';
const STEW = 'chickpea-tomato-stew';
/** Before every plan of these tests: each of their meals is still to be eaten. */
const BEFORE = '2026-01-01';

describe('the rest of a pack a meal finishes, as the plan changes', () => {
  let t: TestApp;
  let user: TestUser;
  let profile: Profile;
  let yogurtId: string;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
    t.app.get(PlanGenerationService).nextSeed = () => 7;
    yogurtId = (await t.prisma.ingredient.findUniqueOrThrow({ where: { slug: 'greek-yogurt' } }))
      .id;
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await resetUserData(t.prisma);
    user = await aUser(t);
    profile = await aProfile(t, user);
  });

  const follow = (planId: string) => t.prisma.$transaction((tx) => followRests(tx, planId, BEFORE));
  const restsOfPlan = async (planId: string) =>
    (
      await t.prisma.plannedMeal.findMany({
        where: { day: { planId } },
        select: { id: true, rests: true },
      })
    ).flatMap((meal) => restsOf(meal.rests).map((rest) => ({ meal: meal.id, ...rest })));

  it('come out as the plan was made with them, for every kind of plan that counts its packs', async () => {
    let rests = 0;
    for (const startDate of ['2026-02-02', '2026-03-02', '2026-04-06'])
      for (const options of [
        { lessWaste: true },
        { noWaste: true },
        { lessWaste: true, mealPrepFriendly: true },
      ]) {
        const made = await aPlan(t, user, profile, { startDate, durationDays: 7, ...options });
        rests += (await restsOfPlan(made.id)).length;

        expect(await follow(made.id), `${startDate} ${JSON.stringify(options)}`).toEqual([]);
      }
    // A plan made together: its kitchen's rests, on both plans.
    const ewa = await aProfile(t, user, {
      name: 'Ewa',
      sex: 'female',
      heightCm: 165,
      weightKg: 60,
    });
    const joint = await aPlan(t, user, ewa, {
      startDate: '2026-05-04',
      durationDays: 7,
      withProfileId: profile.id,
      lessWaste: true,
    });
    rests += (await restsOfPlan(joint.id)).length + (await restsOfPlan(joint.joint!.planId)).length;
    expect(await follow(joint.id)).toEqual([]);
    expect(await follow(joint.joint!.planId)).toEqual([]);
    // The catalogue of the tests gives the planner rests to put in: what is checked is there.
    expect(rests).toBeGreaterThan(0);
  });

  it("of a dish both people of a joint plan eat is the pot's, each portion its share", async () => {
    const [{ id: stew }, { id: yogurt }] = await Promise.all(
      [STEW, YOGURT].map((slug) => t.prisma.recipe.findUniqueOrThrow({ where: { slug } })),
    );
    const ewa = await aProfile(t, user, {
      name: 'Ewa',
      sex: 'female',
      heightCm: 165,
      weightKg: 60,
    });
    const mine = await aPlan(t, user, profile, {
      startDate: '2026-02-02',
      durationDays: 1,
      withProfileId: ewa.id,
      lessWaste: true,
    });
    const both = await t.prisma.plannedMeal.findMany({
      where: { day: { planId: { in: [mine.id, mine.joint!.planId] } } },
      select: { id: true, sharedMealId: true, day: { select: { planId: true } } },
    });
    const pairs = new Map<string, string[]>();
    for (const meal of both)
      if (meal.sharedMealId)
        pairs.set(meal.sharedMealId, [...(pairs.get(meal.sharedMealId) ?? []), meal.id]);
    const [pair] = [...pairs.values()].filter((ids) => ids.length === 2);
    expect(pair).toBeDefined();
    const ownMeal = both.find((meal) => pair!.includes(meal.id) && meal.day.planId === mine.id)!.id;
    const partnerMeal = pair!.find((id) => id !== ownMeal)!;
    for (const meal of both)
      await t.prisma.plannedMeal.update({
        where: { id: meal.id },
        data: {
          recipeId: meal.id === ownMeal || meal.id === partnerMeal ? yogurt : stew,
          servings: meal.id === partnerMeal ? 0.75 : 1,
          quantityScale: 1,
          source: 'CATALOGUE',
          eatenAt: null,
          plate: Prisma.DbNull,
          toppingKey: null,
          toppingAmount: null,
          rests: [],
        },
      });

    await follow(mine.id);

    // 200 g and 150 g of a pack of 400 g: the 50 g left go into the pot, each portion its share of them.
    const restOf = async (mealId: string) =>
      restsOf(
        (
          await t.prisma.plannedMeal.findUniqueOrThrow({
            where: { id: mealId },
            select: { rests: true },
          })
        ).rests,
      )
        .filter((rest) => rest.ingredientId === yogurtId)
        .reduce((sum, rest) => sum + rest.amount, 0);
    expect(await restOf(ownMeal)).toBeCloseTo((50 * 200) / 350, 0);
    expect(await restOf(partnerMeal)).toBeCloseTo((50 * 150) / 350, 0);
  });

  describe('of a pack taken from already', () => {
    /** A plan from the 2nd of February, every meal of it the stew, which takes from no pack that does not keep. */
    const stewed = async (options: {
      durationDays: number;
      lessWaste?: boolean;
      noWaste?: boolean;
    }) => {
      const { id: stew } = await t.prisma.recipe.findUniqueOrThrow({ where: { slug: STEW } });
      const made = await aPlan(t, user, profile, { startDate: '2026-02-02', ...options });
      await t.prisma.plannedMeal.updateMany({
        where: { day: { planId: made.id } },
        data: {
          recipeId: stew,
          servings: 1,
          quantityScale: 1,
          source: 'CATALOGUE',
          eatenAt: null,
          plate: Prisma.DbNull,
          toppingKey: null,
          toppingAmount: null,
          rests: [],
        },
      });
      return made;
    };
    const yogurtOf = async (mealId: string): Promise<number> =>
      restsOf(
        (
          await t.prisma.plannedMeal.findUniqueOrThrow({
            where: { id: mealId },
            select: { rests: true },
          })
        ).rests,
      )
        .filter((rest) => rest.ingredientId === yogurtId)
        .reduce((sum, rest) => sum + rest.amount, 0);

    it('counts what a leftover took of it on the day its dish was cooked', async () => {
      const { id: yogurt } = await t.prisma.recipe.findUniqueOrThrow({ where: { slug: YOGURT } });
      const made = await stewed({ durationDays: 2, lessWaste: true });
      const [first, second] = made.days;
      // A serving cooked on the first day and left to the second (200 g of the pack), and 1.85 servings (370 g) after it.
      await t.prisma.plannedMeal.update({
        where: { id: second!.meals[0]!.id },
        data: {
          recipeId: yogurt,
          leftoverFromDate: new Date(first!.date),
          leftoverFromMealType: first!.meals[1]!.mealType,
        },
      });
      const after = second!.meals[1]!.id;
      await t.prisma.plannedMeal.update({
        where: { id: after },
        data: { recipeId: yogurt, servings: 1.85 },
      });

      await follow(made.id);

      // 570 g take a second pack, which leaves 230 g: far more than a rest. Without the leftover, 30 g would be left.
      expect(await yogurtOf(after)).toBe(0);
      const left = (await t.http().get(`/api/meal-plans/${made.id}`).set(as(user)).expect(200))
        .body as MealPlan;
      expect(left.packs.open.find((pack) => pack.ingredientId === yogurtId)?.left).toBe(230);
    });

    it('counts the rest a meal eaten took of it, once a meal after it takes from the pack', async () => {
      const { id: yogurt } = await t.prisma.recipe.findUniqueOrThrow({ where: { slug: YOGURT } });
      const made = await stewed({ durationDays: 1, noWaste: true });
      const meals = made.days[0]!.meals;
      const eaten = meals[1]!.id;
      const later = meals[meals.length - 1]!.id;
      // 1.7 servings take 340 g of a pack of 400 g: the 60 g left go with the meal, and it is eaten.
      await t.prisma.plannedMeal.update({
        where: { id: eaten },
        data: { recipeId: yogurt, servings: 1.7 },
      });
      await follow(made.id);
      expect(await yogurtOf(eaten)).toBeCloseTo(60);
      await t.prisma.plannedMeal.update({
        where: { id: eaten },
        data: { eatenAt: new Date('2026-02-02T10:00:00Z') },
      });

      // 1.95 servings later (390 g): 790 g in all, which leave 10 g of a second pack, too little for a rest. Without
      // the 60 g eaten, the 70 g of the first pack would be given again.
      await t.prisma.plannedMeal.update({
        where: { id: later },
        data: { recipeId: yogurt, servings: 1.95 },
      });
      await follow(made.id);

      expect(await yogurtOf(eaten)).toBeCloseTo(60);
      expect(await yogurtOf(later)).toBe(0);
    });
  });

  describe('of a plan still ahead', () => {
    let plan: MealPlan;
    let yogurtMeal: string;
    /** The day after the server's: still to come whatever day the tests run, and a day a client may name its own. */
    const ahead = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

    beforeEach(async () => {
      const [{ id: stew }, { id: yogurt }] = await Promise.all(
        [STEW, YOGURT].map((slug) => t.prisma.recipe.findUniqueOrThrow({ where: { slug } })),
      );
      plan = await aPlan(t, user, profile, { startDate: ahead, durationDays: 1, lessWaste: true });
      const meals = plan.days[0]!.meals;
      for (const [index, meal] of meals.entries())
        await t.prisma.plannedMeal.update({
          where: { id: meal.id },
          data: {
            recipeId: index === 1 ? yogurt : stew,
            servings: index === 1 ? 1.75 : 1,
            quantityScale: 1,
            source: 'CATALOGUE',
            eatenAt: null,
            // A rest that is not what the pack leaves: the rest of a plan kept before rests followed their packs.
            rests: index === 1 ? [{ ...wrongRest(), ingredientId: yogurtId }] : [],
          },
        });
      yogurtMeal = meals[1]!.id;
    });

    /** 5 g of yogurt kept as a rest, which the pack does not leave. */
    const wrongRest = () => ({
      ingredientId: '',
      amount: 5,
      unit: 'g',
      figures: { calories: 4.9, protein: 0.5, fat: 0.3, carbs: 0.2 },
      label: {
        fiber: { grams: 0, atLeast: false },
        sugars: { grams: 0.2, atLeast: false },
        salt: { grams: 0, atLeast: false },
        saturatedFat: { grams: 0.2, atLeast: false },
      },
    });
    /** What the meal takes of yogurt itself, and what its rest is, after a change. */
    const yogurtNow = async () => {
      const meal = await t.prisma.plannedMeal.findUniqueOrThrow({ where: { id: yogurtMeal } });
      const rest = restsOf(meal.rests)
        .filter((one) => one.ingredientId === yogurtId)
        .reduce((sum, one) => sum + one.amount, 0);
      return { own: 200 * meal.servings * meal.quantityScale, rest };
    };

    it('is what its pack leaves once a change of the plan is written', async () => {
      // Breakfast eaten: the day is sized again, the yogurt with it.
      const breakfast = plan.days[0]!.meals[0]!;
      await t
        .http()
        .patch(`/api/meal-plans/${plan.id}/meals/${breakfast.id}/eaten`)
        .set(as(user))
        .set('X-Client-Date', ahead)
        .send({ eaten: true })
        .expect(200);

      const { own, rest } = await yogurtNow();
      // The pack of 400 g finished with the meal, or, where what it leaves does not fit, no rest at all.
      expect(
        rest === 0 || Math.abs(own + rest - 400) < 0.2,
        `${own} g and a rest of ${rest} g`,
      ).toBe(true);
      expect(rest).not.toBeCloseTo(5);
    });

    it('is what its pack leaves once the application starts, and the plan moves on', async () => {
      const { revision } = await t.prisma.mealPlan.findUniqueOrThrow({ where: { id: plan.id } });

      expect(await t.app.get(RestsFollowOnStart).bring()).toBe(1);

      expect((await yogurtNow()).rest).toBeCloseTo(50);
      expect((await t.prisma.mealPlan.findUniqueOrThrow({ where: { id: plan.id } })).revision).toBe(
        revision + 1,
      );
      // A second start finds nothing to change.
      expect(await t.app.get(RestsFollowOnStart).bring()).toBe(0);
    });
  });

  describe('of a meal that alone takes from its pack', () => {
    let plan: MealPlan;
    let yogurtMeal: string;

    /** A plan of one day that wastes less, its yogurt at the meal after breakfast, and no other meal taking from a pack that does not keep. */
    beforeEach(async () => {
      const [{ id: stew }, { id: bowl }, { id: yogurt }] = await Promise.all(
        [STEW, TOFU_BOWL, YOGURT].map((slug) =>
          t.prisma.recipe.findUniqueOrThrow({ where: { slug } }),
        ),
      );
      plan = await aPlan(t, user, profile, {
        startDate: '2026-02-02',
        durationDays: 1,
        lessWaste: true,
      });
      const meals = plan.days[0]!.meals;
      for (const [index, meal] of meals.entries())
        await t.prisma.plannedMeal.update({
          where: { id: meal.id },
          data: {
            recipeId: index === 1 ? yogurt : index % 2 === 0 ? stew : bowl,
            servings: index === 1 ? 1.75 : 1,
            quantityScale: 1,
            source: 'CATALOGUE',
            eatenAt: null,
          },
        });
      await t.prisma.plannedMeal.updateMany({
        where: { day: { planId: plan.id } },
        data: { rests: [] },
      });
      yogurtMeal = meals[1]!.id;
    });

    const yogurtRest = async (): Promise<number> =>
      (await restsOfPlan(plan.id))
        .filter((rest) => rest.meal === yogurtMeal && rest.ingredientId === yogurtId)
        .reduce((sum, rest) => sum + rest.amount, 0);
    const scale = (quantityScale: number) =>
      t.prisma.plannedMeal.update({ where: { id: yogurtMeal }, data: { quantityScale } });

    it('takes what its pack leaves, as the plan would have given it', async () => {
      await follow(plan.id);

      // 350 g of a pack of 400 g: the 50 g left go with the meal.
      expect(await yogurtRest()).toBeCloseTo(50);
    });

    it('grows as the dish takes less, shrinks as it takes more, and is none once it no longer fits', async () => {
      await follow(plan.id);

      // 1.85 servings take 370 g: 30 g are left.
      await scale(1.85 / 1.75);
      await follow(plan.id);
      expect(await yogurtRest()).toBeCloseTo(30);

      // 1.5 servings take 300 g: the 100 g left hold more than a tenth of the meal, and are no rest.
      await scale(1.5 / 1.75);
      await follow(plan.id);
      expect(await yogurtRest()).toBe(0);
    });

    it('counts what a topping of another meal takes of the pack', async () => {
      // 25 g of the pack on the breakfast: 25 g are left of it for the meal.
      await t.prisma.plannedMeal.update({
        where: { id: plan.days[0]!.meals[0]!.id },
        data: { toppingKey: 'greek_yogurt', toppingAmount: 25 },
      });

      await follow(plan.id);
      expect(await yogurtRest()).toBeCloseTo(25);
    });

    it('stays as it was eaten with, once its meal is eaten', async () => {
      await follow(plan.id);
      await t.prisma.plannedMeal.update({
        where: { id: yogurtMeal },
        data: { eatenAt: new Date('2026-02-02T10:00:00Z') },
      });

      await scale(1.85 / 1.75);
      expect(await follow(plan.id)).toEqual([]);
      expect(await yogurtRest()).toBeCloseTo(50);
    });
  });
});
