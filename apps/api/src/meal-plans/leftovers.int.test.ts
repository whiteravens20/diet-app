// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import {
  GeneratePlanRequest,
  type DaySettingsPreview,
  type DayVariations,
  type LeftoverOffer,
  type MealPlan,
  type PlannedMeal,
  type Profile,
  type RebalanceResult,
  type RerollPreview,
  type ShoppingList,
} from '@diet-app/shared';
import type { HttpException } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, as, aSwap, aUser, race, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { MealPlansService } from './meal-plans.service.js';
import { PlanGenerationService } from './plan-generation.service.js';

/** Monday the 5th is yesterday, Tuesday today, Wednesday tomorrow. */
const YESTERDAY = '2026-01-05';
const TODAY = '2026-01-06';
const TOMORROW = '2026-01-07';

describe('a leftover: what is left of a meal, eaten the next day', () => {
  let t: TestApp;
  let user: TestUser;
  let profile: Profile;
  let plan: MealPlan;

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
    t.app.get(MealPlansService).today = () => TODAY;
    t.app.get(PlanGenerationService).today = () => TODAY;
    user = await aUser(t);
    profile = await aProfile(t, user);
    plan = await aPlan(t, user, profile, { startDate: YESTERDAY, durationDays: 4 });
  });

  const read = (planId: string = plan.id): Promise<MealPlan> =>
    t.app.get(MealPlansService).get(user.id, 'en', planId);
  const dayOf = (of: MealPlan, date: string) => of.days.find((day) => day.date === date)!;
  const at = (of: MealPlan, date: string, mealType: string): PlannedMeal | undefined =>
    dayOf(of, date).meals.find((meal) => meal.mealType === mealType);
  const portion = (meal: PlannedMeal): number => meal.servings * meal.quantityScale;
  const path = (planId: string, mealId: string) =>
    `/api/meal-plans/${planId}/meals/${mealId}/leftover`;
  const offer = (meal: PlannedMeal, planId = plan.id) =>
    t.http().get(path(planId, meal.id)).set(as(user));
  const carry = (meal: PlannedMeal, body: Record<string, unknown>, planId = plan.id) =>
    t.http().post(path(planId, meal.id)).set(as(user)).send(body);
  const undo = (meal: PlannedMeal, planId = plan.id, forAll = false) =>
    t
      .http()
      .delete(`${path(planId, meal.id)}${forAll ? '?forAll=true' : ''}`)
      .set(as(user));
  const carried = async (
    meal: PlannedMeal,
    body: Record<string, unknown>,
    planId = plan.id,
  ): Promise<MealPlan> =>
    ((await carry(meal, body, planId).expect(200)).body as RebalanceResult).plan;
  const refusal = async (asked: { expect: (status: number) => Promise<{ body: unknown }> }) =>
    ((await asked.expect(409)).body as { error: string }).error;

  it("offers it at every meal of a recipe of today and yesterday, and at no meal of another day or of one's own", async () => {
    const custom = await t
      .http()
      .post(`/api/meal-plans/${plan.id}/days/${TODAY}/custom-meal`)
      .set(as(user))
      .send({ name: 'Soup at work', mealType: 'lunch', servings: 1, nutrition: { calories: 400 } })
      .expect(201);
    const now = (custom.body as RebalanceResult).plan;

    for (const date of [YESTERDAY, TODAY])
      for (const meal of dayOf(now, date).meals)
        expect(meal.leftoverOffer).toBe(meal.source === 'USER_CUSTOM' ? null : 'ok');
    for (const date of [TOMORROW, '2026-01-08'])
      expect(dayOf(now, date).meals.map((meal) => meal.leftoverOffer)).toEqual(
        dayOf(now, date).meals.map(() => null),
      );
    const own = dayOf(now, TODAY).meals.find((meal) => meal.source === 'USER_CUSTOM')!;
    await carry(own, { mealType: 'lunch', left: 1 }).expect(400);
  });

  it('says where it can go: the next day, the meals of it a leftover may take the place of, and the whole portion', async () => {
    const dinner = at(plan, TODAY, 'dinner')!;
    const said = (await offer(dinner).expect(200)).body as LeftoverOffer;

    expect(said.planId).toBe(plan.id);
    expect(said.date).toBe(TOMORROW);
    expect(said.portion).toEqual({
      servings: portion(dinner),
      calories: dinner.nutrition.calories,
    });
    expect(said.places.map((place) => place.mealType)).toEqual(['breakfast', 'lunch', 'dinner']);
    const lunch = at(plan, TOMORROW, 'lunch')!;
    expect(said.places[1]).toMatchObject({
      name: lunch.recipe!.title,
      calories: lunch.nutrition.calories,
      sharedWith: null,
      cookAhead: null,
      cookedWith: [],
    });
    expect(said.other).toBeNull();
  });

  it('puts the whole portion in the place of the dish chosen where nothing was eaten, and takes the meal off its day', async () => {
    const dinner = at(plan, TODAY, 'dinner')!;
    const lunch = at(plan, TOMORROW, 'lunch')!;

    const after = await carried(dinner, { mealType: 'lunch', left: 1 });

    expect(at(after, TODAY, 'dinner')).toBeUndefined();
    const leftover = at(after, TOMORROW, 'lunch')!;
    expect(leftover.id).toBe(lunch.id);
    expect(leftover.recipe!.id).toBe(dinner.recipe!.id);
    expect(portion(leftover)).toBeCloseTo(portion(dinner), 9);
    expect(leftover.leftover).toEqual({ date: TODAY, mealType: 'dinner', undoable: true });
    expect(leftover.leftoverOffer).toBeNull();
    expect(leftover.eatenAt).toBeNull();
    // It is food there is: a rebalance of its day leaves it as it is.
    const again = (
      await t
        .http()
        .post(`/api/meal-plans/${plan.id}/rebalance`)
        .set(as(user))
        .send({ scope: 'day', date: TOMORROW })
        .expect(201)
    ).body as RebalanceResult;
    expect(at(again.plan, TOMORROW, 'lunch')!.quantityScale).toBe(leftover.quantityScale);

    // The account's export holds it, with what its undo would bring back.
    const exported = (
      await t
        .http()
        .get('/api/users/me/export')
        .set(as(user))
        .buffer(true)
        .parse((res, done) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (piece: string) => (text += piece));
          res.on('end', () => done(null, text));
        })
        .expect(200)
    ).body as string;
    const meals = (
      JSON.parse(exported) as { plans: { days: { meals: Record<string, unknown>[] }[] }[] }
    ).plans.flatMap((one) => one.days.flatMap((day) => day.meals));
    expect(meals.filter((meal) => meal.leftoverOf !== null)).toEqual([
      expect.objectContaining({
        leftoverOf: {
          date: TODAY,
          mealType: 'dinner',
          undo: expect.objectContaining({
            replaced: expect.objectContaining({ id: lunch.id }),
            source: expect.objectContaining({ id: dinner.id, kept: false }),
          }),
        },
      }),
    ]);
  });

  it('keeps the meal on its day, marked eaten, with the part eaten, where a part was, and puts the rest in the next day', async () => {
    const dinner = at(plan, TODAY, 'dinner')!;

    const after = await carried(dinner, { mealType: 'breakfast', left: 0.25 });

    const kept = at(after, TODAY, 'dinner')!;
    expect(kept.id).toBe(dinner.id);
    expect(kept.eatenAt).not.toBeNull();
    expect(portion(kept)).toBeCloseTo(0.75 * portion(dinner), 9);
    expect(kept.carriedTo).toEqual({ date: TOMORROW, mealType: 'breakfast' });
    expect(kept.leftoverOffer).toBeNull();
    const leftover = at(after, TOMORROW, 'breakfast')!;
    expect(portion(leftover)).toBeCloseTo(0.25 * portion(dinner), 9);
    expect(kept.nutrition.calories + leftover.nutrition.calories).toBeGreaterThanOrEqual(
      dinner.nutrition.calories - 1,
    );
    expect(kept.nutrition.calories + leftover.nutrition.calories).toBeLessThanOrEqual(
      dinner.nutrition.calories + 1,
    );
  });

  it('carries a leftover once, a meal once, from today or yesterday alone, into a meal not eaten that is no leftover', async () => {
    const dinner = at(plan, TODAY, 'dinner')!;
    const after = await carried(dinner, { mealType: 'lunch', left: 0.5 });
    const leftover = at(after, TOMORROW, 'lunch')!;

    expect(await refusal(carry(leftover, { mealType: 'dinner', left: 1 }))).toBe(
      'MEAL_IS_LEFTOVER',
    );
    expect(await refusal(carry(at(after, TODAY, 'dinner')!, { mealType: 'dinner', left: 1 }))).toBe(
      'LEFTOVER_CARRIED',
    );
    expect(
      await refusal(carry(at(after, TOMORROW, 'dinner')!, { mealType: 'lunch', left: 1 })),
    ).toBe('LEFTOVER_DAY');
    // Today's breakfast cannot go where the leftover is, nor yesterday's dinner where today's lunch was eaten.
    expect(
      await refusal(carry(at(after, TODAY, 'breakfast')!, { mealType: 'lunch', left: 1 })),
    ).toBe('LEFTOVER_NO_PLACE');
    await t
      .http()
      .patch(`/api/meal-plans/${plan.id}/meals/${at(after, TODAY, 'lunch')!.id}/eaten`)
      .set(as(user))
      .send({ eaten: true })
      .expect(200);
    expect(
      await refusal(carry(at(after, YESTERDAY, 'dinner')!, { mealType: 'lunch', left: 1 })),
    ).toBe('LEFTOVER_NO_PLACE');
    const said = (await offer(at(after, YESTERDAY, 'dinner')!).expect(200)).body as LeftoverOffer;
    // Today's dinner, eaten in part, takes none either, nor once it is marked not eaten: its rest is a leftover.
    expect(said.places.map((place) => place.mealType)).toEqual(['breakfast']);
    await t
      .http()
      .patch(`/api/meal-plans/${plan.id}/meals/${dinner.id}/eaten`)
      .set(as(user))
      .send({ eaten: false })
      .expect(200);
    const unmarked = (await offer(at(after, YESTERDAY, 'dinner')!).expect(200))
      .body as LeftoverOffer;
    expect(unmarked.places.map((place) => place.mealType)).toEqual(['breakfast']);
  });

  it('says why the next day cannot take one: in no plan, skipped, or with every meal eaten or a leftover', async () => {
    // A person of the account whose only plan ends today.
    const other = await aProfile(t, user, { name: 'Ola' });
    const short = await aPlan(t, user, other, { startDate: YESTERDAY, durationDays: 2 });
    const last = at(short, TODAY, 'dinner')!;
    expect(last.leftoverOffer).toBe('no_day');
    expect(await refusal(offer(last, short.id))).toBe('LEFTOVER_NO_DAY');

    const tomorrow = dayOf(plan, TOMORROW);
    await t.prisma.mealPlanDay.update({
      where: { id: tomorrow.id },
      data: { overrides: { skip: true } },
    });
    expect(at(await read(), TODAY, 'dinner')!.leftoverOffer).toBe('skipped');
    expect(await refusal(offer(at(plan, TODAY, 'dinner')!))).toBe('LEFTOVER_DAY_SKIPPED');

    await t.prisma.mealPlanDay.update({ where: { id: tomorrow.id }, data: { overrides: {} } });
    await t.prisma.plannedMeal.updateMany({
      where: { dayId: tomorrow.id },
      data: { eatenAt: new Date() },
    });
    expect(at(await read(), TODAY, 'dinner')!.leftoverOffer).toBe('no_meal');
    expect(await refusal(offer(at(plan, TODAY, 'dinner')!))).toBe('LEFTOVER_NO_PLACE');
  });

  it("goes into the person's next plan where the next day is no day of this one, the plan made last", async () => {
    const short = await aPlan(t, user, profile, { startDate: YESTERDAY, durationDays: 2 });
    // Both the plan of four days and the one made after it hold tomorrow: the one made last takes the leftover.
    const next = await aPlan(t, user, profile, { startDate: TOMORROW, durationDays: 2 });
    const dinner = at(await read(short.id), TODAY, 'dinner')!;
    expect(dinner.leftoverOffer).toBe('ok');
    expect(((await offer(dinner, short.id).expect(200)).body as LeftoverOffer).planId).toBe(
      next.id,
    );

    const after = await carried(dinner, { mealType: 'dinner', left: 1 }, short.id);

    expect(at(after, TODAY, 'dinner')).toBeUndefined();
    const leftover = at(await read(next.id), TOMORROW, 'dinner')!;
    expect(leftover.recipe!.id).toBe(dinner.recipe!.id);
    expect(leftover.leftover).toEqual({ date: TODAY, mealType: 'dinner', undoable: true });
    expect(at(await read(plan.id), TOMORROW, 'dinner')!.leftover).toBeNull();
  });

  it('is undone while it is not eaten: the dish it replaced and the meal it was left of come back', async () => {
    const dinner = at(plan, TODAY, 'dinner')!;
    const lunch = at(plan, TOMORROW, 'lunch')!;
    const moved = await carried(dinner, { mealType: 'lunch', left: 1 });

    const back = ((await undo(at(moved, TOMORROW, 'lunch')!).expect(200)).body as RebalanceResult)
      .plan;

    const again = at(back, TODAY, 'dinner')!;
    expect(again.id).toBe(dinner.id);
    expect(again.recipe!.id).toBe(dinner.recipe!.id);
    expect(again.servings).toBe(dinner.servings);
    expect(again.eatenAt).toBeNull();
    const replaced = at(back, TOMORROW, 'lunch')!;
    expect(replaced.recipe!.id).toBe(lunch.recipe!.id);
    expect(replaced.servings).toBe(lunch.servings);
    expect(replaced.leftover).toBeNull();
    expect(again.leftoverOffer).toBe('ok');

    // Eaten in part: the meal is whole again and not eaten.
    const part = await carried(again, { mealType: 'lunch', left: 0.5 });
    const whole = ((await undo(at(part, TOMORROW, 'lunch')!).expect(200)).body as RebalanceResult)
      .plan;
    expect(at(whole, TODAY, 'dinner')!.eatenAt).toBeNull();
    expect(at(whole, TODAY, 'dinner')!.carriedTo).toBeNull();
    expect(at(whole, TOMORROW, 'lunch')!.recipe!.id).toBe(lunch.recipe!.id);

    expect(await refusal(undo(lunch))).toBe('NOT_A_LEFTOVER');
  });

  it('is not undone once eaten, and leaves the meal it was left of away where its place holds a dish again', async () => {
    const dinner = at(plan, YESTERDAY, 'dinner')!;
    const moved = await carried(dinner, { mealType: 'lunch', left: 1 });
    const leftover = at(moved, TODAY, 'lunch')!;
    await t
      .http()
      .patch(`/api/meal-plans/${plan.id}/meals/${leftover.id}/eaten`)
      .set(as(user))
      .send({ eaten: true })
      .expect(200);
    expect(at(await read(), TODAY, 'lunch')!.leftover!.undoable).toBe(false);
    expect(await refusal(undo(leftover))).toBe('MEAL_EATEN');

    // Today's dinner goes the same way, and a dish takes its place before the undo.
    const today = at(moved, TODAY, 'dinner')!;
    const second = await carried(today, { mealType: 'breakfast', left: 1 });
    await t.prisma.plannedMeal.create({
      data: {
        dayId: dayOf(second, TODAY).id,
        mealType: 'dinner',
        recipeId: at(second, TOMORROW, 'dinner')!.recipe!.id,
        servings: 1,
      },
    });
    const back = (
      (await undo(at(second, TOMORROW, 'breakfast')!).expect(200)).body as RebalanceResult
    ).plan;
    expect(dayOf(back, TODAY).meals.filter((meal) => meal.mealType === 'dinner')).toHaveLength(1);
    expect(at(back, TODAY, 'dinner')!.id).not.toBe(today.id);
    expect(at(back, TOMORROW, 'breakfast')!.leftover).toBeNull();
  });

  it('is left off the shopping list, which was bought for the meal it was left of', async () => {
    // Every meal of tomorrow becomes a leftover of one of today: the list of tomorrow then needs nothing.
    let now = plan;
    for (const mealType of ['breakfast', 'lunch', 'dinner'])
      now = await carried(at(now, TODAY, mealType)!, { mealType, left: 1 });
    expect(dayOf(now, TOMORROW).meals.every((meal) => meal.leftover !== null)).toBe(true);

    const list = (
      await t
        .http()
        .post('/api/shopping-lists/generate')
        .set(as(user))
        .send({ planId: plan.id, fromDate: TOMORROW, toDate: TOMORROW })
        .expect(201)
    ).body as ShoppingList;
    expect(list.groups).toEqual([]);
  });

  it('is never swapped, redrawn by a day made again, resized by its settings or written over by a favourite set', async () => {
    const dinner = at(plan, TODAY, 'dinner')!;
    const after = await carried(dinner, { mealType: 'lunch', left: 1 });
    const leftover = at(after, TOMORROW, 'lunch')!;
    const day = dayOf(after, TOMORROW);

    const swapped = await aSwap(t, user, {
      planId: plan.id,
      plannedMealId: leftover.id,
      strategy: 'random',
    }).catch((error: unknown) => error);
    expect((swapped as HttpException).getResponse()).toMatchObject({ error: 'MEAL_IS_LEFTOVER' });

    const preview = (
      await t
        .http()
        .post(`/api/meal-plans/${plan.id}/days/${day.id}/regenerate/preview`)
        .set(as(user))
        .send({})
        .expect(200)
    ).body as RerollPreview;
    expect(preview.kept.leftover).toBe(1);
    await t
      .http()
      .post(`/api/meal-plans/${plan.id}/days/${day.id}/regenerate`)
      .set(as(user))
      .send({})
      .expect(201);
    const redrawn = at(await read(), TOMORROW, 'lunch')!;
    expect(redrawn.id).toBe(leftover.id);
    expect(redrawn.recipe!.id).toBe(dinner.recipe!.id);
    expect(portion(redrawn)).toBeCloseTo(portion(leftover), 9);

    // Every other way of the day keeps it, and so does the one taken.
    const ways = (
      await t
        .http()
        .post(`/api/meal-plans/${plan.id}/days/${day.id}/variations`)
        .set(as(user))
        .send({})
        .expect(200)
    ).body as DayVariations;
    expect(ways.variations.length).toBeGreaterThan(0);
    for (const way of ways.variations)
      expect(way.meals.find((meal) => meal.mealType === 'lunch')).toMatchObject({
        recipeId: dinner.recipe!.id,
        stays: true,
      });
    await t
      .http()
      .post(`/api/meal-plans/${plan.id}/days/${day.id}/variations/take`)
      .set(as(user))
      .send({ offer: ways.variations[0]!.offer })
      .expect(200);
    expect(at(await read(), TOMORROW, 'lunch')!.id).toBe(leftover.id);

    const settings = (change: Record<string, unknown>) =>
      t
        .http()
        .post(`/api/meal-plans/${plan.id}/days/${day.id}/settings/preview`)
        .set(as(user))
        .send({
          dayType: 'normal',
          skip: false,
          mealCount: 3,
          calorieTarget: null,
          cookTimeBudgetMinutes: null,
          useUpBy: false,
          ...change,
        })
        .expect(200)
        .then((answer) =>
          (answer.body as DaySettingsPreview).meals.find((meal) => meal.mealId === leftover.id)!,
        );
    expect(await settings({ dayType: 'training' })).toMatchObject({
      fate: 'stays',
      because: 'leftover',
    });
    expect(await settings({ mealCount: 2 })).toMatchObject({
      fate: 'removed',
      because: 'fewer_meals',
    });
    expect(await settings({ skip: true })).toMatchObject({ fate: 'removed', because: 'skipped' });

    const set = await t
      .http()
      .post('/api/favorite-sets')
      .set(as(user))
      .send({
        profileId: profile.id,
        label: 'Lunch',
        slots: { lunch: at(plan, TOMORROW, 'lunch')!.recipe!.id },
      })
      .expect(201);
    expect(
      await refusal(
        t
          .http()
          .post(`/api/favorite-sets/${(set.body as { id: string }).id}/apply`)
          .set(as(user))
          .send({ planId: plan.id, dayDates: [TOMORROW] }),
      ),
    ).toBe('MEAL_IS_LEFTOVER');
  });

  it('keeps what was cooked ahead at the meal it was left of cooked, once that meal left its day', async () => {
    const ahead = await aPlan(t, user, profile, {
      startDate: YESTERDAY,
      durationDays: 4,
      mealPrepFriendly: true,
    });
    // A dish cooked yesterday for a meal of today.
    const cook = dayOf(ahead, YESTERDAY).meals.find(
      (meal) =>
        meal.cookAhead === 'cook' && meal.cooking!.with.some((other) => other.date === TODAY),
    )!;
    expect(cook).toBeDefined();
    const fed = cook.cooking!.with.find((other) => other.date === TODAY)!;
    const place = dayOf(ahead, TODAY).meals.find((meal) => meal.id !== fed.mealId)!;

    const after = await carried(cook, { mealType: place.mealType, left: 1 }, ahead.id);

    expect(at(after, YESTERDAY, cook.mealType)).toBeUndefined();
    const eaten = dayOf(after, TODAY).meals.find((meal) => meal.id === fed.mealId)!;
    expect(eaten.cookAhead).toBe('cooked');
    expect(eaten.cooking!.with).toEqual([
      { mealId: place.id, date: YESTERDAY, mealType: cook.mealType, eaten: true },
    ]);
    const leftover = at(after, TODAY, place.mealType)!;
    expect(leftover.cookAhead).toBeNull();
    expect(leftover.cooking).toBeNull();
  });

  it('opens no pack: what it takes was opened with the meal it was left of', async () => {
    const packed = await t.prisma.recipeIngredient.findMany({
      where: { ingredient: { perishable: true, packSize: { not: null } } },
      select: { recipeId: true },
    });
    const opening = new Set(packed.map((line) => line.recipeId));
    const meal = dayOf(plan, TODAY).meals.find((one) => one.recipe && opening.has(one.recipe.id))!;
    expect(meal).toBeDefined();
    const after = await carried(meal, { mealType: 'breakfast', left: 1 });
    const leftover = at(after, TOMORROW, 'breakfast')!;

    // However much it is, the packs of the plan stay as they are.
    await t.prisma.plannedMeal.update({
      where: { id: leftover.id },
      data: { quantityScale: leftover.quantityScale * 3 },
    });
    expect((await read()).packs).toEqual(after.packs);
  });

  it('lets one of two leftovers of a meal asked for at once through', async () => {
    const dinner = at(plan, TODAY, 'dinner')!;
    const results = await race(2, () =>
      carry(dinner, { mealType: 'lunch', left: 1 }).then((answer) => {
        if (answer.status !== 200) throw new Error((answer.body as { error: string }).error);
        return answer;
      }),
    );
    expect(
      results
        .map((result) => (result.status === 'fulfilled' ? 'ok' : String(result.reason)))
        .sort(),
    ).toEqual(['Error: PLAN_CHANGED', 'ok']);
  });

  describe('of a meal shared with the other person of a joint plan', () => {
    let ewa: Profile;
    let adams: MealPlan;
    let ewas: MealPlan;

    beforeEach(async () => {
      ewa = await aProfile(t, user, {
        name: 'Ewa',
        sex: 'female',
        heightCm: 165,
        weightKg: 60,
        mealCount: 3,
      });
      adams = await t.app.get(PlanGenerationService).generate(
        user.id,
        'en',
        GeneratePlanRequest.parse({
          profileId: profile.id,
          withProfileId: ewa.id,
          startDate: YESTERDAY,
          durationDays: 3,
        }),
      );
      ewas = await read(adams.joint!.planId);
    });

    it("offers it for both, each with their own part left, the next day's time of day shared for both", async () => {
      const dinner = at(adams, TODAY, 'dinner')!;
      expect(dinner.shared).not.toBeNull();
      const said = (await offer(dinner, adams.id).expect(200)).body as LeftoverOffer;
      expect(said.other).toMatchObject({
        profileName: 'Ewa',
        eaten: false,
        places: ['breakfast', 'lunch', 'dinner'],
      });
      expect(said.places.find((place) => place.mealType === 'lunch')!.sharedWith).toBe('Ewa');

      const after = await carried(
        dinner,
        { mealType: 'lunch', left: 1, forAll: true, theirLeft: 0.5 },
        adams.id,
      );

      expect(at(after, TODAY, 'dinner')).toBeUndefined();
      const hers = await read(ewas.id);
      const herDinner = at(hers, TODAY, 'dinner')!;
      expect(herDinner.eatenAt).not.toBeNull();
      expect(portion(herDinner)).toBeCloseTo(0.5 * portion(at(ewas, TODAY, 'dinner')!), 9);
      const mine = at(after, TOMORROW, 'lunch')!;
      const herLunch = at(hers, TOMORROW, 'lunch')!;
      expect(mine.recipe!.id).toBe(dinner.recipe!.id);
      expect(herLunch.recipe!.id).toBe(dinner.recipe!.id);
      expect(portion(herLunch)).toBeCloseTo(0.5 * portion(at(ewas, TODAY, 'dinner')!), 9);
      expect(mine.shared!.with.mealId).toBe(herLunch.id);
      expect(herLunch.shared!.with.mealId).toBe(mine.id);

      // Undone for both: both days are as they were, shared again.
      const back = ((await undo(mine, adams.id, true).expect(200)).body as RebalanceResult).plan;
      const herBack = await read(ewas.id);
      expect(at(back, TODAY, 'dinner')!.shared!.with.mealId).toBe(at(herBack, TODAY, 'dinner')!.id);
      expect(at(herBack, TODAY, 'dinner')!.eatenAt).toBeNull();
      expect(at(back, TOMORROW, 'lunch')!.recipe!.id).toBe(
        at(adams, TOMORROW, 'lunch')!.recipe!.id,
      );
      expect(at(back, TOMORROW, 'lunch')!.shared!.with.mealId).toBe(
        at(herBack, TOMORROW, 'lunch')!.id,
      );
    });

    it("carries for one alone: the next day's meal stays the other person's alone, and so does the dish of today", async () => {
      const dinner = at(adams, TODAY, 'dinner')!;
      const herLunch = at(ewas, TOMORROW, 'lunch')!;

      const after = await carried(dinner, { mealType: 'lunch', left: 1 }, adams.id);

      const hers = await read(ewas.id);
      expect(at(after, TOMORROW, 'lunch')!.shared).toBeNull();
      expect(at(hers, TOMORROW, 'lunch')!.id).toBe(herLunch.id);
      expect(at(hers, TOMORROW, 'lunch')!.recipe!.id).toBe(herLunch.recipe!.id);
      expect(at(hers, TOMORROW, 'lunch')!.shared).toBeNull();
      expect(at(hers, TODAY, 'dinner')!.shared).toBeNull();
      expect(at(hers, TODAY, 'dinner')!.eatenAt).toBeNull();

      // Undone: the dish of tomorrow is shared again, and so is today's dinner.
      const back = (
        (await undo(at(after, TOMORROW, 'lunch')!, adams.id).expect(200)).body as RebalanceResult
      ).plan;
      expect(at(back, TOMORROW, 'lunch')!.shared!.with.mealId).toBe(herLunch.id);
      expect(at(back, TODAY, 'dinner')!.shared!.with.mealId).toBe(at(hers, TODAY, 'dinner')!.id);
    });

    it('shares the two leftovers at a time of day the two meals were not shared at, cooked as the meal they were left of', async () => {
      const dinner = at(adams, TODAY, 'dinner')!;
      await t
        .http()
        .patch(`/api/meal-plans/${adams.id}/shared-meals/${dinner.shared!.id}`)
        .set(as(user))
        .send({ apart: true })
        .expect(200);
      // Tomorrow's lunch is no shared meal any more.
      await t.prisma.sharedMeal.delete({ where: { id: at(adams, TOMORROW, 'lunch')!.shared!.id } });
      expect(at(await read(adams.id), TOMORROW, 'lunch')!.shared).toBeNull();

      const after = await carried(
        dinner,
        { mealType: 'lunch', left: 1, forAll: true, theirLeft: 1 },
        adams.id,
      );

      const mine = at(after, TOMORROW, 'lunch')!;
      expect(mine.shared).toMatchObject({ apart: true, with: { planId: ewas.id } });
    });

    it("keeps a leftover for one apart from the other person's meal, even where that is the same dish", async () => {
      const dinner = at(adams, TODAY, 'dinner')!;
      // Tomorrow both have the dish of today's dinner for lunch, shared.
      await t.prisma.plannedMeal.updateMany({
        where: { id: { in: [at(adams, TOMORROW, 'lunch')!.id, at(ewas, TOMORROW, 'lunch')!.id] } },
        data: { recipeId: dinner.recipe!.id },
      });
      expect(at(await read(adams.id), TOMORROW, 'lunch')!.shared).not.toBeNull();

      const after = await carried(dinner, { mealType: 'lunch', left: 1 }, adams.id);

      expect(at(after, TOMORROW, 'lunch')!.shared).toBeNull();
      expect(at(await read(ewas.id), TOMORROW, 'lunch')!.shared).toBeNull();
    });

    it('refuses a leftover for both where the other person has no meal at that time of day to take it', async () => {
      const dinner = at(adams, TODAY, 'dinner')!;
      await t.prisma.plannedMeal.update({
        where: { id: at(ewas, TOMORROW, 'lunch')!.id },
        data: { eatenAt: new Date() },
      });
      expect(
        await refusal(
          carry(dinner, { mealType: 'lunch', left: 1, forAll: true, theirLeft: 1 }, adams.id),
        ),
      ).toBe('LEFTOVER_NO_PLACE');
      await carry(dinner, { mealType: 'lunch', left: 1, forAll: true }, adams.id).expect(400);
    });
  });
});
