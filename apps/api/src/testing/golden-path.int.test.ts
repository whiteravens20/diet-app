// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { MealPlan, RebalanceResult, ShoppingList } from '@diet-app/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedCatalogue } from './catalogue.js';
import { resetDatabase } from './database.js';
import { createTestApp, type TestApp } from './test-app.js';

describe('a new account, from sign-up to deletion', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
  });

  afterAll(async () => {
    await t.close();
  });

  it('answers the health probe with the database up', async () => {
    const res = await t.http().get('/api/health').expect(200);
    expect(res.body).toMatchObject({ status: 'ok', db: 'up' });
  });

  it('registers, plans a week, swaps a meal, builds a shopping list and deletes the account', async () => {
    const password = 'Golden-Path-Passw0rd';
    const registered = await t
      .http()
      .post('/api/auth/register')
      .send({ email: 'golden.path@example.test', password, displayName: 'Golden' })
      .expect(201);
    const auth = { Authorization: `Bearer ${registered.body.tokens.accessToken}` };

    const profile = await t
      .http()
      .post('/api/profiles')
      .set(auth)
      .send({ name: 'Me', age: 30, sex: 'female', heightCm: 168, weightKg: 64 })
      .expect(201);

    const generated = await t
      .http()
      .post('/api/meal-plans/generate')
      .set(auth)
      .send({ profileId: profile.body.id, startDate: '2026-01-05', durationDays: 7 })
      .expect(201);
    const plan = generated.body as MealPlan;
    expect(plan.days.map((day) => day.date)).toEqual([
      '2026-01-05',
      '2026-01-06',
      '2026-01-07',
      '2026-01-08',
      '2026-01-09',
      '2026-01-10',
      '2026-01-11',
    ]);
    for (const day of plan.days) {
      expect(day.meals.map((meal) => meal.mealType)).toEqual(['breakfast', 'lunch', 'dinner']);
      expect(day.dayNutrition.calories).toBeGreaterThan(0);
    }

    const first = plan.days[0]!.meals[0]!;
    const swapped = await t
      .http()
      .post('/api/meal-plans/swap-meal')
      .set(auth)
      .send({ planId: plan.id, plannedMealId: first.id, strategy: 'random' })
      .expect(201);
    const replaced = (swapped.body as RebalanceResult).plan.days[0]!.meals.find((meal) => meal.id === first.id)!;
    expect(replaced.recipe!.id).not.toBe(first.recipe!.id);
    expect(replaced.mealType).toBe('breakfast');

    const list = await t.http().post('/api/shopping-lists/generate').set(auth).send({ planId: plan.id }).expect(201);
    const items = (list.body as ShoppingList).groups.flatMap((group) => group.items);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.totalQuantity > 0)).toBe(true);

    await t.http().delete('/api/users/me').set(auth).send({ currentPassword: password }).expect(204);
    await t
      .http()
      .post('/api/auth/login')
      .send({ email: 'golden.path@example.test', password })
      .expect(401);
    expect(await t.prisma.user.count()).toBe(0);
    expect(await t.prisma.mealPlan.count()).toBe(0);
    expect(await t.prisma.shoppingList.count()).toBe(0);
  });
});
