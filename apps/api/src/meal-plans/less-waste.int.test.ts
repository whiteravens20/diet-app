// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { MealPlan, Profile } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aProfile, as, aUser, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

describe('a plan that wastes less', () => {
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

  const generate = async (body: Record<string, unknown> = {}): Promise<MealPlan> =>
    (
      await t
        .http()
        .post('/api/meal-plans/generate')
        .set(as(user))
        .send({ profileId: profile.id, startDate: '2026-01-05', durationDays: 3, ...body })
        .expect(201)
    ).body as MealPlan;

  const again = async (plan: MealPlan, body: Record<string, unknown> = {}): Promise<MealPlan> =>
    (
      await t
        .http()
        .post(`/api/meal-plans/${plan.id}/regenerate`)
        .set(as(user))
        .send({ includePast: true, ...body })
        .expect(201)
    ).body as MealPlan;

  it('is made only where it is asked for, and the plan says which it is', async () => {
    expect((await generate()).options.lessWaste).toBe(false);
    expect((await generate({ lessWaste: true })).options.lessWaste).toBe(true);
  });

  it('is off for a plan made before it was offered', async () => {
    const plan = await generate();
    const before: Record<string, unknown> = { ...plan.options };
    delete before.lessWaste;
    await t.prisma.mealPlan.update({ where: { id: plan.id }, data: { options: before as object } });

    const read = (await t.http().get(`/api/meal-plans/${plan.id}`).set(as(user)).expect(200))
      .body as MealPlan;

    expect(read.options.lessWaste).toBe(false);
  });

  it('stays with the plan made again, changed only where the whole plan is asked to change', async () => {
    const plan = await generate({ lessWaste: true });

    expect((await again(plan)).options.lessWaste).toBe(true);
    const changed = await again(plan, { lessWaste: false });
    expect(changed.options.lessWaste).toBe(false);
    // A part of the plan made again is made as the plan is.
    const part = await again(plan, { from: '2026-01-06', to: '2026-01-06', lessWaste: true });
    expect(part.options.lessWaste).toBe(false);
  });

  describe('with something in the pantry', () => {
    const streak = async (): Promise<number> =>
      (await t.prisma.profile.findUniqueOrThrow({ where: { id: profile.id } })).inventoryBiasStreak;

    beforeEach(async () => {
      const rice = await t.prisma.ingredient.findFirstOrThrow({ where: { slug: 'white-rice' } });
      await t.prisma.inventoryItem.create({
        data: { profileId: profile.id, ingredientId: rice.id, quantity: 1000, unit: 'g' },
      });
    });

    it('counts the pantry also when it is asked to leave it aside, made or made again', async () => {
      expect((await generate({ respectInventory: false, lessWaste: true })).report!.pantry).toBe(
        'counted',
      );
      expect(await streak()).toBe(1);

      const aside = await generate({ startDate: '2026-02-02', respectInventory: false });
      expect(aside.report!.pantry).toBe('not_asked');
      expect((await again(aside, { lessWaste: true })).report!.pantry).toBe('counted');
    });

    it('is never the round of the rotation that leaves the pantry out: the plan after it is', async () => {
      await t.prisma.profile.update({
        where: { id: profile.id },
        data: { inventoryBiasStreak: 5 },
      });

      expect((await generate({ lessWaste: true })).report!.pantry).toBe('counted');
      expect(await streak()).toBe(6);
      expect((await generate({ startDate: '2026-02-02' })).report!.pantry).toBe('left_out');
      expect(await streak()).toBe(0);
    });
  });
});
