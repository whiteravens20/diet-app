// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import {
  dayAfter,
  ProfileInput,
  type ChangedPlan,
  type MealPlan,
  type Profile,
} from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { MealPlansService } from './meal-plans.service.js';

describe("a running plan, once its profile's number of meals a day moved", () => {
  let t: TestApp;
  let user: TestUser;
  let profile: Profile;
  // The server's day, which a client may name as its own.
  const today = new Date().toISOString().slice(0, 10);
  const from = dayAfter(today, -2);
  const aWeek = { startDate: from, durationDays: 7 };

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
    profile = await aProfile(t, user, { age: 37, heightCm: 190, weightKg: 91, mealCount: 3 });
  });

  const http = () => t.http();
  const made = async (request: Record<string, unknown>, of = profile): Promise<MealPlan> =>
    (
      await http()
        .post('/api/meal-plans/generate')
        .set(as(user))
        .set('X-Client-Date', today)
        .send({ profileId: of.id, ...request })
        .expect(201)
    ).body;
  const read = async (plan: { id: string }): Promise<MealPlan> =>
    (
      await http()
        .get(`/api/meal-plans/${plan.id}`)
        .set(as(user))
        .set('X-Client-Date', today)
        .expect(200)
    ).body;
  const save = (of: Profile, change: Record<string, unknown>) =>
    http()
      .put(`/api/profiles/${of.id}`)
      .set(as(user))
      .send({ ...ProfileInput.parse(of), ...change })
      .expect(200);
  /** "Uzupełnij lub odejmij". */
  const take = async (plan: MealPlan): Promise<ChangedPlan> =>
    (
      await http()
        .post(`/api/meal-plans/${plan.id}/meal-count`)
        .set(as(user))
        .set('X-Client-Date', today)
        .send({ revision: plan.revision })
        .expect(200)
    ).body;
  /** Of each meal of a day, its time of day and its dish. */
  const dishes = (day: MealPlan['days'][number]) =>
    Object.fromEntries(day.meals.map((meal) => [meal.mealType, meal.recipe?.id ?? null]));

  it("says that the profile's number moved, and adds the time of day it adds from today with every dish staying", async () => {
    const own = dayAfter(today, 2);
    const before = await made({ ...aWeek, dayOverrides: [{ date: own, mealCount: 3 }] });
    expect(before.mealCountMoved).toBeNull();

    await save(profile, { mealCount: 4 });
    const told = await read(before);
    expect(told.mealCountMoved).toEqual({ profileCount: 4, planCount: 3 });
    // The day of its own number holds portions the user chose: it keeps them, and the choice.
    const ownDay = told.days.find((day) => day.date === own)!;
    await t.prisma.mealPlanDay.update({
      where: { id: ownDay.id },
      data: { keptChoice: 'kept', keptAt: new Date() },
    });
    await t.prisma.plannedMeal.update({
      where: { id: ownDay.meals[0]!.id },
      data: { quantityScale: 1.37 },
    });

    const after = await take(told);
    const kept = await t.prisma.mealPlanDay.findUniqueOrThrow({
      where: { id: ownDay.id },
      select: { keptChoice: true, meals: { select: { id: true, quantityScale: true } } },
    });
    expect(kept.keptChoice).toBe('kept');
    expect(kept.meals.find((meal) => meal.id === ownDay.meals[0]!.id)!.quantityScale).toBe(1.37);
    expect(after.mealCountMoved).toBeNull();
    for (const [index, day] of after.days.entries()) {
      const was = dishes(told.days[index]!);
      // A day gone, and a day of its own number, stay as they were.
      if (day.date < today || day.date === own) {
        expect(dishes(day), day.date).toEqual(was);
        continue;
      }
      // The day adds the snack, its other dishes staying, and is sized again to its target.
      const now = dishes(day);
      expect(Object.keys(now).sort(), day.date).toEqual(['breakfast', 'dinner', 'lunch', 'snack']);
      expect({ breakfast: now.breakfast, lunch: now.lunch, dinner: now.dinner }, day.date).toEqual(
        was,
      );
      expect(now.snack, day.date).not.toBeNull();
      expect(day.offTarget, day.date).toBeNull();
    }
  });

  it('takes away the time of day the new number drops, a dish of it eaten staying', async () => {
    profile = await aProfile(t, user, {
      name: 'Four',
      age: 37,
      heightCm: 190,
      weightKg: 91,
      mealCount: 4,
    });
    const before = await made(aWeek);
    const snack = before.days
      .find((day) => day.date === today)!
      .meals.find((meal) => meal.mealType === 'snack')!;
    await http()
      .patch(`/api/meal-plans/${before.id}/meals/${snack.id}/eaten`)
      .set(as(user))
      .set('X-Client-Date', today)
      .send({ eaten: true })
      .expect(200);

    await save(profile, { mealCount: 3 });
    const told = await read(before);
    expect(told.mealCountMoved).toEqual({ profileCount: 3, planCount: 4 });

    const after = await take(told);
    expect(after.mealCountMoved).toBeNull();
    for (const [index, day] of after.days.entries()) {
      const was = dishes(told.days[index]!);
      if (day.date < today) {
        expect(dishes(day), day.date).toEqual(was);
        continue;
      }
      // Today keeps its snack, eaten; the other days lose theirs, every other dish staying.
      const kept = Object.fromEntries(
        Object.entries(was).filter(([slot]) => day.date === today || slot !== 'snack'),
      );
      expect(dishes(day), day.date).toEqual(kept);
    }
  });

  it('says nothing of a number asked for the plan, and follows the profile once its number is taken', async () => {
    const plan = await made({ ...aWeek, mealCount: 3 });
    await save(profile, { mealCount: 4 });
    const told = await read(plan);
    expect(told.mealCountMoved).toBeNull();

    // Taken all the same, the days from today get four, and a day made again by itself as well.
    const after = await take(told);
    const tomorrow = dayAfter(today, 1);
    expect(after.days.find((day) => day.date === tomorrow)!.meals).toHaveLength(4);
    const again = (
      await http()
        .post(`/api/meal-plans/${plan.id}/regenerate`)
        .set(as(user))
        .set('X-Client-Date', today)
        .send({ from: tomorrow, to: tomorrow })
        .expect(201)
    ).body as MealPlan;
    expect(again.days.find((day) => day.date === tomorrow)!.meals).toHaveLength(4);
  });

  it('gives a time of day the other plan of a joint plan holds a dish at that dish, the two one shared meal', async () => {
    // Paweł eats four meals a day, Ewa three: his snack is his alone.
    await save(profile, { name: 'Paweł', mealCount: 4 });
    const pawel = profile;
    const ewa = await aProfile(t, user, {
      name: 'Ewa',
      sex: 'female',
      age: 36,
      heightCm: 168,
      weightKg: 62,
      mealCount: 3,
    });
    const his = await aPlan(t, user, pawel, { ...aWeek, withProfileId: ewa.id });
    const hers = await read({ id: his.joint!.planId });
    expect(hers.days.every((day) => day.meals.every((meal) => meal.mealType !== 'snack'))).toBe(
      true,
    );

    await save(ewa, { mealCount: 4 });
    // Each day sized is sized with its snack linked already: the plates and toppings of a shared meal are chosen so.
    const plans = t.app.get(MealPlansService);
    const real = plans.rebalanceDayInternal.bind(plans);
    const sized: { dayId: string; linked: boolean }[] = [];
    vi.spyOn(plans, 'rebalanceDayInternal').mockImplementation(async (dayId, tx, at, named) => {
      const snack = await tx.plannedMeal.findFirst({
        where: { dayId, mealType: 'snack' },
        select: { sharedMealId: true },
      });
      sized.push({ dayId, linked: snack?.sharedMealId != null });
      return real(dayId, tx, at, named);
    });
    const after = await take(await read(hers));
    vi.restoreAllMocks();
    const histNow = await read(his);
    for (const day of after.days.filter((one) => one.date >= today)) {
      const herSnack = day.meals.find((meal) => meal.mealType === 'snack')!;
      const hisSnack = histNow.days
        .find((one) => one.date === day.date)!
        .meals.find((meal) => meal.mealType === 'snack')!;
      expect(herSnack.recipe?.id, day.date).toBe(hisSnack.recipe?.id);
      expect(herSnack.shared?.with.mealId, day.date).toBe(hisSnack.id);
      // Both days were sized with the two linked: hers, and his, whose snack is shared now.
      const hisDay = histNow.days.find((one) => one.date === day.date)!;
      expect(sized, day.date).toContainEqual({ dayId: day.id, linked: true });
      expect(sized, day.date).toContainEqual({ dayId: hisDay.id, linked: true });
    }
    expect(sized.every((one) => one.linked)).toBe(true);
  });
});
