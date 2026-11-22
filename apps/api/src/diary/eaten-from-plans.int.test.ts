// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import {
  GeneratePlanRequest,
  MAX_DIARY_ENTRIES_KEPT,
  type DiaryDay,
  type MealPlan,
  type PlanCalendar,
  type Profile,
  type WeekSummary,
} from '@diet-app/shared';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PlanGenerationService } from '../meal-plans/plan-generation.service.js';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { plansTodayIs } from '../testing/plans-today.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

/**
 * What a person ate from a plan is theirs, not the plan's: it counts on its day whichever plan it came
 * from, and it stays in the diary when the plan goes. The paths that delete the row of a meal marked
 * eaten, and what each keeps:
 *
 * - the plan removed, or the plan made together with another removed: a removal of something else that
 *   takes the meal along, so the meal is written into the diary as an entry of its day;
 * - the meal taken off its day, or a day made again with the meals marked eaten let go: the person's own
 *   removal of that meal, so nothing of it is kept;
 * - a day set to fewer meals: an eaten meal stays on its day;
 * - the profile or the account removed: the diary goes with them.
 */
describe('what was eaten from a plan', () => {
  let t: TestApp;
  let user: TestUser;
  let profile: Profile;

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
  const diaryOf = async (date: string, of: Profile = profile): Promise<DiaryDay> =>
    (await t.http().get(`/api/diary/day?profileId=${of.id}&date=${date}`).set(as(user)).expect(200))
      .body as DiaryDay;
  /** What every reader of a day takes from the diary: what was eaten, its label figures, the limits they cross. */
  const eatenOf = (day: DiaryDay) => ({
    eaten: day.eaten,
    eatenLabel: day.eatenLabel,
    labelNotes: day.labelNotes,
    estimated: day.estimated,
  });
  const weekTo = async (to: string): Promise<WeekSummary> =>
    (
      await t
        .http()
        .get(`/api/diary/week?profileId=${profile.id}&to=${to}`)
        .set(as(user))
        .expect(200)
    ).body as WeekSummary;
  const calendarOf = async (from: string, to: string): Promise<PlanCalendar> =>
    (
      await t
        .http()
        .get(`/api/meal-plans/calendar?profileId=${profile.id}&from=${from}&to=${to}`)
        .set(as(user))
        .expect(200)
    ).body as PlanCalendar;
  const eat = (planId: string, mealId: string) =>
    t
      .http()
      .patch(`/api/meal-plans/${planId}/meals/${mealId}/eaten`)
      .set(as(user))
      .send({ eaten: true })
      .expect(200);
  const remove = (planId: string) => t.http().delete(`/api/meal-plans/${planId}`).set(as(user));
  const exported = async (): Promise<{ diary: { date: string; name: string }[] }> =>
    JSON.parse(
      (
        await t
          .http()
          .get('/api/users/me/export')
          .set(as(user))
          .buffer(true)
          .parse((res, done) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (piece: string) => (body += piece));
            res.on('end', () => done(null, body));
          })
          .expect(200)
      ).body as string,
    ) as { diary: { date: string; name: string }[] };

  it('stays in the diary as entries of its days once the plan is removed: the days, the week and the file read the same', async () => {
    const plan = await aPlan(t, user, profile, { durationDays: 3 });
    // The plan's first two days have passed, eaten whole.
    plansTodayIs(plan.days[2]!.date);
    const eatenDays = plan.days.slice(0, 2);
    for (const day of eatenDays) for (const meal of day.meals) await eat(plan.id, meal.id);
    const before = await Promise.all(
      eatenDays.map(async (day) => eatenOf(await diaryOf(day.date))),
    );
    const week = await weekTo(plan.days[2]!.date);
    expect(week.counted).toBe(2);
    expect(before.every((day) => day.eaten.calories > 0)).toBe(true);

    await remove(plan.id).expect(204);

    const after = await Promise.all(eatenDays.map(async (day) => eatenOf(await diaryOf(day.date))));
    expect(after).toEqual(before);
    for (const day of eatenDays) {
      const read = await diaryOf(day.date);
      expect(read.plan).toBeNull();
      // One entry for each meal eaten, under the meal it was planned for.
      expect(read.entries.map((entry) => entry.mealType).sort()).toEqual(
        day.meals.map((meal) => meal.mealType).sort(),
      );
    }
    // The week counts the same days with the same figures; what they aimed at is the profile's now, with no plan.
    const weekAfter = await weekTo(plan.days[2]!.date);
    expect([weekAfter.counted, weekAfter.eaten]).toEqual([week.counted, week.eaten]);
    const file = await exported();
    expect(file.diary).toHaveLength(eatenDays.flatMap((day) => day.meals).length);
  });

  it("counts what an older plan had eaten on a day in the diary's day and in the newer plan's day, before the older plan goes and after", async () => {
    const older = await aPlan(t, user, profile, { durationDays: 2 });
    const breakfast = older.days[0]!.meals.find((meal) => meal.mealType === 'breakfast')!;
    await eat(older.id, breakfast.id);
    const newer = await aPlan(t, user, profile, { durationDays: 2 });
    const date = older.days[0]!.date;

    const diary = await diaryOf(date);
    expect(diary.plan!.id).toBe(newer.id);
    expect(diary.otherPlans.map((meal) => [meal.planId, meal.id, meal.eaten])).toEqual([
      [older.id, breakfast.id, true],
    ]);
    // Nothing of the newer plan is eaten: what the day ate is the older plan's breakfast.
    expect(diary.eaten).toEqual(diary.otherPlans[0]!.nutrition);
    const day = (await read(newer.id)).days[0]!;
    expect(day.diary!.otherPlans.map((meal) => meal.id)).toEqual([breakfast.id]);
    expect(day.diary!.nutrition).toEqual(diary.otherPlans[0]!.nutrition);
    expect(day.diary!.entries).toBe(0);
    const calendar = await calendarOf(date, date);

    await remove(older.id).expect(204);

    expect(eatenOf(await diaryOf(date))).toEqual(eatenOf(diary));
    const after = (await read(newer.id)).days[0]!;
    expect(after.diary!.nutrition).toEqual(day.diary!.nutrition);
    expect(after.diary!.otherPlans).toEqual([]);
    expect(after.diary!.entries).toBe(1);
    expect(after.dayNutrition).toEqual(day.dayNutrition);
    expect(after.calorieDelta).toBe(day.calorieDelta);
    expect(after.offTarget).toBe(day.offTarget);
    // The calendar's day: the same figures, of one plan now.
    const shown = calendar.days[0]!;
    const shownAfter = (await calendarOf(date, date)).days[0]!;
    expect({ ...shownAfter, plans: shown.plans }).toEqual(shown);
    expect(shownAfter.plans).toBe(1);
  });

  it("sizes the newer plan's day of today again once a meal of the older plan is marked eaten on it, as an entry of the diary does", async () => {
    const older = await aPlan(t, user, profile, { durationDays: 2 });
    const newer = await aPlan(t, user, profile, { durationDays: 2 });
    const before = (await read(newer.id)).days[0]!;
    const planned = (day: MealPlan['days'][number]) =>
      day.meals.reduce((sum, meal) => sum + meal.nutrition.calories, 0);

    await eat(older.id, older.days[0]!.meals.find((meal) => meal.mealType === 'breakfast')!.id);

    const after = await read(newer.id);
    // Its meals make room for the breakfast eaten from the older plan.
    expect(planned(after.days[0]!)).toBeLessThan(planned(before));
    expect(after.days[0]!.diary!.otherPlans).toHaveLength(1);
  });

  it('keeps of two plans made together only what was eaten from the one removed', async () => {
    const ewa = await aProfile(t, user, {
      name: 'Ewa',
      sex: 'female',
      heightCm: 165,
      weightKg: 60,
    });
    const hers = await t.app.get(PlanGenerationService).generate(
      user.id,
      'en',
      GeneratePlanRequest.parse({
        profileId: ewa.id,
        withProfileId: profile.id,
        startDate: '2026-01-05',
        durationDays: 2,
      }),
    );
    const date = hers.days[0]!.date;
    const lunch = hers.days[0]!.meals.find((meal) => meal.mealType === 'lunch')!;
    await eat(hers.id, lunch.id);
    const before = await diaryOf(date, ewa);

    await remove(hers.id).expect(204);

    const after = await diaryOf(date, ewa);
    expect(eatenOf(after)).toEqual(eatenOf(before));
    expect(after.entries).toHaveLength(1);
    expect(after.entries[0]!.mealType).toBe('lunch');
    // His plan stays, and his diary holds nothing he did not eat.
    const his = await diaryOf(date);
    expect(his.plan!.id).toBe(hers.joint!.planId);
    expect(his.entries).toEqual([]);
  });

  it('refuses the removal where a day would hold more entries than a day holds at all, and names the day', async () => {
    const plan = await aPlan(t, user, profile, { durationDays: 1 });
    const date = plan.days[0]!.date;
    for (const meal of plan.days[0]!.meals) await eat(plan.id, meal.id);
    const eaten = plan.days[0]!.meals.length;
    // Written into the diary before: one entry short of what the eaten meals need beside it.
    const planted = (count: number) =>
      t.prisma.diaryEntry.createMany({
        data: Array.from({ length: count }, (_, n) => ({
          profileId: profile.id,
          date: new Date(date),
          mealType: 'snack',
          kind: 'meal' as const,
          name: `Snack ${n}`,
          calories: 10,
          protein: 0,
          fat: 0,
          carbs: 2,
        })),
      });
    await planted(MAX_DIARY_ENTRIES_KEPT - eaten + 1);

    const refused = await remove(plan.id).expect(409);
    expect(refused.body).toMatchObject({ error: 'PLAN_DIARY_FULL', details: { date } });
    await read(plan.id);

    // One entry fewer, and the day holds all of it.
    const one = await t.prisma.diaryEntry.findFirstOrThrow({ where: { profileId: profile.id } });
    await t.prisma.diaryEntry.delete({ where: { id: one.id } });
    await remove(plan.id).expect(204);
    expect((await diaryOf(date)).entries).toHaveLength(MAX_DIARY_ENTRIES_KEPT);
  });

  it('keeps nothing of a meal eaten that is taken off its day: the person removed that meal itself', async () => {
    const plan = await aPlan(t, user, profile, { durationDays: 1 });
    const date = plan.days[0]!.date;
    const lunch = plan.days[0]!.meals.find((meal) => meal.mealType === 'lunch')!;
    await eat(plan.id, lunch.id);
    await t.http().delete(`/api/meal-plans/${plan.id}/meals/${lunch.id}`).set(as(user)).expect(200);

    await remove(plan.id).expect(204);

    const day = await diaryOf(date);
    expect(day.entries).toEqual([]);
    expect(day.eaten.calories).toBe(0);
  });

  it("copies a day's eaten meals with the figures the day counted for them, eggs taken whole among them", async () => {
    const plan = await aPlan(t, user, profile, { durationDays: 1 });
    const date = plan.days[0]!.date;
    const breakfast = plan.days[0]!.meals.find((meal) => meal.mealType === 'breakfast')!;
    // A serving and three quarters of eggs on toast: 5.25 eggs, cooked as five.
    const eggs = await t.prisma.recipe.findUniqueOrThrow({
      where: { slug: 'scrambled-eggs-on-toast' },
    });
    await t.prisma.plannedMeal.update({
      where: { id: breakfast.id },
      data: {
        recipeId: eggs.id,
        servings: 1.75,
        quantityScale: 1,
        source: 'CATALOGUE',
        plate: Prisma.DbNull,
      },
    });
    for (const meal of plan.days[0]!.meals) await eat(plan.id, meal.id);
    const from = await diaryOf(date);
    // A day no plan holds, of the year back the diary takes.
    const to = '2026-01-10';

    await t
      .http()
      .post('/api/diary/copy')
      .set(as(user))
      .send({ profileId: profile.id, from: date, to })
      .expect(201);

    expect(eatenOf(await diaryOf(to))).toEqual(eatenOf(from));
  });
});
