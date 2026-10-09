// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { AiSwapMealRequest, SwapMealRequest, type MealPlan } from '@diet-app/shared';
import { HttpException } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, as, race, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { MealPlansService } from './meal-plans.service.js';

/** How each request ended: `ok`, or the error code it was refused with. */
function outcomes(results: PromiseSettledResult<unknown>[]): string[] {
  return results
    .map((r) => {
      if (r.status === 'fulfilled') return 'ok';
      const response = r.reason instanceof HttpException ? r.reason.getResponse() : undefined;
      return typeof response === 'object' && response !== null && 'error' in response
        ? String(response.error)
        : `unexpected: ${String(r.reason)}`;
    })
    .sort();
}

describe('editing a plan', () => {
  let t: TestApp;
  let plans: MealPlansService;
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
    t.model.reset();
    user = await aUser(t);
    plan = await aPlan(t, user, await aProfile(t, user));
  });

  afterAll(async () => {
    await t.close();
  });

  const swap = (plannedMealId: string) =>
    plans.swapMeal(user.id, 'en', SwapMealRequest.parse({ planId: plan.id, plannedMealId, strategy: 'random' }));

  it('lets one of two overlapping swaps of a meal through', async () => {
    const meal = plan.days[0]!.meals[0]!;

    const results = await race(2, () => swap(meal.id));

    expect(outcomes(results)).toEqual(['PLAN_CHANGED', 'ok']);
    const after = await plans.get(user.id, 'en', plan.id);
    expect(after.revision).toBe(1);
    expect(after.days[0]!.meals).toHaveLength(3);
    expect(after.days[0]!.meals.find((m) => m.id === meal.id)!.recipe!.id).not.toBe(meal.recipe!.id);
  });

  it('marks a meal eaten once, however often it is asked', async () => {
    const meal = plan.days[0]!.meals[1]!;
    const path = `/api/meal-plans/${plan.id}/meals/${meal.id}/eaten`;

    const first = await t.http().patch(path).set(as(user)).send({ eaten: true }).expect(200);
    const again = await t.http().patch(path).set(as(user)).send({ eaten: true }).expect(200);

    const eatenAt = (body: { plan: MealPlan }) => body.plan.days[0]!.meals.find((m) => m.id === meal.id)!.eatenAt;
    expect(eatenAt(first.body)).not.toBeNull();
    expect(eatenAt(again.body)).toBe(eatenAt(first.body));
    // The repeat changed nothing, so it did not count as a change either.
    expect(again.body.plan.revision).toBe(first.body.plan.revision);

    const undone = await t.http().patch(path).set(as(user)).send({ eaten: false }).expect(200);
    expect(eatenAt(undone.body)).toBeNull();
  });

  it('ends eaten when two requests to mark a meal eaten overlap', async () => {
    const meal = plan.days[1]!.meals[0]!;

    const results = await race(2, () => plans.setEaten(user.id, 'en', plan.id, meal.id, true));

    expect(outcomes(results)).toEqual(['PLAN_CHANGED', 'ok']);
    expect((await t.prisma.plannedMeal.findUniqueOrThrow({ where: { id: meal.id } })).eatenAt).not.toBeNull();
  });

  it('refuses an eaten request that does not say which state is wanted', async () => {
    const meal = plan.days[0]!.meals[0]!;
    await t
      .http()
      .patch(`/api/meal-plans/${plan.id}/meals/${meal.id}/eaten`)
      .set(as(user))
      .send({})
      .expect(400);
  });

  it('keeps the plan whole when a custom meal and a regeneration overlap', async () => {
    const date = plan.days[3]!.date;
    const customMeal = {
      name: 'Birthday cake',
      mealType: 'snack' as const,
      nutrition: { calories: 420, protein: 5, fat: 20, carbs: 55 },
      servings: 1,
    };

    const results = await Promise.allSettled([
      plans.addCustomMeal(user.id, 'en', plan.id, date, customMeal),
      plans.regenerate(user.id, 'en', plan.id),
    ]);

    expect(outcomes(results)).toEqual(['PLAN_CHANGED', 'ok']);
    const after = await plans.get(user.id, 'en', plan.id);
    expect(after.days).toHaveLength(7);
    const day = after.days[3]!;
    const cakeAdded = results[0].status === 'fulfilled';
    expect(day.meals.filter((m) => m.source === 'USER_CUSTOM')).toHaveLength(cakeAdded ? 1 : 0);
    expect(day.meals.filter((m) => m.source === 'CATALOGUE')).toHaveLength(3);
  });

  it('writes the scales an undo names, under the same revision check', async () => {
    const [first, second] = plan.days[0]!.meals;
    const restore = [
      { mealId: first!.id, scale: 1.25 },
      { mealId: second!.id, scale: 0.75 },
    ];
    const undo = () => plans.rebalance(user.id, 'en', plan.id, { scope: 'day', date: plan.days[0]!.date, restore });

    const results = await race(2, undo);

    expect(outcomes(results)).toEqual(['PLAN_CHANGED', 'ok']);
    for (const r of restore) {
      const row = await t.prisma.plannedMeal.findUniqueOrThrow({ where: { id: r.mealId } });
      expect(row.quantityScale).toBe(r.scale);
    }
    expect((await plans.get(user.id, 'en', plan.id)).revision).toBe(1);
  });

  // Repeated: only some interleavings reach the half-deleted plan this guards against.
  it('never answers an edit that overlaps a delete with a server error', { repeats: 25 }, async () => {
    const meal = plan.days[0]!.meals[0]!;

    const results = await Promise.allSettled([swap(meal.id), plans.remove(user.id, plan.id)]);

    for (const outcome of outcomes(results)) {
      expect(['ok', 'PLAN_CHANGED', 'PLAN_NOT_FOUND', 'MEAL_NOT_FOUND']).toContain(outcome);
    }
    expect(await t.prisma.mealPlan.count({ where: { id: plan.id } })).toBe(0);
  });

  describe('with a model behind the swap', () => {
    beforeEach(async () => {
      await t.prisma.user.update({ where: { id: user.id }, data: { aiMode: 'admin' } });
    });

    const aiSwap = (plannedMealId: string) =>
      plans.aiSwapMeal(user.id, 'en', AiSwapMealRequest.parse({ planId: plan.id, plannedMealId }));

    it('returns the rebalance summary together with the swapped plan', async () => {
      const meal = plan.days[0]!.meals[0]!;

      const result = await aiSwap(meal.id);

      expect(t.model.requests).toHaveLength(1);
      expect(result).toHaveProperty('rebalance');
      expect(result.plan.days[0]!.meals.find((m) => m.id === meal.id)!.recipe!.id).not.toBe(meal.recipe!.id);
    });

    it.each([
      ['a long run of spaces after the object', '```json\n{"recipeId":"x"}' + ' '.repeat(120_000) + 'x'],
      ['a long run of opening braces', '{'.repeat(120_000)],
      ['five megabytes of text', 'A'.repeat(5_000_000)],
    ])('stays responsive and still swaps when the model answers with %s', async (_name, text) => {
      const meal = plan.days[0]!.meals[0]!;
      t.model.reply({ text });

      const started = performance.now();
      const result = await aiSwap(meal.id);

      // Read with a backtracking pattern, the first two took ten seconds each.
      expect(performance.now() - started).toBeLessThan(3_000);
      // The answer was unusable, so the engine picked: the user still gets a swap.
      expect(result.plan.days[0]!.meals.find((m) => m.id === meal.id)!.recipe!.id).not.toBe(meal.recipe!.id);
    });

    it('does not write a pick the model returned after the plan changed', async () => {
      const meal = plan.days[0]!.meals[0]!;
      t.model.reply({ delayMs: 600, text: '{"recipeId":"too-late"}' });

      const pending = aiSwap(meal.id);
      // The model is still "thinking": change the plan underneath it.
      await new Promise((done) => setTimeout(done, 150));
      const regenerated = await plans.regenerate(user.id, 'en', plan.id);

      await expect(pending).rejects.toMatchObject({ response: { error: 'PLAN_CHANGED' } });
      const after = await plans.get(user.id, 'en', plan.id);
      expect(after.revision).toBe(regenerated.revision);
      expect(after.days.flatMap((d) => d.meals.map((m) => m.id)).sort()).toEqual(
        regenerated.days.flatMap((d) => d.meals.map((m) => m.id)).sort(),
      );
    });
  });
});
