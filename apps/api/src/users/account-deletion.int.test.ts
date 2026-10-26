// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { MealPlan, Profile } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AiQuotaService } from '../ai/ai-quota.service.js';
import { sealKey } from '../ai/key-cipher.js';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import {
  aPlan,
  aPrivateRecipe,
  aProfile,
  aRecipeDraft,
  aUser,
  as,
  type TestUser,
} from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

/** An account that has used everything an account can use. What it left in the database, by kind. */
interface Everything {
  user: TestUser;
  profiles: Profile[];
  plan: MealPlan;
  /** Every id that belongs to the account: its own, its profiles', its plans', its recipes'. */
  ids: string[];
  recipes: { variant: string; submitted: string; sharedMaking: string };
}

describe('deleting an account', () => {
  let t: TestApp;
  let leaving: Everything;
  let staying: Everything;

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
    leaving = await everything('leaving');
    staying = await everything('staying');
    // The two made one recipe alike, and one draft stands for both.
    await aRecipeDraft(t, {
      slug: 'both-made-this',
      sourceRecipeIds: [leaving.recipes.sharedMaking, staying.recipes.sharedMaking],
      fingerprint: 'made-by-both',
    });
  });

  async function everything(name: string): Promise<Everything> {
    const user = await aUser(t);
    const first = await aProfile(t, user, { name: `${name} one` });
    const second = await aProfile(t, user, { name: `${name} two` });
    const plan = await aPlan(t, user, first, { durationDays: 2 });
    const breakfast = plan.days[0]!.meals[0]!;
    await t
      .http()
      .patch(`/api/meal-plans/${plan.id}/meals/${breakfast.id}/eaten`)
      .set(as(user))
      .send({ eaten: true })
      .expect(200);
    await t
      .http()
      .post(`/api/meal-plans/${plan.id}/days/${plan.days[0]!.date}/custom-meal`)
      .set(as(user))
      .send({
        name: `${name}'s own`,
        mealType: 'snack',
        nutrition: { calories: 200, protein: 10, fat: 5, carbs: 25 },
      })
      .expect(201);
    await t
      .http()
      .post('/api/shopping-lists/generate')
      .set(as(user))
      .send({ planId: plan.id })
      .expect(201);

    const rice = await t.prisma.ingredient.findFirstOrThrow({ where: { slug: 'white-rice' } });
    const shared = await t.prisma.recipe.findFirstOrThrow({ where: { slug: 'tofu-rice-bowl' } });
    const variant = await aPrivateRecipe(t, user, { title: `${name}'s variant` });
    const submitted = await aPrivateRecipe(t, user, { title: `${name}'s submission` });
    const sharedMaking = await aPrivateRecipe(t, user, {
      title: `${name}'s take on a common dish`,
    });
    await aRecipeDraft(t, {
      slug: `${name}-submitted`,
      sourceRecipeIds: [submitted.id],
      fingerprint: `${name}-submitted`,
    });
    await aRecipeDraft(t, {
      slug: `${name}-shipped`,
      sourceRecipeIds: [variant.id],
      status: 'SHIPPED',
      shippedAt: new Date(),
      fingerprint: `${name}-shipped`,
    });

    await t.prisma.weightEntry.create({ data: { profileId: first.id, kg: 80 } });
    await t.prisma.notification.create({
      data: { profileId: second.id, type: 'weight_reminder', payload: { profileId: second.id } },
    });
    await t.prisma.favorite.createMany({
      data: [
        { profileId: first.id, recipeId: shared.id },
        { profileId: first.id, recipeId: variant.id, sentiment: 'often' },
      ],
    });
    await t.prisma.favoriteSet.create({
      data: {
        profileId: first.id,
        label: 'Workday',
        slots: { breakfast: shared.id, lunch: variant.id },
      },
    });
    await t.prisma.inventoryItem.create({
      data: { profileId: first.id, ingredientId: rice.id, quantity: 500, unit: 'g' },
    });
    // A meal of the plan that holds the account's own recipe.
    await t.prisma.plannedMeal.update({
      where: { id: plan.days[1]!.meals[0]!.id },
      data: { recipeId: variant.id },
    });

    await t.prisma.aiProviderConfig.create({
      data: {
        userId: user.id,
        provider: 'openai',
        model: 'gpt',
        encryptedKey: sealKey('sk-of-the-account', 'a1'.repeat(32), user.id),
      },
    });
    await t.prisma.aiUsageLog.createMany({
      data: [
        {
          userId: user.id,
          provider: 'ollama',
          model: 'test-model',
          operation: 'meal-swap',
          mode: 'admin',
          outcome: 'COMPLETED',
        },
        {
          userId: user.id,
          provider: 'ollama',
          model: 'test-model',
          operation: 'meal-swap',
          mode: 'admin',
          outcome: 'COMPLETED',
        },
        {
          userId: user.id,
          provider: 'ollama',
          model: 'test-model',
          operation: 'recipe-draft',
          mode: 'admin',
          outcome: 'FAILED',
        },
        {
          userId: user.id,
          provider: 'openai',
          model: 'gpt',
          operation: 'meal-swap',
          mode: 'byok',
          outcome: 'COMPLETED',
        },
      ],
    });
    const hour = new Date(Date.now() + 3_600_000);
    await t.prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash: `${name}-reset`, expiresAt: hour },
    });
    await t.prisma.emailVerificationToken.create({
      data: { userId: user.id, tokenHash: `${name}-verify`, expiresAt: hour },
    });
    await t.prisma.emailChangeToken.create({
      data: {
        userId: user.id,
        tokenHash: `${name}-change`,
        newEmailEncrypted: 'x',
        newEmailIndex: `${name}-index`,
        expiresAt: hour,
      },
    });
    // A second factor with a recovery code and a sign-in that waits for its code; the session the account holds has passed it.
    const factor = await t.prisma.secondFactor.create({
      data: {
        userId: user.id,
        secretEncrypted: 'x',
        lastStep: 0,
        recoveryCodes: { create: [{ codeHash: `${name}-recovery` }] },
      },
    });
    await t.prisma.signInChallenge.create({
      data: { userId: user.id, tokenHash: `${name}-challenge`, expiresAt: hour },
    });
    await t.prisma.refreshToken.updateMany({
      where: { userId: user.id },
      data: { secondFactorAt: new Date() },
    });

    const plans = await t.prisma.mealPlan.findMany({
      where: { profileId: { in: [first.id, second.id] } },
      select: { id: true, days: { select: { id: true } } },
    });
    return {
      user,
      profiles: [first, second],
      plan,
      ids: [
        user.id,
        first.id,
        second.id,
        variant.id,
        submitted.id,
        sharedMaking.id,
        factor.id,
        ...plans.flatMap((p) => [p.id, ...p.days.map((day) => day.id)]),
      ],
      recipes: { variant: variant.id, submitted: submitted.id, sharedMaking: sharedMaking.id },
    };
  }

  /** Every place in the database where one of `ids` stands, as `table.column`. */
  async function standsIn(ids: string[]): Promise<string[]> {
    const columns = await t.prisma.$queryRawUnsafe<{ table_name: string; column_name: string }[]>(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name <> '_prisma_migrations' ORDER BY table_name, ordinal_position`,
    );
    const found: string[] = [];
    for (const { table_name, column_name } of columns) {
      const rows = await t.prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT COUNT(*)::bigint AS n FROM "${table_name}" WHERE "${column_name}"::text ~ $1`,
        ids.join('|'),
      );
      if (rows[0]!.n > 0n) found.push(`${table_name}.${column_name}`);
    }
    return found;
  }

  const remove = (who: Everything, password = who.user.password) =>
    t.http().delete('/api/users/me').set(as(who.user)).send({ currentPassword: password });
  const countOf = async (who: Everything) => ({
    profiles: await t.prisma.profile.count({ where: { userId: who.user.id } }),
    plans: await t.prisma.mealPlan.count({ where: { profile: { userId: who.user.id } } }),
    meals: await t.prisma.plannedMeal.count({
      where: { day: { plan: { profile: { userId: who.user.id } } } },
    }),
    lists: await t.prisma.shoppingList.count({
      where: { plan: { profile: { userId: who.user.id } } },
    }),
    favourites: await t.prisma.favorite.count({ where: { profile: { userId: who.user.id } } }),
    sets: await t.prisma.favoriteSet.count({ where: { profile: { userId: who.user.id } } }),
    pantry: await t.prisma.inventoryItem.count({ where: { profile: { userId: who.user.id } } }),
    recipes: await t.prisma.recipe.count({ where: { createdByUserId: who.user.id } }),
    providers: await t.prisma.aiProviderConfig.count({ where: { userId: who.user.id } }),
    calls: await t.prisma.aiUsageLog.count({ where: { userId: who.user.id } }),
    tokens:
      (await t.prisma.refreshToken.count({ where: { userId: who.user.id } })) +
      (await t.prisma.passwordResetToken.count({ where: { userId: who.user.id } })),
  });

  it('starts from an account that is all over the database', async () => {
    const places = await standsIn(leaving.ids);

    for (const place of [
      'User.id',
      'Profile.userId',
      'MealPlan.profileId',
      'MealPlanDay.planId',
      'ShoppingList.planId',
      'Favorite.profileId',
      'FavoriteSet.slots',
      'InventoryItem.profileId',
      'Recipe.createdByUserId',
      'RecipeDraft.sourceRecipeIds',
      'AiProviderConfig.userId',
      'AiUsageLog.userId',
      'RefreshToken.userId',
      'Notification.payload',
      'WeightEntry.profileId',
      'SecondFactor.userId',
      'RecoveryCode.secondFactorId',
      'SignInChallenge.userId',
    ]) {
      expect(places, place).toContain(place);
    }
  });

  it('leaves none of its ids in any column of any table', async () => {
    await remove(leaving).expect(204);

    expect(await standsIn(leaving.ids)).toEqual([]);
  });

  it('leaves every other account as it was', async () => {
    const before = await countOf(staying);

    await remove(leaving).expect(204);

    expect(await countOf(staying)).toEqual(before);
    expect(before).toMatchObject({
      profiles: 2,
      plans: 1,
      lists: 1,
      favourites: 2,
      sets: 1,
      pantry: 1,
      recipes: 3,
      providers: 1,
      calls: 4,
    });
    expect(
      (await t.http().get(`/api/meal-plans/${staying.plan.id}`).set(as(staying.user)).expect(200))
        .body.days,
    ).toHaveLength(2);
  });

  it('takes its own recipes out of the queue: a draft that stood for them alone goes, one that shipped or stands for another account too stays without them', async () => {
    await remove(leaving).expect(204);

    const drafts = await t.prisma.recipeDraft.findMany({
      select: { slug: true, status: true, sourceRecipeIds: true },
      orderBy: { slug: 'asc' },
    });
    expect(drafts).toEqual([
      {
        slug: 'both-made-this',
        status: 'PENDING',
        sourceRecipeIds: [staying.recipes.sharedMaking],
      },
      { slug: 'leaving-shipped', status: 'SHIPPED', sourceRecipeIds: [] },
      { slug: 'staying-shipped', status: 'SHIPPED', sourceRecipeIds: [staying.recipes.variant] },
      {
        slug: 'staying-submitted',
        status: 'PENDING',
        sourceRecipeIds: [staying.recipes.submitted],
      },
    ]);
  });

  it("keeps what its calls to the instance's provider count for, with nothing that says whose they were", async () => {
    const quota = t.app.get(AiQuotaService);
    const before = (await quota.status(staying.user.id, 'admin')).used;
    const instanceBefore = await quota.instanceUsed();

    await remove(leaving).expect(204);

    // Two completed calls each: four for the instance, before and after.
    expect(instanceBefore).toBe(4);
    expect(await quota.instanceUsed()).toBe(4);
    expect((await quota.status(staying.user.id, 'admin')).used).toBe(before);
    expect(await t.prisma.aiUsageLog.count()).toBe(4);
  });

  it('is refused without the password, and nothing goes', async () => {
    const before = await countOf(leaving);

    expect((await remove(leaving, 'Not-The-Passw0rd').expect(401)).body.error).toBe(
      'INVALID_PASSWORD',
    );

    expect(await countOf(leaving)).toEqual(before);
  });

  it('ends what its access token could do, at once', async () => {
    await remove(leaving).expect(204);

    expect((await t.http().get('/api/users/me').set(as(leaving.user)).expect(401)).body.error).toBe(
      'INVALID_ACCESS_TOKEN',
    );
    await t
      .http()
      .post('/api/profiles')
      .set(as(leaving.user))
      .send({
        name: 'Ghost',
        age: 30,
        sex: 'male',
        heightCm: 180,
        weightKg: 80,
        activityLevel: 'moderate',
        weeklyLossTarget: null,
      })
      .expect(401);
    await t
      .http()
      .post('/api/auth/refresh')
      .send({ refreshToken: leaving.user.refreshToken })
      .expect(401);
  });

  it('lets the address be registered again, as a new account with nothing in it', async () => {
    await remove(leaving).expect(204);

    const again = await aUser(t, { email: leaving.user.email, password: leaving.user.password });

    expect(again.id).not.toBe(leaving.user.id);
    expect(await t.prisma.profile.count({ where: { userId: again.id } })).toBe(0);
  });
});
