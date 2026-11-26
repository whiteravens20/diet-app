// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import {
  AiSwapMealRequest,
  GeneratePlanRequest,
  SwapIngredientRequest,
  SwapMealRequest,
  type DaySettingsPreview,
  type MealPlan,
  type MealPlanDay,
  type PlannedMeal,
  type Profile,
  type RebalanceResult,
  type ShoppingList,
} from '@diet-app/shared';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TOPPING_BY_KEY, toppingRefusal } from '../engine/toppings.js';
import type { ModelRequest } from '../testing/fake-model.js';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aProfile, aSwap, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { ProfilesService } from '../profiles/profiles.service.js';
import { IngredientSwapService } from './ingredient-swap.service.js';
import { MealPlansService } from './meal-plans.service.js';
import { MealSwapService } from './meal-swap.service.js';
import { PlanGenerationService } from './plan-generation.service.js';
import { dishTraitsOf, toppingAskOfDay, toppingOptionsOf } from './toppings-store.js';

describe('a topping on one plate of a joint plan', () => {
  let t: TestApp;
  let user: TestUser;
  let adam: Profile;
  let ewa: Profile;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
    t.app.get(PlanGenerationService).nextSeed = () => 7;
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await resetUserData(t.prisma);
    user = await aUser(t);
    adam = await aProfile(t, user, { name: 'Adam', mealCount: 3, dietType: 'high_protein' });
    ewa = await aProfile(t, user, {
      name: 'Ewa',
      sex: 'female',
      heightCm: 165,
      weightKg: 60,
      mealCount: 3,
    });
  });

  const together = (first: Profile, second: Profile): Promise<MealPlan> =>
    t.app.get(PlanGenerationService).generate(
      user.id,
      'en',
      GeneratePlanRequest.parse({
        profileId: first.id,
        withProfileId: second.id,
        startDate: '2026-01-05',
        durationDays: 7,
      }),
    );
  const read = (planId: string): Promise<MealPlan> =>
    t.app.get(MealPlansService).get(user.id, 'en', planId);
  const toppingsOf = (plan: MealPlan) =>
    plan.days.flatMap((day) =>
      day.meals.filter((meal) => meal.topping !== null).map((meal) => ({ day, meal })),
    );

  it('goes on a shared plate of the person whose day the shared dishes leave off its split, and fits dish and person', async () => {
    const ewas = await together(ewa, adam);
    const adams = await read(ewas.joint!.planId);
    const topped = toppingsOf(adams);

    expect(topped.length).toBeGreaterThan(0);
    const traits = await dishTraitsOf(
      t.prisma,
      topped.map(({ meal }) => meal.recipe!.id),
    );
    const foods = new Map(
      (await toppingOptionsOf(t.prisma)).map((option) => [option.topping.key, option.food]),
    );
    for (const { meal } of topped) {
      // On a meal both eat, and on that plate alone.
      expect(meal.shared).not.toBeNull();
      const theirs = ewas.days
        .flatMap((day) => day.meals)
        .find((one) => one.id === meal.shared!.with.mealId)!;
      expect(theirs.topping).toBeNull();
      const topping = TOPPING_BY_KEY.get(meal.topping!.key)!;
      expect(
        toppingRefusal(
          topping,
          foods.get(topping.key)!,
          traits.get(meal.recipe!.id)!,
          meal.mealType,
          {
            diet: 'high_protein',
            allergens: [],
            excluded: new Set(),
            disliked: new Set(),
            fullKinds: new Set(),
          },
        ),
      ).toBeNull();
      expect(topping.amounts).toContain(meal.topping!.ingredient.quantity);
    }
  });

  it('reads a dish built on tofu as one whose plate beside it stays of plants', async () => {
    const [onTofu, withChicken] = await Promise.all(
      ['baked-tofu-with-broccoli', 'chicken-rice-broccoli'].map((slug) =>
        t.prisma.recipe.findFirstOrThrow({ where: { slug }, select: { id: true } }),
      ),
    );
    const dishes = await dishTraitsOf(t.prisma, [onTofu.id, withChicken.id]);
    expect(dishes.get(onTofu.id)!.meatStandIn).toBe(true);
    expect(dishes.get(withChicken.id)!.meatStandIn).toBe(false);
  });

  it('is chosen knowing what the person had on the other days of the weeks around its day', async () => {
    const ewas = await together(ewa, adam);
    const adams = await read(ewas.joint!.planId);
    const topped = toppingsOf(adams);
    const [{ day }] = topped;
    const plan = await t.prisma.mealPlan.findUniqueOrThrow({
      where: { id: adams.id },
      select: { id: true, profileId: true, dietType: true },
    });

    const { used } = await toppingAskOfDay(t.prisma, plan, new Date(`${day!.date}T00:00:00Z`), []);

    const others = new Map<string, number>();
    for (const one of topped) {
      if (one.day.date === day!.date) continue;
      others.set(one.meal.topping!.key, (others.get(one.meal.topping!.key) ?? 0) + 1);
    }
    expect(used).toEqual(others);
  });

  it('counts in its day, beside the dish’s own figures', async () => {
    const ewas = await together(ewa, adam);
    const adams = await read(ewas.joint!.planId);
    for (const day of adams.days) {
      const sum = (key: 'calories' | 'protein' | 'fat' | 'carbs') =>
        day.meals.reduce(
          (total, meal) => total + meal.nutrition[key] + (meal.topping?.nutrition[key] ?? 0),
          0,
        );
      expect(day.dayNutrition).toEqual({
        calories: sum('calories'),
        protein: sum('protein'),
        fat: sum('fat'),
        carbs: sum('carbs'),
      });
    }
    const [{ meal }] = toppingsOf(adams);
    // The meal's own figures are its dish's.
    expect(meal!.nutrition.calories).toBe(
      Math.round(meal!.recipe!.nutritionPerServing.calories * meal!.servings * meal!.quantityScale),
    );
  });

  it('stays on a plate eaten with it, and goes from a meal no longer shared', async () => {
    const ewas = await together(ewa, adam);
    const adams = await read(ewas.joint!.planId);
    const [first, second] = toppingsOf(adams);
    // A meal is marked eaten on its day.
    const plans = t.app.get(MealPlansService);
    const today = plans.today;
    plans.today = () => first!.day.date;

    await t
      .http()
      .patch(`/api/meal-plans/${adams.id}/meals/${first!.meal.id}/eaten`)
      .set(as(user))
      .send({ eaten: true, forAll: false })
      .expect(200);
    const eaten = (await read(adams.id)).days
      .flatMap((day) => day.meals)
      .find((meal) => meal.id === first!.meal.id)!;
    expect(eaten.eatenAt).not.toBeNull();
    expect(eaten.topping).toEqual(first!.meal.topping);

    // The diary has it with the meal, its figures in the meal's.
    const diary = await t
      .http()
      .get(`/api/diary/day?profileId=${adam.id}&date=${first!.day.date}`)
      .set(as(user))
      .expect(200);
    const inDiary = (
      diary.body.plan.meals as { id: string; nutrition: { calories: number }; topping: unknown }[]
    ).find((meal) => meal.id === eaten.id)!;
    expect(inDiary.topping).toEqual({
      name: eaten.topping!.ingredient.name,
      display: eaten.topping!.ingredient.display,
    });
    expect(inDiary.nutrition.calories).toBe(
      eaten.nutrition.calories + eaten.topping!.nutrition.calories,
    );

    plans.today = today;
    const other =
      second ?? toppingsOf(await read(adams.id)).find(({ meal }) => meal.id !== first!.meal.id);
    if (!other) return;
    const swapped = await aSwap(t, user, {
      planId: adams.id,
      plannedMealId: other.meal.id,
      strategy: 'random',
    });
    const now = swapped.plan.days
      .flatMap((day) => day.meals)
      .find(
        (meal) =>
          meal.mealType === other.meal.mealType &&
          swapped.plan.days.find((day) => day.date === other.day.date)!.meals.includes(meal),
      )!;
    expect(now.shared).toBeNull();
    expect(now.topping).toBeNull();
  });

  it('goes from the plate when the other person changes the dish they shared for themselves alone, and their plan says it changed', async () => {
    const ewas = await together(ewa, adam);
    const adams = await read(ewas.joint!.planId);
    const [{ meal }] = toppingsOf(adams);

    // Ewa takes another recipe for her own meal: the dish is no longer one both eat.
    await aSwap(t, user, {
      planId: ewas.id,
      plannedMealId: meal!.shared!.with.mealId,
      strategy: 'random',
    });

    const after = await read(adams.id);
    const his = after.days.flatMap((day) => day.meals).find((one) => one.id === meal!.id)!;
    expect(his.recipe!.id).toBe(meal!.recipe!.id);
    expect(his.shared).toBeNull();
    expect(his.topping).toBeNull();
    expect(after.revision).toBeGreaterThan(adams.revision);
  });

  /** What the meals of the days hold that a swap and its undo move, as the plan keeps them. */
  const rowsOf = (dayIds: readonly string[]) =>
    t.prisma.plannedMeal.findMany({
      where: { dayId: { in: [...dayIds] } },
      select: {
        id: true,
        recipeId: true,
        servings: true,
        quantityScale: true,
        swapHistory: true,
        toppingKey: true,
        toppingAmount: true,
        plate: true,
        rests: true,
        sharedMealId: true,
      },
      orderBy: { id: 'asc' },
    });

  it('comes back with a dish both ate when a swap made for one alone is taken back, the topping with it', async () => {
    const ewas = await together(ewa, adam);
    const adams = await read(ewas.joint!.planId);
    const [{ day, meal }] = toppingsOf(adams);
    const herDay = ewas.days.find((one) => one.date === day!.date)!;
    const before = await rowsOf([day!.id, herDay.id]);

    // Adam takes another recipe for his own meal alone: the dish is no longer one both eat.
    const swapped = await aSwap(t, user, {
      planId: adams.id,
      plannedMealId: meal!.id,
      strategy: 'random',
    });
    const unlinked = await rowsOf([day!.id, herDay.id]);
    expect(unlinked.find((row) => row.id === meal!.shared!.with.mealId)!.sharedMealId).toBeNull();

    await t.app
      .get(MealPlansService)
      .undoSwap(user.id, 'en', { planId: adams.id, revision: swapped.plan.revision });

    // The meal is one both eat again, under its own link, and both days hold the portions, plates and toppings
    // they held before the swap.
    expect(await rowsOf([day!.id, herDay.id])).toEqual(before);
    const history = await t.app.get(MealPlansService).dayHistory(user.id, 'en', adams.id, day!.id);
    expect(history.events[0]!.cause).toBe('swap-undo');
  });

  it('puts back the other person’s day the swap sized without the dish both ate, and her plan and day say so', async () => {
    const ewas = await together(ewa, adam);
    const adams = await read(ewas.joint!.planId);
    // A meal both eat whose plate is her own: a topping or a plate of hers, which a swap of his alone takes off.
    const hers = await t.prisma.plannedMeal.findFirstOrThrow({
      where: {
        day: { planId: ewas.id },
        sharedMealId: { not: null },
        OR: [{ toppingKey: { not: null } }, { plate: { not: Prisma.DbNull } }],
      },
      select: { id: true, dayId: true, sharedMealId: true },
    });
    const his = await t.prisma.plannedMeal.findFirstOrThrow({
      where: { sharedMealId: hers.sharedMealId, day: { planId: adams.id } },
      select: { id: true, dayId: true },
    });
    const before = await rowsOf([his.dayId, hers.dayId]);

    const swapped = await aSwap(t, user, {
      planId: adams.id,
      plannedMealId: his.id,
      strategy: 'random',
    });
    const herPlanSwapped = await read(ewas.id);
    const [sized] = (await rowsOf([hers.dayId])).filter((row) => row.id === hers.id);
    expect(sized).toMatchObject({ sharedMealId: null, toppingKey: null, plate: null });

    await t.app
      .get(MealPlansService)
      .undoSwap(user.id, 'en', { planId: adams.id, revision: swapped.plan.revision });

    expect(await rowsOf([his.dayId, hers.dayId])).toEqual(before);
    // Her plan changed again: a client that holds it reads it again, and her day says why.
    expect((await read(ewas.id)).revision).toBeGreaterThan(herPlanSwapped.revision);
    const history = await t.app
      .get(MealPlansService)
      .dayHistory(user.id, 'en', ewas.id, hers.dayId);
    expect(history.events[0]!.cause).toBe('swap-undo');
  });

  it('links the dish again when the other person changed another day since the swap, and sizes her day with it', async () => {
    const ewas = await together(ewa, adam);
    const adams = await read(ewas.joint!.planId);
    const hers = await t.prisma.plannedMeal.findFirstOrThrow({
      where: {
        day: { planId: ewas.id },
        sharedMealId: { not: null },
        OR: [{ toppingKey: { not: null } }, { plate: { not: Prisma.DbNull } }],
      },
      select: { id: true, dayId: true, sharedMealId: true },
    });
    const his = await t.prisma.plannedMeal.findFirstOrThrow({
      where: { sharedMealId: hers.sharedMealId, day: { planId: adams.id } },
      select: { id: true },
    });
    const swapped = await aSwap(t, user, {
      planId: adams.id,
      plannedMealId: his.id,
      strategy: 'random',
    });
    // Ewa then changes a meal of another day: her plan no longer stands as the swap left it.
    const another = ewas.days.find((day) => day.id !== hers.dayId)!.meals[0]!;
    await aSwap(t, user, { planId: ewas.id, plannedMealId: another.id, strategy: 'random' });
    const herPlanMoved = await read(ewas.id);

    await t.app
      .get(MealPlansService)
      .undoSwap(user.id, 'en', { planId: adams.id, revision: swapped.plan.revision });

    // Both hold the dish again: it is shared again under its link, and her day is sized with it.
    const [herMeal] = (await rowsOf([hers.dayId])).filter((row) => row.id === hers.id);
    expect(herMeal!.sharedMealId).toBe(hers.sharedMealId);
    expect((await read(ewas.id)).revision).toBeGreaterThan(herPlanMoved.revision);
    const history = await t.app
      .get(MealPlansService)
      .dayHistory(user.id, 'en', ewas.id, hers.dayId);
    expect(history.events[0]!.cause).toBe('swap-undo');
  });

  it('comes back as a dish of his own when a swap for both is taken back after her plan moved on, its topping off', async () => {
    const ewas = await together(ewa, adam);
    const adams = await read(ewas.joint!.planId);
    const [{ day, meal }] = toppingsOf(adams);
    const swaps = t.app.get(MealSwapService);
    const asked = SwapMealRequest.parse({
      planId: adams.id,
      plannedMealId: meal!.id,
      strategy: 'random',
      forAll: true,
    });
    const offer = await swaps.preview(user.id, 'en', asked);
    const swapped = await swaps.apply(user.id, 'en', {
      planId: adams.id,
      plannedMealId: meal!.id,
      recipeId: offer.recipe.id,
      revision: offer.revision,
      strategy: 'random',
      allowOffDiet: false,
      forAll: true,
    });
    // Her plan no longer stands as the swap left it: the undo takes back his meal alone.
    await t.prisma.mealPlan.update({
      where: { id: ewas.id },
      data: { revision: { increment: 1 } },
    });

    await t.app
      .get(MealPlansService)
      .undoSwap(user.id, 'en', { planId: adams.id, revision: swapped.plan.revision });

    // His dish is back and hers is the new one: no plate or topping of a dish both ate stays on his.
    const [his] = (await rowsOf([day!.id])).filter((row) => row.id === meal!.id);
    expect(his).toMatchObject({
      recipeId: meal!.recipe!.id,
      sharedMealId: null,
      toppingKey: null,
      plate: null,
    });
  });

  it('comes back with a dish both ate when a swap of one of its ingredients for one alone is taken back', async () => {
    const ewas = await together(ewa, adam);
    const adams = await read(ewas.joint!.planId);
    const swaps = t.app.get(IngredientSwapService);
    // A meal both eat with an ingredient the catalogue has a substitute for.
    let found: { day: MealPlanDay; meal: PlannedMeal; from: string; to: string } | null = null;
    for (const day of adams.days)
      for (const meal of day.meals) {
        if (found || !meal.shared) continue;
        const [suggestion] = await swaps.suggestions(user.id, 'en', adams.id, meal.id);
        if (suggestion)
          found = { day, meal, from: suggestion.fromIngredientId, to: suggestion.to.id };
      }
    expect(found).not.toBeNull();
    const herDay = ewas.days.find((one) => one.date === found!.day.date)!;
    const before = await rowsOf([found!.day.id, herDay.id]);

    const swapped = await swaps.applyIngredientSwap(
      user.id,
      'en',
      SwapIngredientRequest.parse({
        planId: adams.id,
        plannedMealId: found!.meal.id,
        fromIngredientId: found!.from,
        toIngredientId: found!.to,
        acceptChange: true,
      }),
    );
    const hers = (await rowsOf([herDay.id])).find(
      (row) => row.id === found!.meal.shared!.with.mealId,
    )!;
    expect(hers.sharedMealId).toBeNull();

    await t.app
      .get(MealPlansService)
      .undoSwap(user.id, 'en', { planId: adams.id, revision: swapped.plan.revision });

    expect(await rowsOf([found!.day.id, herDay.id])).toEqual(before);
  });

  it('comes back as a dish of his own when the other person changed theirs after the swap, and his day takes the topping off', async () => {
    const ewas = await together(ewa, adam);
    const adams = await read(ewas.joint!.planId);
    const [{ day, meal }] = toppingsOf(adams);
    const swapped = await aSwap(t, user, {
      planId: adams.id,
      plannedMealId: meal!.id,
      strategy: 'random',
    });
    // Ewa then takes another recipe for her meal of that time of day as well.
    await aSwap(t, user, {
      planId: ewas.id,
      plannedMealId: meal!.shared!.with.mealId,
      strategy: 'random',
    });

    await t.app
      .get(MealPlansService)
      .undoSwap(user.id, 'en', { planId: adams.id, revision: swapped.plan.revision });

    // His dish is back, his own: no plate and no topping are kept for a dish nobody shares with him.
    const [his] = (await rowsOf([day!.id])).filter((row) => row.id === meal!.id);
    expect(his).toMatchObject({
      recipeId: meal!.recipe!.id,
      sharedMealId: null,
      toppingKey: null,
      toppingAmount: null,
      plate: null,
    });
  });

  it('is bought with the plan: the shopping list holds as much more of its food as the plates take', async () => {
    const ewas = await together(ewa, adam);
    const adams = await read(ewas.joint!.planId);
    const plates = new Map<string, number>();
    for (const { meal } of toppingsOf(adams)) {
      const { ingredientId, quantity } = meal.topping!.ingredient;
      plates.set(ingredientId, (plates.get(ingredientId) ?? 0) + quantity);
    }
    expect(plates.size).toBeGreaterThan(0);
    /** The plan's list, as much of each food as it says to buy, in the unit of the food's amounts. */
    const bought = async () => {
      const list = (
        await t
          .http()
          .post('/api/shopping-lists/generate')
          .set(as(user))
          .send({ planId: adams.id })
          .expect(201)
      ).body as ShoppingList;
      return new Map(
        list.groups
          .flatMap((group) => group.items)
          .map((item) => [
            item.ingredientId,
            {
              amount:
                item.unit === 'piece'
                  ? item.totalQuantity * item.gramsPerPiece!
                  : item.totalQuantity,
              // A list buys whole pieces, or the next 5 g or 5 ml.
              step: item.unit === 'piece' ? item.gramsPerPiece! : 5,
            },
          ]),
      );
    };

    const topped = await bought();
    await t.prisma.plannedMeal.updateMany({
      where: { day: { planId: adams.id } },
      data: { toppingKey: null, toppingAmount: null },
    });
    const plain = await bought();

    for (const [ingredientId, plate] of plates) {
      const more = topped.get(ingredientId)!.amount - (plain.get(ingredientId)?.amount ?? 0);
      expect(more).toBeGreaterThanOrEqual(plate - topped.get(ingredientId)!.step);
      expect(more).toBeLessThanOrEqual(plate + topped.get(ingredientId)!.step);
    }
  });

  it('opens its pack as a line of a recipe does, in what the plan’s packs use', async () => {
    const ewas = await together(ewa, adam);
    const adams = await read(ewas.joint!.planId);
    const bare = adams.days.flatMap((day) => day.meals).find((meal) => meal.topping === null)!;
    const before = adams.packs.used;

    // 150 g of Greek yogurt, whose 400 g pack does not keep once open.
    await t.prisma.plannedMeal.update({
      where: { id: bare.id },
      data: { toppingKey: 'greek_yogurt', toppingAmount: 150 },
    });

    expect((await read(adams.id)).packs.used).toBe(before + 150);
  });

  it('goes with the dish a leftover takes the place of, and comes back with it when the leftover is undone', async () => {
    const ewas = await together(ewa, adam);
    const adams = await read(ewas.joint!.planId);
    const target = toppingsOf(adams).find(({ day }) => day.date !== adams.days[0]!.date)!;
    const eve = adams.days[adams.days.findIndex((day) => day.id === target.day.id) - 1]!;
    const source = eve.meals.find((meal) => meal.recipe !== null)!;
    // Carried on the evening before the topped meal's day, from a meal of that evening.
    const plans = t.app.get(MealPlansService);
    const today = plans.today;
    plans.today = () => eve.date;
    const path = `/api/meal-plans/${adams.id}/meals/${source.id}/leftover`;

    const carried = (
      (
        await t
          .http()
          .post(path)
          .set(as(user))
          .send({ mealType: target.meal.mealType, left: 1 })
          .expect(200)
      ).body as RebalanceResult
    ).plan;
    const there = carried.days
      .find((day) => day.id === target.day.id)!
      .meals.find((meal) => meal.mealType === target.meal.mealType)!;
    expect(there.leftover).not.toBeNull();
    expect(there.topping).toBeNull();

    const leftover = carried.days.flatMap((day) => day.meals).find((meal) => meal.id === there.id)!;
    await t
      .http()
      .delete(`/api/meal-plans/${adams.id}/meals/${leftover.id}/leftover`)
      .set(as(user))
      .expect(200);
    plans.today = today;
    const back = (await read(adams.id)).days
      .find((day) => day.id === target.day.id)!
      .meals.find((meal) => meal.mealType === target.meal.mealType)!;
    expect(back.leftover).toBeNull();
    expect(back.topping).toEqual(target.meal.topping);
  });

  it('counts in what a change of its day’s settings says the day comes to', async () => {
    const ewas = await together(ewa, adam);
    const adams = await read(ewas.joint!.planId);
    const [{ day }] = toppingsOf(adams);

    // On its day, the settings as they are: nothing is drawn or sized again, so the day comes to what it holds now.
    const plans = t.app.get(MealPlansService);
    const today = plans.today;
    plans.today = () => day!.date;
    const preview = (
      await t
        .http()
        .post(`/api/meal-plans/${adams.id}/days/${day!.id}/settings/preview`)
        .set(as(user))
        .send({
          dayType: day!.overrides?.dayType ?? 'normal',
          skip: false,
          mealCount: day!.mealCount,
          calorieTarget: day!.overrides?.calorieTarget ?? null,
          cookTimeBudgetMinutes: day!.overrides?.cookTimeBudgetMinutes ?? null,
          useUpBy: day!.overrides?.useUpBy ?? false,
        })
        .expect(200)
    ).body as DaySettingsPreview;
    plans.today = today;

    expect(preview.unchanged).toBe(true);
    expect(preview.dayCalories).toBe(day!.dayNutrition.calories);
  });

  it('is drawn again with the days made again for both, and goes with a dish made again for one alone', async () => {
    const ewas = await together(ewa, adam);
    const again = (planId: string, forAll: boolean) =>
      t
        .http()
        .post(`/api/meal-plans/${planId}/regenerate`)
        .set(as(user))
        .send({ from: '2026-01-05', to: '2026-01-11', includePast: true, forAll })
        .expect(201);

    await again(ewas.id, true);
    const adams = await read(ewas.joint!.planId);
    const topped = toppingsOf(adams);
    expect(topped.length).toBeGreaterThan(0);
    expect(topped.every(({ meal }) => meal.shared !== null)).toBe(true);
    expect(toppingsOf(await read(ewas.id))).toEqual([]);

    // Made again for Adam alone, no meal of his is shared, and none has a topping.
    await again(adams.id, false);
    expect(toppingsOf(await read(adams.id))).toEqual([]);
  });

  describe('named by a model', () => {
    beforeEach(async () => {
      await t.prisma.user.update({ where: { id: user.id }, data: { aiMode: 'admin' } });
    });

    /** The toppings whose foods the test catalogue has. */
    const here = [
      'egg',
      'rice',
      'chickpeas',
      'greek_yogurt',
      'peanut_butter',
      'banana',
      'olive_oil',
    ];
    /** The first candidate the prompt lists toppings beside, with the first of them, or one this instance has that it does not list. */
    const answer = (listed: boolean) => (request: ModelRequest) => {
      const line = request.prompt.split('\n').find((one) => one.includes('| toppings: '))!;
      const recipeId = /id=([0-9a-f-]{36})/.exec(line)![1]!;
      const keys = line.split('| toppings: ')[1]!.split(', ');
      const topping = listed ? keys[0]! : here.find((key) => !keys.includes(key))!;
      return JSON.stringify({ recipeId, reason: 'It goes with the day.', topping });
    };

    it('at an AI swap of a shared meal, is offered and put on the plate, as the engine sizes it', async () => {
      const ewas = await together(ewa, adam);
      const adams = await read(ewas.joint!.planId);
      const meal = adams.days
        .flatMap((day) => day.meals)
        .find((one) => one.shared !== null && one.topping !== null)!;
      let named = '';
      t.model.reply({
        text: (request) => {
          const answered = answer(true)(request);
          named = JSON.parse(answered).topping;
          return answered;
        },
      });

      const swaps = t.app.get(MealSwapService);
      const offer = await swaps.previewWithAi(
        user.id,
        'en',
        AiSwapMealRequest.parse({ planId: adams.id, plannedMealId: meal.id, forAll: true }),
      );
      expect(offer.topping?.key).toBe(named);
      const made = await swaps.apply(user.id, 'en', {
        planId: adams.id,
        plannedMealId: meal.id,
        recipeId: offer.recipe.id,
        revision: offer.revision,
        strategy: 'random',
        allowOffDiet: false,
        forAll: true,
        pick: offer.pick!,
      });
      const swapped = made.plan.days.flatMap((day) => day.meals).find((one) => one.id === meal.id)!;
      // Still shared, and given the topping named, or none where it brings the day no nearer: never another.
      expect(swapped.shared).not.toBeNull();
      expect(swapped.topping === null || swapped.topping.key === named).toBe(true);
    });

    it('naming a topping not listed beside the dish, is offered none', async () => {
      const ewas = await together(ewa, adam);
      const adams = await read(ewas.joint!.planId);
      const meal = adams.days
        .flatMap((day) => day.meals)
        .find((one) => one.shared !== null && one.topping !== null)!;
      t.model.reply({ text: answer(false) });
      const offer = await t.app
        .get(MealSwapService)
        .previewWithAi(
          user.id,
          'en',
          AiSwapMealRequest.parse({ planId: adams.id, plannedMealId: meal.id, forAll: true }),
        );
      expect(offer.topping).toBeNull();
    });
  });

  it('goes from the meals not eaten of the other plan when one plan of the two is removed, and the days say so', async () => {
    const ewas = await together(ewa, adam);
    const adams = await read(ewas.joint!.planId);
    const topped = toppingsOf(adams);
    expect(topped.length).toBeGreaterThan(1);
    // A meal eaten with its topping keeps it.
    const eaten = topped[0]!.meal;
    await t.prisma.plannedMeal.update({
      where: { id: eaten.id },
      data: { eatenAt: new Date(`${topped[0]!.day.date}T12:00:00Z`) },
    });

    await t.app.get(MealPlansService).remove(user.id, 'en', ewas.id, '2026-01-05');

    const after = await read(adams.id);
    expect(after.joint).toBeNull();
    expect(toppingsOf(after).map(({ meal }) => meal.id)).toEqual([eaten.id]);
    // Each day that lost one says why in its history.
    for (const { day } of topped.slice(1)) {
      const history = await t.app.get(MealPlansService).dayHistory(user.id, 'en', adams.id, day.id);
      expect(history.events.map((event) => event.cause)).toContain('joint-removed');
    }
  });

  it('goes from a plate whose eater may no longer be given it once the profile leaves its food out, and the days say so', async () => {
    const ewas = await together(ewa, adam);
    const adams = await read(ewas.joint!.planId);
    const topped = toppingsOf(adams);
    expect(topped.length).toBeGreaterThan(0);
    const food = topped[0]!.meal.topping!.ingredient.ingredientId;

    await t.app
      .get(ProfilesService)
      .patchPreferences(user.id, adam.id, { excludedIngredientIds: [food] }, '2026-01-05');

    const after = await read(adams.id);
    expect(
      toppingsOf(after).filter(({ meal }) => meal.topping!.ingredient.ingredientId === food),
    ).toEqual([]);
    const history = await t.app
      .get(MealPlansService)
      .dayHistory(user.id, 'en', adams.id, topped[0]!.day.id);
    expect(history.events.map((event) => event.cause)).toContain('preferences');
  });

  it('is put on no plate of two people the shared dishes suit', async () => {
    await t.prisma.profile.update({ where: { id: adam.id }, data: { dietType: 'balanced' } });
    const ewas = await together(ewa, adam);
    const adams = await read(ewas.joint!.planId);
    expect(toppingsOf(ewas)).toEqual([]);
    expect(toppingsOf(adams)).toEqual([]);
  });
});
