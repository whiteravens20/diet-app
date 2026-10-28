// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import {
  type AccountSession,
  type InventoryItem,
  MAX_FAVORITES_PER_PROFILE,
  MAX_FAVORITE_SETS_PER_PROFILE,
  MAX_PANTRY_ROWS,
  MAX_SESSIONS_LISTED,
  MAX_UNREAD_LISTED,
  MAX_WEIGHTS_LISTED,
  type Notification,
  type Profile,
  type ShoppingList,
  type WeightDay,
  type WeightEntry,
} from '@diet-app/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SessionsService } from '../auth/sessions.service.js';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, as, race, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

const DAY = 86_400_000;

/** What requests that arrived together were answered with, in order. */
const statuses = (answers: PromiseSettledResult<{ status: number }>[]): number[] =>
  answers.map((answer) => (answer.status === 'fulfilled' ? answer.value.status : 0)).sort();

/** The refusals among them, by their code. */
const refusals = (
  answers: PromiseSettledResult<{ status: number; body: { error?: string } }>[],
): string[] =>
  answers.flatMap((answer) =>
    answer.status === 'fulfilled' && answer.value.status !== 201
      ? [answer.value.body.error ?? '']
      : [],
  );

describe('how much a profile may hold, and how much of a list one answer shows', () => {
  let t: TestApp;
  let user: TestUser;

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
  });

  /** Recipes of the user's own, as many as asked for: they go with the account. */
  async function ownRecipes(count: number): Promise<string[]> {
    await t.prisma.recipe.createMany({
      data: Array.from({ length: count }, (_, n) => ({
        title: `Own recipe ${n}`,
        description: 'One of many.',
        servings: 1,
        mealTypes: ['lunch'],
        dietTags: [],
        steps: ['Cook.'],
        prepMinutes: 5,
        cookMinutes: 5,
        allergens: [],
        origin: 'ai' as const,
        caloriesPerServing: 300,
        proteinPerServing: 10,
        fatPerServing: 10,
        carbsPerServing: 40,
        createdByUserId: user.id,
      })),
    });
    const rows = await t.prisma.recipe.findMany({
      where: { createdByUserId: user.id },
      select: { id: true },
      orderBy: { title: 'asc' },
    });
    // A recipe is made of something: each of them of rice.
    const rice = await t.prisma.ingredient.findFirstOrThrow({ where: { slug: 'white-rice' } });
    await t.prisma.recipeIngredient.createMany({
      data: rows.map((row) => ({
        recipeId: row.id,
        ingredientId: rice.id,
        quantity: 80,
        unit: 'g' as const,
      })),
    });
    return rows.map((row) => row.id);
  }

  describe('a profile', () => {
    let profile: Profile;

    beforeEach(async () => {
      profile = await aProfile(t, user);
    });

    it('marks as many recipes as it may and not one more, and what it marked can still be marked anew', async () => {
      const recipes = await ownRecipes(MAX_FAVORITES_PER_PROFILE + 4);
      const mark = (recipeId: string, sentiment = 'favorite') =>
        t
          .http()
          .post('/api/favorites')
          .set(as(user))
          .send({ profileId: profile.id, recipeId, sentiment });
      await t.prisma.favorite.createMany({
        data: recipes
          .slice(0, MAX_FAVORITES_PER_PROFILE - 1)
          .map((recipeId) => ({ profileId: profile.id, recipeId })),
      });

      const answers = await race(4, (n) => mark(recipes[MAX_FAVORITES_PER_PROFILE - 1 + n]!));

      expect(statuses(answers)).toEqual([201, 409, 409, 409]);
      expect(new Set(refusals(answers))).toEqual(new Set(['FAVORITE_LIMIT_REACHED']));
      const listed: unknown[] = (
        await t
          .http()
          .get('/api/favorites')
          .query({ profileId: profile.id })
          .set(as(user))
          .expect(200)
      ).body;
      expect(listed).toHaveLength(MAX_FAVORITES_PER_PROFILE);

      // Saying something else about a recipe that is marked adds nothing.
      await mark(recipes[0]!, 'avoid').expect(201);
      // A mark taken off makes room for one.
      await t.http().delete(`/api/favorites/${profile.id}/${recipes[1]}`).set(as(user)).expect(204);
      const unmarked = (
        await t.prisma.recipe.findMany({
          where: { createdByUserId: user.id, favorites: { none: {} } },
          select: { id: true },
          take: 2,
        })
      ).map((row) => row.id);
      await mark(unmarked[0]!).expect(201);
      await mark(unmarked[1]!).expect(409);
    });

    it('does not count the mark of a recipe that was deleted: the list does not show it', async () => {
      const recipes = await ownRecipes(MAX_FAVORITES_PER_PROFILE + 1);
      await t.prisma.favorite.createMany({
        data: recipes
          .slice(0, MAX_FAVORITES_PER_PROFILE)
          .map((recipeId) => ({ profileId: profile.id, recipeId })),
      });
      const mark = () =>
        t
          .http()
          .post('/api/favorites')
          .set(as(user))
          .send({ profileId: profile.id, recipeId: recipes[MAX_FAVORITES_PER_PROFILE] });
      await mark().expect(409);

      await t.prisma.recipe.update({ where: { id: recipes[0]! }, data: { deletedAt: new Date() } });

      await mark().expect(201);
    });

    it('has as many favorite sets as it may and not one more', async () => {
      const recipe = await t.prisma.recipe.findUniqueOrThrow({ where: { slug: 'tofu-rice-bowl' } });
      const slots = { lunch: recipe.id };
      await t.prisma.favoriteSet.createMany({
        data: Array.from({ length: MAX_FAVORITE_SETS_PER_PROFILE - 1 }, (_, n) => ({
          profileId: profile.id,
          label: `Set ${n}`,
          slots,
        })),
      });

      const answers = await race(4, (n) =>
        t
          .http()
          .post('/api/favorite-sets')
          .set(as(user))
          .send({ profileId: profile.id, label: `One more ${n}`, slots }),
      );

      expect(statuses(answers)).toEqual([201, 409, 409, 409]);
      expect(new Set(refusals(answers))).toEqual(new Set(['FAVORITE_SET_LIMIT_REACHED']));
      const listed: unknown[] = (
        await t
          .http()
          .get('/api/favorite-sets')
          .query({ profileId: profile.id })
          .set(as(user))
          .expect(200)
      ).body;
      expect(listed).toHaveLength(MAX_FAVORITE_SETS_PER_PROFILE);
    });

    it('is shown its newest weights, a thousand at most', async () => {
      const now = Date.now();
      await t.prisma.weightEntry.createMany({
        data: Array.from({ length: MAX_WEIGHTS_LISTED + 5 }, (_, n) => ({
          profileId: profile.id,
          kg: 80,
          recordedAt: new Date(now - n * DAY),
        })),
      });

      const listed: WeightEntry[] = (
        await t
          .http()
          .get('/api/weights')
          .query({ profileId: profile.id })
          .set(as(user))
          .expect(200)
      ).body;

      expect(listed).toHaveLength(MAX_WEIGHTS_LISTED);
      expect(Date.parse(listed[0]!.recordedAt)).toBe(now);
      expect(Date.parse(listed.at(-1)!.recordedAt)).toBe(now - (MAX_WEIGHTS_LISTED - 1) * DAY);
      // By day, of the same thousand: one entry a day is a thousand days.
      const byDay: WeightDay[] = (
        await t
          .http()
          .get('/api/weights/days')
          .query({ profileId: profile.id, timeZone: 'UTC' })
          .set(as(user))
          .expect(200)
      ).body;
      expect(byDay).toHaveLength(MAX_WEIGHTS_LISTED);
      expect(byDay.at(-1)!.date).toBe(new Date(now).toISOString().slice(0, 10));
      const lately: WeightEntry[] = (
        await t
          .http()
          .get('/api/weights')
          .query({ profileId: profile.id, since: new Date(now - 6.5 * DAY).toISOString() })
          .set(as(user))
          .expect(200)
      ).body;
      expect(lately).toHaveLength(7);
    });

    it('is shown its newest unread notifications, fifty at most, and marks them all as read at once', async () => {
      const now = Date.now();
      await t.prisma.notification.createMany({
        data: Array.from({ length: MAX_UNREAD_LISTED + 5 }, (_, n) => ({
          profileId: profile.id,
          type: 'preferences_review',
          payload: { ingredients: n, recipes: 0 },
          createdAt: new Date(now - n * 60_000),
        })),
      });

      const listed: Notification[] = (
        await t.http().get('/api/notifications/unread').set(as(user)).expect(200)
      ).body;

      expect(listed).toHaveLength(MAX_UNREAD_LISTED);
      expect(
        listed.map((notification) => (notification.payload as { ingredients: number }).ingredients),
      ).toEqual(Array.from({ length: MAX_UNREAD_LISTED }, (_, n) => n));
      expect(
        (await t.http().post('/api/notifications/read-all').set(as(user)).expect(200)).body,
      ).toEqual({ updated: MAX_UNREAD_LISTED + 5 });
    });

    describe('with a pantry that is all but full', () => {
      /** Ingredients nobody cooks with, enough of them to fill a pantry: one can be kept in grams, millilitres and pieces. */
      let fillers: string[];

      beforeEach(async () => {
        await t.prisma.ingredient.createMany({
          data: Array.from({ length: Math.ceil(MAX_PANTRY_ROWS / 3) + 2 }, (_, n) => ({
            name: `Filler ${String(n).padStart(4, '0')}`,
            category: 'other' as const,
            canonicalUnit: 'g' as const,
            caloriesPer100: 100,
            proteinPer100: 1,
            fatPer100: 1,
            carbsPer100: 20,
            gramsPerPiece: 50,
            density: 1,
          })),
        });
        fillers = (
          await t.prisma.ingredient.findMany({
            where: { name: { startsWith: 'Filler ' } },
            select: { id: true },
            orderBy: { name: 'asc' },
          })
        ).map((row) => row.id);
        const units = ['g', 'ml', 'piece'] as const;
        await t.prisma.inventoryItem.createMany({
          data: Array.from({ length: MAX_PANTRY_ROWS - 1 }, (_, n) => ({
            profileId: profile.id,
            ingredientId: fillers[Math.floor(n / 3)]!,
            unit: units[n % 3]!,
            quantity: 10,
          })),
        });
      });

      afterEach(async () => {
        await t.prisma.inventoryItem.deleteMany();
        await t.prisma.ingredient.deleteMany({ where: { name: { startsWith: 'Filler ' } } });
      });

      const add = (ingredientId: string, unit = 'g') =>
        t
          .http()
          .post('/api/inventory')
          .set(as(user))
          .send({ profileId: profile.id, ingredientId, quantity: 5, unit });

      it('takes the row that fills it and refuses the next, and still takes more of what it holds', async () => {
        const [last, beyond] = fillers.slice(-2) as [string, string];

        await add(last).expect(201);
        const refused = await add(beyond).expect(409);

        expect(refused.body.error).toBe('PANTRY_FULL');
        expect(await t.prisma.inventoryItem.count({ where: { profileId: profile.id } })).toBe(
          MAX_PANTRY_ROWS,
        );
        const more: InventoryItem = (await add(last).expect(201)).body;
        expect(more.quantity).toBe(10);
        const listed: unknown[] = (
          await t
            .http()
            .get('/api/inventory')
            .query({ profileId: profile.id })
            .set(as(user))
            .expect(200)
        ).body;
        expect(listed).toHaveLength(MAX_PANTRY_ROWS);
      });

      it('refuses what a shopping list would bring in beyond the need, and takes a row that is bought as needed', async () => {
        const plan = await aPlan(t, user, profile);
        const list: ShoppingList = (
          await t
            .http()
            .post('/api/shopping-lists/generate')
            .set(as(user))
            .send({ planId: plan.id })
            .expect(201)
        ).body;
        const [first, second] = list.groups
          .flatMap((group) => group.items)
          .filter((item) => item.toBuyQuantity > 0);
        const row = (itemId: string) =>
          t.http().patch(`/api/shopping-lists/${list.id}/items/${itemId}`).set(as(user));
        await add(fillers.at(-1)!).expect(201);

        const refused = await row(first!.id)
          .send({ purchasedQuantity: first!.toBuyQuantity * 2 })
          .expect(409);

        expect(refused.body.error).toBe('PANTRY_FULL');
        expect(
          await t.prisma.shoppingListItem.findUniqueOrThrow({ where: { id: first!.id } }),
        ).toMatchObject({ checked: false, purchasedQuantity: null });
        expect(await t.prisma.inventoryItem.count({ where: { profileId: profile.id } })).toBe(
          MAX_PANTRY_ROWS,
        );
        // Bought as needed, nothing is left over for the pantry to hold.
        await row(second!.id).send({ checked: true }).expect(200);
      });
    });
  });

  it('is shown the sessions it used last, fifty at most, and signing out everywhere ends the others too', async () => {
    const sessions = t.app.get(SessionsService);
    const account = {
      id: user.id,
      displayName: 'User',
      role: 'user' as const,
      emailVerified: true,
    };
    const more = MAX_SESSIONS_LISTED + 4;
    for (let n = 0; n < more; n += 1) await sessions.open(account, user.email, `Device ${n}`);

    const listed: AccountSession[] = (
      await t.http().get('/api/users/me/sessions').set(as(user)).expect(200)
    ).body;

    expect(listed).toHaveLength(MAX_SESSIONS_LISTED);
    // The one the account was made with is the oldest of them all: it is among those the list leaves out.
    expect(listed.every((session) => session.label?.startsWith('Device '))).toBe(true);
    await t.http().delete('/api/users/me/sessions').set(as(user)).expect(204);
    expect(await t.prisma.refreshToken.count({ where: { userId: user.id, revokedAt: null } })).toBe(
      0,
    );
  });
});
