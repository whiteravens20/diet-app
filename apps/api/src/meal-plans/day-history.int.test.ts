// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { DayHistory, MAX_DAY_EVENTS, type MealPlan } from '@diet-app/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ShoppingListsService } from '../shopping-lists/shopping-lists.service.js';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, as, aSwap, aUser, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { MealPlansService } from './meal-plans.service.js';

/** The plan's first day, which is today for whoever asks. */
const TODAY = '2026-01-05';

describe("a day's history", () => {
  let t: TestApp;
  let plans: MealPlansService;
  let serverToday: () => string;
  let user: TestUser;
  let plan: MealPlan;

  beforeAll(async () => {
    t = await createTestApp();
    plans = t.app.get(MealPlansService);
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
  });

  beforeEach(async () => {
    await resetUserData(t.prisma);
    serverToday = plans.today;
    plans.today = () => TODAY;
    user = await aUser(t);
    plan = await aPlan(t, user, await aProfile(t, user), { startDate: TODAY });
  });

  afterEach(() => {
    plans.today = serverToday;
  });

  afterAll(async () => {
    await t.close();
  });

  const dayOne = () => plan.days[0]!;
  const history = async (dayId = dayOne().id, who = user): Promise<DayHistory> =>
    DayHistory.parse(
      (
        await t
          .http()
          .get(`/api/meal-plans/${plan.id}/days/${dayId}/history`)
          .set(as(who))
          .expect(200)
      ).body,
    );
  const scales = async () =>
    Object.fromEntries(
      (
        await t.prisma.plannedMeal.findMany({
          where: { dayId: dayOne().id },
          select: { id: true, quantityScale: true },
        })
      ).map((meal) => [meal.id, meal.quantityScale]),
    );
  /** The first day's first dish grown past what the day aims at: "Dopasuj porcje dnia" has portions to move. */
  const offTarget = () =>
    t.prisma.plannedMeal.update({
      where: { id: dayOne().meals[0]!.id },
      data: { quantityScale: 1.7 },
    });
  const sizeDayOne = () =>
    plans.rebalance(user.id, 'en', plan.id, { scope: 'day', date: TODAY }, TODAY);

  it('holds no change of a day no change moved, and what the day holds', async () => {
    const day = await history();

    expect(day).toMatchObject({
      planId: plan.id,
      dayId: dayOne().id,
      date: TODAY,
      kept: null,
      events: [],
      undo: null,
      holds: { ownMeals: [], eatenMeals: [], leftovers: [], rests: [], diaryEntries: 0 },
    });
  });

  it("keeps a sizing of the day as the user's own change, and puts its portions back by the undo it offers", async () => {
    await offTarget();
    const before = await scales();

    const sized = await sizeDayOne();
    const changes = sized.rebalance?.changes ?? [];
    expect(changes.length).toBeGreaterThan(0);

    const day = await history();
    expect(day.events).toHaveLength(1);
    const [event] = day.events;
    expect(event).toMatchObject({ cause: 'resize', own: true, from: [], target: null });
    expect(new Set(event!.meals.map((meal) => meal.mealId))).toEqual(
      new Set(changes.map((change) => change.mealId)),
    );
    for (const meal of event!.meals) {
      const change = changes.find((one) => one.mealId === meal.mealId)!;
      // The same dish, its servings moved as its factor did.
      expect(meal.after!.name).toBe(meal.before!.name);
      expect(meal.after!.servings / meal.before!.servings).toBeCloseTo(
        change.after / change.before,
      );
    }
    expect(day.undo).toMatchObject({ kind: 'restore', eventId: event!.id, alsoDays: [] });
    expect(new Map(day.undo!.restore.map((one) => [one.mealId, one.scale]))).toEqual(
      new Map(changes.map((change) => [change.mealId, change.before])),
    );

    await plans.rebalance(
      user.id,
      'en',
      plan.id,
      { scope: 'day', restore: day.undo!.restore },
      TODAY,
    );
    expect(await scales()).toEqual(before);
    const after = await history();
    expect(after.events.map((one) => one.cause)).toEqual(['undo', 'resize']);
    expect(after.events[0]!.choice).toEqual({ before: null, after: 'undo' });
    expect(after.kept?.choice).toBe('undo');
    // An undo is not undone again from the history.
    expect(after.undo).toBeNull();
  });

  it('offers no undo of a change once another change of the plan came after it', async () => {
    await offTarget();
    await sizeDayOne();
    expect((await history()).undo).not.toBeNull();

    // The next day sized: a change of the plan after it, though of another day.
    await t.prisma.plannedMeal.update({
      where: { id: plan.days[1]!.meals[0]!.id },
      data: { quantityScale: 1.7 },
    });
    await plans.rebalance(
      user.id,
      'en',
      plan.id,
      { scope: 'day', date: plan.days[1]!.date },
      TODAY,
    );
    expect((await history(plan.days[1]!.id)).events.map((one) => one.cause)).toEqual(['resize']);

    const day = await history();
    expect(day.events.map((one) => one.cause)).toEqual(['resize']);
    expect(day.undo).toBeNull();
  });

  it("keeps a swap, with the swap's own undo while nothing changed after it", async () => {
    const meal = dayOne().meals[0]!;
    const swapped = await aSwap(t, user, {
      planId: plan.id,
      plannedMealId: meal.id,
      strategy: 'random',
    });
    const dish = swapped.plan.days[0]!.meals.find((one) => one.id === meal.id)!;

    const day = await history();
    expect(day.events[0]).toMatchObject({ cause: 'swap', own: true });
    const moved = day.events[0]!.meals.find((one) => one.mealId === meal.id)!;
    expect(moved.before!.name).toBe(meal.recipe!.title);
    expect(moved.after!.name).toBe(dish.recipe!.title);
    expect(dish.recipe!.title).not.toBe(meal.recipe!.title);
    expect(day.undo).toMatchObject({ kind: 'swap', restore: [] });
    expect(day.revision).toBe(swapped.plan.revision);

    await t
      .http()
      .post('/api/meal-plans/swap-meal/undo')
      .set(as(user))
      .send({ planId: plan.id, revision: day.revision })
      .expect(200);
    const after = await history();
    expect(after.events.map((one) => one.cause)).toEqual(['swap-undo', 'swap']);
    expect(after.undo).toBeNull();
  });

  it('keeps an eaten mark with the meal it marked, and offers no undo of it', async () => {
    const meal = dayOne().meals[0]!;

    await plans.setEaten(user.id, 'en', plan.id, meal.id, true, TODAY);

    const day = await history();
    expect(day.events[0]).toMatchObject({ cause: 'eaten', own: true });
    expect(day.events[0]!.meals.find((one) => one.mealId === meal.id)).toMatchObject({
      before: { eaten: false },
      after: { eaten: true },
    });
    expect(day.holds.eatenMeals).toEqual([meal.recipe!.title]);
    expect(day.undo).toBeNull();
  });

  it("makes the day's portions the user's choice by keeping them, which an eaten mark leaves as it is", async () => {
    await offTarget();
    const { revision } = await history();

    const kept = DayHistory.parse(
      (
        await t
          .http()
          .post(`/api/meal-plans/${plan.id}/days/${dayOne().id}/keep`)
          .set(as(user))
          .send({ revision })
          .expect(200)
      ).body,
    );
    expect(kept.kept?.choice).toBe('kept');
    expect(kept.events[0]).toMatchObject({
      cause: 'kept',
      own: true,
      meals: [],
      choice: { before: null, after: 'kept' },
    });
    expect(kept.revision).toBe(revision + 1);

    // Asked from the plan as it was before: another change came meanwhile.
    const late = await t
      .http()
      .post(`/api/meal-plans/${plan.id}/days/${dayOne().id}/keep`)
      .set(as(user))
      .send({ revision })
      .expect(409);
    expect(late.body.error).toBe('PLAN_CHANGED');

    const portions = await scales();
    await plans.setEaten(user.id, 'en', plan.id, dayOne().meals[1]!.id, true, TODAY);
    expect(await scales()).toEqual(portions);
    expect((await history()).kept?.choice).toBe('kept');
  });

  it('keeps the latest changes of a day, as many as it keeps', async () => {
    const meal = dayOne().meals[0]!;
    for (let mark = 0; mark < MAX_DAY_EVENTS + 2; mark += 1)
      await plans.setEaten(user.id, 'en', plan.id, meal.id, mark % 2 === 0, TODAY);

    const day = await history();
    expect(day.events).toHaveLength(MAX_DAY_EVENTS);
    // The last mark took the meal's off: the latest first.
    expect(day.events[0]!.cause).toBe('not-eaten');
    expect(await t.prisma.planDayEvent.count({ where: { dayId: dayOne().id } })).toBe(
      MAX_DAY_EVENTS,
    );
  });

  it("is nobody else's to read or to keep", async () => {
    const other = await aUser(t);

    const read = await t
      .http()
      .get(`/api/meal-plans/${plan.id}/days/${dayOne().id}/history`)
      .set(as(other))
      .expect(404);
    expect(read.body.error).toBe('DAY_NOT_FOUND');
    await t
      .http()
      .post(`/api/meal-plans/${plan.id}/days/${dayOne().id}/keep`)
      .set(as(other))
      .send({ revision: plan.revision })
      .expect(404);
    expect(await t.prisma.planDayEvent.count()).toBe(0);
  });

  it('tells in the answer to a change the lists it made stop matching their plan, once', async () => {
    await offTarget();
    const list = await t.app.get(ShoppingListsService).generate(user.id, 'en', {
      planId: plan.id,
      fromDate: TODAY,
      toDate: plan.days.at(-1)!.date,
    });

    const sized = await sizeDayOne();

    expect(sized.effects).toEqual({
      lists: [
        {
          id: list.id,
          planId: plan.id,
          profileId: plan.profileId,
          fromDate: list.fromDate,
          toDate: list.toDate,
          householdId: null,
        },
      ],
      thaw: [],
      freeze: [],
    });
    expect((await history()).events[0]!.effects.lists).toHaveLength(1);
    // A list that no longer matched is no news the next time.
    await t.prisma.plannedMeal.update({
      where: { id: dayOne().meals[1]!.id },
      data: { quantityScale: 1.8 },
    });
    expect((await sizeDayOne()).effects).toBeNull();
  });
});
