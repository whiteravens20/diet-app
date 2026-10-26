// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { MealPlan, Profile } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

describe('what a request about a plan may say', () => {
  let t: TestApp;
  let user: TestUser;
  let profile: Profile;
  let lunch: string;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
    lunch = (
      await t.prisma.recipe.findFirstOrThrow({
        where: { createdByUserId: null, mealTypes: { has: 'lunch' } },
      })
    ).id;
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await resetUserData(t.prisma);
    user = await aUser(t);
    profile = await aProfile(t, user);
  });

  const generate = (body: Record<string, unknown>) =>
    t
      .http()
      .post('/api/meal-plans/generate')
      .set(as(user))
      .send({ profileId: profile.id, startDate: '2026-03-02', durationDays: 3, ...body });
  const refusedAt = async (res: {
    status: number;
    body: { error?: string; issues?: { path: string }[] };
  }): Promise<string[]> => {
    expect([res.status, res.body.error]).toEqual([400, 'VALIDATION_FAILED']);
    return [...new Set((res.body.issues ?? []).map((issue) => issue.path))];
  };

  describe('a new plan', () => {
    it.each([
      ['in the year 9999', { startDate: '9999-12-25', durationDays: 7 }, ['startDate']],
      ['in the year 0', { startDate: '0000-01-01' }, ['startDate']],
      ['before 2000', { startDate: '1999-12-31' }, ['startDate']],
      ['that would run past 2100', { startDate: '2100-12-20', durationDays: 28 }, ['durationDays']],
      ['on a day there is not', { startDate: '2026-02-30' }, ['startDate']],
      ['of twenty-nine days', { durationDays: 29 }, ['durationDays']],
    ])('is refused %s, and none is made', async (_name, body, parts) => {
      expect(await refusedAt(await generate(body))).toEqual(parts);
      expect(await t.prisma.mealPlan.count()).toBe(0);
    });

    it('is made on the last days there are', async () => {
      const plan: MealPlan = (
        await generate({ startDate: '2100-12-30', durationDays: 2 }).expect(201)
      ).body;

      expect(plan.days.map((day) => day.date)).toEqual(['2100-12-30', '2100-12-31']);
      // And it can be read, listed and deleted like any other.
      await t.http().get(`/api/meal-plans/${plan.id}`).set(as(user)).expect(200);
      expect(
        (
          await t
            .http()
            .get('/api/meal-plans')
            .query({ profileId: profile.id })
            .set(as(user))
            .expect(200)
        ).body.total,
      ).toBe(1);
      await t.http().delete(`/api/meal-plans/${plan.id}`).set(as(user)).expect(204);
    });

    it.each([
      [
        'names a day twice',
        [
          { date: '2026-03-03', mealCount: 2 },
          { date: '2026-03-03', mealCount: 4 },
        ],
        ['dayOverrides.1.date'],
      ],
      [
        'names a day that is no day of the plan',
        [{ date: '2026-03-05', mealCount: 2 }],
        ['dayOverrides.0.date'],
      ],
      [
        'locks a meal of a day it skips',
        [
          {
            date: '2026-03-03',
            skip: true,
            lockedSlots: [{ mealType: 'lunch', recipeId: '00000000-0000-4000-8000-000000000000' }],
          },
        ],
        ['dayOverrides.0.lockedSlots'],
      ],
      [
        'locks one meal of a day twice',
        [
          {
            date: '2026-03-03',
            lockedSlots: [
              { mealType: 'lunch', recipeId: '00000000-0000-4000-8000-000000000001' },
              { mealType: 'lunch', recipeId: '00000000-0000-4000-8000-000000000002' },
            ],
          },
        ],
        ['dayOverrides.0.lockedSlots.1.mealType'],
      ],
      [
        'says something of more days than a plan can have',
        Array.from({ length: 29 }, (_, i) => ({
          date: `2026-03-${String(i + 1).padStart(2, '0')}`,
          mealCount: 2,
        })),
        ['dayOverrides'],
      ],
    ])('is refused when what it says of single days %s', async (_name, dayOverrides, parts) => {
      expect((await refusedAt(await generate({ dayOverrides }))).slice(0, 1)).toEqual(parts);
      expect(await t.prisma.mealPlan.count()).toBe(0);
    });

    it('takes a skipped day and a locked meal on another, each once', async () => {
      const plan: MealPlan = (
        await generate({
          dayOverrides: [
            { date: '2026-03-02', skip: true },
            { date: '2026-03-03', lockedSlots: [{ mealType: 'lunch', recipeId: lunch }] },
          ],
        }).expect(201)
      ).body;

      expect(plan.days[0]).toMatchObject({ skipped: true, meals: [] });
      expect(plan.days[1]!.meals.find((meal) => meal.mealType === 'lunch')!.recipe!.id).toBe(lunch);
    });
  });

  describe('a plan there is', () => {
    let plan: MealPlan;

    beforeEach(async () => {
      plan = await aPlan(t, user, profile, { startDate: '2026-03-02', durationDays: 2 });
    });

    const rebalance = (body: Record<string, unknown>) =>
      t.http().post(`/api/meal-plans/${plan.id}/rebalance`).set(as(user)).send(body);
    const customMeal = (date: string, body: Record<string, unknown>) =>
      t.http().post(`/api/meal-plans/${plan.id}/days/${date}/custom-meal`).set(as(user)).send(body);
    const meal = () => plan.days[0]!.meals[0]!;
    const scaleOf = async (id: string): Promise<number> =>
      (await t.prisma.plannedMeal.findUniqueOrThrow({ where: { id } })).quantityScale;

    it('is rebalanced for a day only when the day is named', async () => {
      expect(await refusedAt(await rebalance({ scope: 'day' }))).toEqual(['date']);
      expect(await refusedAt(await rebalance({ scope: 'day', date: '2026-02-30' }))).toEqual([
        'date',
      ]);
      expect((await rebalance({ scope: 'day', date: '2026-03-09' }).expect(404)).body.error).toBe(
        'DAY_NOT_FOUND',
      );
      await rebalance({ scope: 'day', date: '2026-03-02' }).expect(201);
    });

    it('has a rebalance undone meal by meal, each once', async () => {
      const twice = await rebalance({
        scope: 'day',
        restore: [
          { mealId: meal().id, scale: 1 },
          { mealId: meal().id, scale: 1.2 },
        ],
      });

      expect(await refusedAt(twice)).toEqual(['restore']);
      expect(await scaleOf(meal().id)).toBe(1);
    });

    it('does not take more entries of an undo than a plan has meals', async () => {
      const many = Array.from({ length: 141 }, (_, i) => ({
        mealId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        scale: 1,
      }));

      expect(await refusedAt(await rebalance({ scope: 'day', restore: many }))).toEqual([
        'restore',
      ]);
    });

    it('does not take an undo that would leave a meal outside what a meal can hold', async () => {
      const servings = meal().servings;

      for (const scale of [0, 0.4 / servings, 3.2 / servings]) {
        const refused = await rebalance({
          scope: 'day',
          restore: [{ mealId: meal().id, scale }],
        }).expect(400);
        expect(refused.body.error).toBe('SCALE_OUT_OF_RANGE');
      }
      expect(
        await refusedAt(
          await rebalance({ scope: 'day', restore: [{ mealId: meal().id, scale: 11 }] }),
        ),
      ).toEqual(['restore.0.scale']);
      expect(await scaleOf(meal().id)).toBe(1);

      await rebalance({ scope: 'day', restore: [{ mealId: meal().id, scale: 1 }] }).expect(201);
    });

    it.each([
      ['on a day that is no date', 'tomorrow', {}, ['date']],
      ['on a day there is not', '2026-02-30', {}, ['date']],
      [
        'of six thousand calories',
        '2026-03-02',
        { nutrition: { calories: 6000, protein: 10, fat: 10, carbs: 10 } },
        ['nutrition.calories'],
      ],
      [
        'with more protein than a serving can hold',
        '2026-03-02',
        { nutrition: { calories: 500, protein: 501, fat: 10, carbs: 10 } },
        ['nutrition.protein'],
      ],
      [
        'with less than nothing',
        '2026-03-02',
        { nutrition: { calories: 500, protein: 10, fat: -1, carbs: 10 } },
        ['nutrition.fat'],
      ],
    ])("does not get a meal of the user's own %s", async (_name, date, over, parts) => {
      const res = await customMeal(date, {
        name: 'Cake',
        mealType: 'snack',
        nutrition: { calories: 300, protein: 4, fat: 12, carbs: 40 },
        ...over,
      });

      expect(await refusedAt(res)).toEqual(parts);
      expect(await t.prisma.plannedMeal.count({ where: { source: 'USER_CUSTOM' } })).toBe(0);
    });

    it("says that a day is not a day of the plan, for a meal of the user's own as for a rebalance", async () => {
      const res = await customMeal('2026-03-09', {
        name: 'Cake',
        mealType: 'snack',
        nutrition: { calories: 300, protein: 4, fat: 12, carbs: 40 },
      }).expect(404);

      expect(res.body.error).toBe('DAY_NOT_FOUND');
    });

    it("is asked for a favourite by the favourite's recipe", async () => {
      const res = await t
        .http()
        .post('/api/meal-plans/swap-meal/preview')
        .set(as(user))
        .send({ planId: plan.id, plannedMealId: meal().id, strategy: 'favorite' });

      expect(await refusedAt(res)).toEqual(['favoriteRecipeId']);
    });

    it('is made again for days that are days: a range that is no date is refused as it comes in', async () => {
      const res = await t
        .http()
        .post(`/api/meal-plans/${plan.id}/regenerate`)
        .set(as(user))
        .send({ from: '2026-13-01' });

      expect(await refusedAt(res)).toEqual(['from']);
    });

    it('is named by an id: what is none is refused before anything is looked up', async () => {
      for (const path of [
        '/api/meal-plans/mine',
        '/api/meal-plans/1',
        `/api/meal-plans/${plan.id}x`,
      ]) {
        expect(await refusedAt(await t.http().get(path).set(as(user)))).toEqual(['id']);
      }
      expect(
        await refusedAt(
          await t
            .http()
            .patch(`/api/meal-plans/${plan.id}/meals/first/eaten`)
            .set(as(user))
            .send({ eaten: true }),
        ),
      ).toEqual(['mealId']);
    });
  });
});
