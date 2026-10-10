// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FavoriteSet, MealPlan, Profile } from '@diet-app/shared';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aPrivateRecipe, aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

describe('favourite sets', () => {
  let t: TestApp;
  let user: TestUser;
  let profile: Profile;
  let stranger: TestUser;
  let strangerProfile: Profile;
  /** Shared recipes by slug. */
  let shared: Record<string, string>;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
    const rows = await t.prisma.recipe.findMany({ where: { slug: { not: null } }, select: { id: true, slug: true } });
    shared = Object.fromEntries(rows.map((row) => [row.slug!, row.id]));
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await resetUserData(t.prisma);
    user = await aUser(t);
    profile = await aProfile(t, user);
    stranger = await aUser(t);
    strangerProfile = await aProfile(t, stranger);
  });

  const slots = () => ({ breakfast: shared['tofu-scramble']!, dinner: shared['chickpea-tomato-stew']! });

  const create = (as_: TestUser, body: Record<string, unknown>) =>
    t.http().post('/api/favorite-sets').set(as(as_)).send(body);

  async function aSet(overrides: Record<string, unknown> = {}): Promise<FavoriteSet> {
    const res = await create(user, { profileId: profile.id, label: 'Weekday', slots: slots(), ...overrides }).expect(201);
    return res.body as FavoriteSet;
  }

  const list = async (as_: TestUser, profileId: string) =>
    t.http().get('/api/favorite-sets').query({ profileId }).set(as(as_));

  describe('saving one', () => {
    it('keeps the label and the recipe of each slot, listed for its profile', async () => {
      const set = await aSet();

      expect(set).toMatchObject({ profileId: profile.id, label: 'Weekday', slots: slots() });
      expect(((await list(user, profile.id)).body as FavoriteSet[]).map((s) => s.id)).toEqual([set.id]);
    });

    it("accepts the user's own private recipe", async () => {
      const own = await aPrivateRecipe(t, user);
      await create(user, { profileId: profile.id, label: 'Mine', slots: { lunch: own.id } }).expect(201);
    });

    it("refuses another user's private recipe as if it did not exist", async () => {
      const theirs = await aPrivateRecipe(t, stranger);

      const res = await create(user, { profileId: profile.id, label: 'Borrowed', slots: { lunch: theirs.id } });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('RECIPE_NOT_FOUND');
      expect(await t.prisma.favoriteSet.count()).toBe(0);
    });

    it.each([
      ['a recipe the owner has deleted', { deletedAt: new Date() }],
      ['a recipe retired from the shared data', { retiredAt: new Date() }],
    ])('refuses %s', async (_name, change) => {
      const own = await aPrivateRecipe(t, user);
      await t.prisma.recipe.update({ where: { id: own.id }, data: change });

      const res = await create(user, { profileId: profile.id, label: 'Gone', slots: { lunch: own.id } });

      expect(res.status).toBe(404);
    });

    it('refuses a recipe under a meal it is not a recipe for', async () => {
      // The tofu scramble is a breakfast.
      const res = await create(user, { profileId: profile.id, label: 'Mixed up', slots: { dinner: shared['tofu-scramble']! } });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('FAVORITE_SET_NOT_ELIGIBLE');
      expect(await t.prisma.favoriteSet.count()).toBe(0);
    });

    it('needs at least one slot', async () => {
      await create(user, { profileId: profile.id, label: 'Empty', slots: {} }).expect(400);
    });

    it("is refused on another user's profile", async () => {
      const res = await create(user, { profileId: strangerProfile.id, label: 'Theirs', slots: slots() });

      expect([403, 404]).toContain(res.status);
      expect(await t.prisma.favoriteSet.count()).toBe(0);
    });
  });

  describe("another user's set", () => {
    let set: FavoriteSet;

    beforeEach(async () => {
      set = await aSet();
    });

    it('cannot be listed, renamed, removed or applied', async () => {
      const theirPlan = await aPlan(t, stranger, strangerProfile);

      expect([403, 404]).toContain((await list(stranger, profile.id)).status);
      expect([403, 404]).toContain(
        (await t.http().patch(`/api/favorite-sets/${set.id}`).set(as(stranger)).send({ label: 'Taken' })).status,
      );
      expect([403, 404]).toContain((await t.http().delete(`/api/favorite-sets/${set.id}`).set(as(stranger))).status);
      expect([403, 404]).toContain(
        (
          await t
            .http()
            .post(`/api/favorite-sets/${set.id}/apply`)
            .set(as(stranger))
            .send({ planId: theirPlan.id, dayDates: ['2026-01-05'] })
        ).status,
      );

      const kept = (await list(user, profile.id)).body as FavoriteSet[];
      expect(kept).toEqual([expect.objectContaining({ id: set.id, label: 'Weekday' })]);
    });

    it('can be renamed and removed by its owner', async () => {
      const renamed = await t.http().patch(`/api/favorite-sets/${set.id}`).set(as(user)).send({ label: 'Weekend' }).expect(200);
      expect(renamed.body).toMatchObject({ label: 'Weekend', slots: slots() });

      await t.http().delete(`/api/favorite-sets/${set.id}`).set(as(user)).expect(204);
      expect((await list(user, profile.id)).body).toEqual([]);
    });

    it('cannot be given a recipe under the wrong meal afterwards', async () => {
      await t
        .http()
        .patch(`/api/favorite-sets/${set.id}`)
        .set(as(user))
        .send({ slots: { breakfast: shared['chickpea-tomato-stew']! } })
        .expect(400);
      expect(((await list(user, profile.id)).body as FavoriteSet[])[0]!.slots).toEqual(slots());
    });

    it("cannot be pointed at another user's private recipe afterwards", async () => {
      const theirs = await aPrivateRecipe(t, stranger);

      await t.http().patch(`/api/favorite-sets/${set.id}`).set(as(user)).send({ slots: { lunch: theirs.id } }).expect(404);
    });
  });

  describe('applying one to a plan', () => {
    let plan: MealPlan;
    let set: FavoriteSet;

    beforeEach(async () => {
      plan = await aPlan(t, user, profile);
      set = await aSet();
    });

    const apply = (body: Record<string, unknown>) =>
      t.http().post(`/api/favorite-sets/${set.id}/apply`).set(as(user)).send(body);

    const day = (p: MealPlan, date: string) => p.days.find((d) => d.date.slice(0, 10) === date)!;
    const recipeOf = (p: MealPlan, date: string, mealType: string) =>
      day(p, date).meals.find((m) => m.mealType === mealType)?.recipe?.id;

    it('puts its recipes into the slots of the days named, sized to the day, and leaves the other days alone', async () => {
      const res = await apply({ planId: plan.id, dayDates: ['2026-01-06', '2026-01-08'] }).expect(201);
      const after = res.body as MealPlan;

      for (const date of ['2026-01-06', '2026-01-08']) {
        expect(recipeOf(after, date, 'breakfast')).toBe(slots().breakfast);
        expect(recipeOf(after, date, 'dinner')).toBe(slots().dinner);
        for (const meal of day(after, date).meals) expect(meal.servings).toBeGreaterThan(0);
      }
      expect(recipeOf(after, '2026-01-07', 'breakfast')).toBe(recipeOf(plan, '2026-01-07', 'breakfast'));
      expect(recipeOf(after, '2026-01-07', 'dinner')).toBe(recipeOf(plan, '2026-01-07', 'dinner'));
      expect(after.revision).toBe(plan.revision + 1);
    });

    it('answers that no day matches when none of the dates is in the plan', async () => {
      const res = await apply({ planId: plan.id, dayDates: ['2027-03-01'] });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('DAY_NOT_FOUND');
    });

    it("is refused on a plan of another profile, even the same user's", async () => {
      const second = await aProfile(t, user, { name: 'Partner' });
      const theirPlan = await aPlan(t, user, second);

      const res = await apply({ planId: theirPlan.id, dayDates: ['2026-01-05'] });

      expect([403, 404]).toContain(res.status);
    });

    it('writes nothing when one of its recipes has been deleted since', async () => {
      const own = await aPrivateRecipe(t, user, { mealTypes: ['lunch'] });
      await t.http().patch(`/api/favorite-sets/${set.id}`).set(as(user)).send({ slots: { ...slots(), lunch: own.id } }).expect(200);
      await t.http().delete(`/api/recipes/${own.id}`).set(as(user)).expect(204);

      const res = await apply({ planId: plan.id, dayDates: ['2026-01-06'] });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('RECIPE_NOT_FOUND');
      const after = (await t.http().get(`/api/meal-plans/${plan.id}`).set(as(user)).expect(200)).body as MealPlan;
      expect(after.revision).toBe(plan.revision);
      expect(recipeOf(after, '2026-01-06', 'breakfast')).toBe(recipeOf(plan, '2026-01-06', 'breakfast'));
    });

    it('writes nothing when the profile has since started to avoid an allergen in it', async () => {
      // The tofu scramble holds soy.
      await t.prisma.profilePreference.upsert({
        where: { profileId: profile.id },
        update: { allergens: ['soy'] },
        create: { profileId: profile.id, allergens: ['soy'] },
      });

      const res = await apply({ planId: plan.id, dayDates: ['2026-01-06'] });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('FAVORITE_SET_ALLERGEN_CONFLICT');
      const after = (await t.http().get(`/api/meal-plans/${plan.id}`).set(as(user)).expect(200)).body as MealPlan;
      expect(after.revision).toBe(plan.revision);
    });
  });
});
