// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { dayAfter, type MealPlan, type Profile } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

describe('how the dishes both people of a plan made together eat are cooked', () => {
  let t: TestApp;
  let user: TestUser;
  let me: Profile;
  let ewa: Profile;
  // The server's day, which a client may name as its own.
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = dayAfter(today, -1);
  const tomorrow = dayAfter(today, 1);

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
    me = await aProfile(t, user);
    ewa = await aProfile(t, user, { name: 'Ewa', sex: 'female', heightCm: 165, weightKg: 60 });
  });

  const http = () => t.http();
  const read = async (planId: string): Promise<MealPlan> =>
    (
      await http()
        .get(`/api/meal-plans/${planId}`)
        .set(as(user))
        .set('X-Client-Date', today)
        .expect(200)
    ).body;
  const cookApart = (planId: string, body: object, expected = 200) =>
    http()
      .patch(`/api/meal-plans/${planId}/cook-apart`)
      .set(as(user))
      .set('X-Client-Date', today)
      .send(body)
      .expect(expected);
  /** How each shared meal of a day of the plan is cooked: apart or not. */
  const apartOn = (plan: MealPlan, date: string) =>
    plan.days
      .find((day) => day.date === date)!
      .meals.flatMap((meal) => (meal.shared ? [meal.shared.apart] : []));
  const together = (overrides: Record<string, unknown> = {}) =>
    aPlan(t, user, me, {
      startDate: yesterday,
      durationDays: 3,
      withProfileId: ewa.id,
      ...overrides,
    });

  it('cooks them apart once the plan is made, unless it is asked for in one pot', async () => {
    const apart = await together();
    expect(apart.joint?.cookApart).toBe(true);
    // The list of the other person's plans says so as well.
    const listed = (
      await http().get(`/api/meal-plans?profileId=${ewa.id}`).set(as(user)).expect(200)
    ).body as { items: { joint: { cookApart: boolean } | null }[] };
    expect(listed.items.map((one) => one.joint?.cookApart)).toEqual([true]);
    for (const day of apart.days) {
      expect(apartOn(apart, day.date).length, day.date).toBeGreaterThan(0);
      expect(apartOn(apart, day.date), day.date).not.toContain(false);
    }

    await t.prisma.mealPlan.deleteMany({ where: { profileId: { in: [me.id, ewa.id] } } });
    const onePot = await together({ cookApart: false });
    expect(onePot.joint?.cookApart).toBe(false);
    for (const day of onePot.days) expect(apartOn(onePot, day.date), day.date).not.toContain(true);
  });

  it('cooks them in one pot from today, a day gone and a meal eaten staying, and a dish shared later as well', async () => {
    const plan = await together();
    // Ewa ate her portion of a shared meal of today: it was cooked as it was.
    const eaten = plan.days
      .find((day) => day.date === today)!
      .meals.find((meal) => meal.shared !== null)!;
    await http()
      .patch(
        `/api/meal-plans/${eaten.shared!.with.planId}/meals/${eaten.shared!.with.mealId}/eaten`,
      )
      .set(as(user))
      .set('X-Client-Date', today)
      .send({ eaten: true })
      .expect(200);

    const after = (await cookApart(plan.id, { apart: false })).body as MealPlan;
    expect(after.joint?.cookApart).toBe(false);
    expect(apartOn(after, yesterday)).not.toContain(false);
    for (const meal of after.days
      .find((day) => day.date === today)!
      .meals.filter((one) => one.shared))
      expect(meal.shared!.apart, meal.mealType).toBe(meal.id === eaten.id);
    expect(apartOn(after, tomorrow)).not.toContain(true);
    // The other plan says the same of each.
    const hers = await read(plan.joint!.planId);
    expect(hers.joint?.cookApart).toBe(false);
    expect(apartOn(hers, tomorrow)).not.toContain(true);

    // Tomorrow made again for both: its shared dishes are new ones, and in one pot.
    const again = (
      await http()
        .post(`/api/meal-plans/${plan.id}/regenerate`)
        .set(as(user))
        .set('X-Client-Date', today)
        .send({ from: tomorrow, to: tomorrow, forAll: true })
        .expect(201)
    ).body as MealPlan;
    expect(apartOn(again, tomorrow).length).toBeGreaterThan(0);
    expect(apartOn(again, tomorrow)).not.toContain(true);
  });

  it('cooks them in one pot on one day alone, the whole plan as it was', async () => {
    const plan = await together();

    const after = (await cookApart(plan.id, { apart: false, date: tomorrow })).body as MealPlan;
    expect(after.joint?.cookApart).toBe(true);
    expect(apartOn(after, tomorrow)).not.toContain(true);
    expect(apartOn(after, today)).not.toContain(false);
  });

  it('answers a plan made alone as one that shares no meal', async () => {
    const alone = await aPlan(t, user, me, { startDate: today, durationDays: 1 });
    expect(alone.joint).toBeNull();
    expect((await cookApart(alone.id, { apart: true }, 404)).body.error).toBe('MEAL_NOT_FOUND');
  });
});
