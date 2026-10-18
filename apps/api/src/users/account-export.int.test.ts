// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { MealPlan, Profile } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sealKey } from '../ai/key-cipher.js';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aPrivateRecipe, aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { ACCOUNT_EXPORT_FORMAT } from './account-export.service.js';

/** What the file holds, as far as these tests read it. */
interface Exported {
  format: string;
  exportedAt: string;
  account: Record<string, unknown>;
  sessions: unknown[];
  aiProviders: Record<string, unknown>[];
  profiles: (Record<string, unknown> & { id: string; preferences: Record<string, unknown> })[];
  weights: { profileId: string; kg: number }[];
  pantry: Record<string, unknown>[];
  markedRecipes: Record<string, unknown>[];
  favoriteSets: Record<string, unknown>[];
  ownRecipes: (Record<string, unknown> & { title: string; ingredients: unknown[] })[];
  plans: { id: string; profileId: string; days: { date: string; meals: Record<string, unknown>[] }[]; shoppingLists: { items: unknown[] }[] }[];
  notifications: Record<string, unknown>[];
  aiCalls: Record<string, unknown>[];
  complete: boolean;
}

describe('everything an account holds, as one file', () => {
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

  const asked = (by: TestUser = user) => t.http().get('/api/users/me/export').set(as(by)).buffer(true).parse((res, done) => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', (piece: string) => (text += piece));
    res.on('end', () => done(null, text));
  });
  /** The file as text, and as what it says. */
  const fileOf = async (by: TestUser = user): Promise<{ text: string; file: Exported }> => {
    const text = (await asked(by).expect(200)).body as string;
    return { text, file: JSON.parse(text) as Exported };
  };

  /** Give the account something of everything it can hold. */
  async function filled(of: TestUser = user): Promise<{ profile: Profile; plan: MealPlan }> {
    const profile = await aProfile(t, of, { name: 'Anna', preferences: { allergens: ['peanuts'], preferredCuisines: ['asian'] } as never });
    const plan = await aPlan(t, of, profile, { durationDays: 2 });
    const breakfast = plan.days[0]!.meals[0]!;
    await t.http().patch(`/api/meal-plans/${plan.id}/meals/${breakfast.id}/eaten`).set(as(of)).send({ eaten: true }).expect(200);
    await t.http().post(`/api/meal-plans/${plan.id}/days/${plan.days[0]!.date}/custom-meal`).set(as(of)).send({ name: 'Soup from the canteen', mealType: 'snack', nutrition: { calories: 200, protein: 10, fat: 5, carbs: 25 } }).expect(201);
    await t.http().post('/api/shopping-lists/generate').set(as(of)).send({ planId: plan.id }).expect(201);
    const rice = await t.prisma.ingredient.findFirstOrThrow({ where: { slug: 'white-rice' } });
    const shared = await t.prisma.recipe.findFirstOrThrow({ where: { slug: 'tofu-rice-bowl' } });
    await aPrivateRecipe(t, of, { title: 'My variant' });
    await t.prisma.weightEntry.create({ data: { profileId: profile.id, kg: 79.5 } });
    await t.prisma.notification.create({ data: { profileId: profile.id, type: 'weight_reminder', payload: { profileId: profile.id } } });
    await t.prisma.favorite.create({ data: { profileId: profile.id, recipeId: shared.id, sentiment: 'often', tags: ['quick'] } });
    await t.prisma.favoriteSet.create({ data: { profileId: profile.id, label: 'Workday', slots: { lunch: shared.id } } });
    await t.prisma.inventoryItem.create({ data: { profileId: profile.id, ingredientId: rice.id, quantity: 500, unit: 'g' } });
    await t.prisma.aiProviderConfig.create({ data: { userId: of.id, provider: 'openai', model: 'gpt', encryptedKey: sealKey('sk-of-the-account', 'a1'.repeat(32), of.id) } });
    await t.prisma.aiUsageLog.create({ data: { userId: of.id, provider: 'openai', model: 'gpt', operation: 'meal-swap', mode: 'byok', outcome: 'COMPLETED', promptTokens: 120 } });
    return { profile, plan };
  }

  it('is a whole document for an account that holds nothing yet: who it is, and every list empty', async () => {
    const answered = await asked().expect(200);
    const file = JSON.parse(answered.body as string) as Exported;

    expect(answered.headers['content-type']).toMatch(/^application\/json/);
    expect(answered.headers['content-disposition']).toMatch(/^attachment; filename="diet-app-account-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(answered.headers['cache-control']).toBe('no-store');
    expect(file.format).toBe(ACCOUNT_EXPORT_FORMAT);
    expect(Date.parse(file.exportedAt)).not.toBeNaN();
    // The address in clear: it is the account's own. An instance that sends no mail takes an address as it is given.
    expect(file.account).toEqual({
      email: user.email,
      displayName: expect.any(String),
      emailVerified: true,
      locale: 'en',
      theme: 'system',
      palette: 'default',
      aiMode: 'none',
      weightUnit: null,
      createdAt: expect.any(String),
      secondFactorSince: null,
    });
    expect(file.sessions).toHaveLength(1);
    for (const list of ['aiProviders', 'profiles', 'weights', 'pantry', 'markedRecipes', 'favoriteSets', 'ownRecipes', 'plans', 'notifications', 'aiCalls'] as const) expect(file[list], list).toEqual([]);
    // The last thing in the file: a file that was cut short does not have it.
    expect(file.complete).toBe(true);
    expect((answered.body as string).endsWith('"complete":true}')).toBe(true);
  });

  it('holds what the account holds: its profiles and what was logged, kept, marked, planned and listed for them', async () => {
    const { profile, plan } = await filled();

    const { file } = await fileOf();

    expect(file.profiles).toHaveLength(1);
    expect(file.profiles[0]).toMatchObject({ id: profile.id, name: 'Anna', age: 30, heightCm: 180, weightKg: 80, dietType: 'balanced' });
    expect(file.profiles[0]!.preferences).toMatchObject({ allergens: ['peanuts'], preferredCuisines: ['asian'], maxTimesPerWeekSameMeal: 3 });
    expect(file.weights).toEqual([expect.objectContaining({ profileId: profile.id, kg: 79.5 })]);
    expect(file.pantry).toEqual([expect.objectContaining({ ingredientSlug: 'white-rice', quantity: 500, unit: 'g' })]);
    expect(file.markedRecipes).toEqual([expect.objectContaining({ recipeSlug: 'tofu-rice-bowl', sentiment: 'often', tags: ['quick'] })]);
    expect(file.favoriteSets).toEqual([expect.objectContaining({ label: 'Workday' })]);
    expect(file.ownRecipes).toEqual([expect.objectContaining({ title: 'My variant' })]);
    expect(file.ownRecipes[0]!.ingredients.length).toBeGreaterThan(0);
    expect(file.notifications).toEqual([expect.objectContaining({ type: 'weight_reminder' })]);
    expect(file.aiCalls).toEqual([expect.objectContaining({ provider: 'openai', operation: 'meal-swap', outcome: 'COMPLETED', promptTokens: 120 })]);

    expect(file.plans).toHaveLength(1);
    const [exported] = file.plans;
    expect(exported).toMatchObject({ id: plan.id, profileId: profile.id, startDate: plan.startDate, durationDays: 2, dietType: 'balanced' });
    expect(exported!.days.map((day) => day.date)).toEqual(plan.days.map((day) => day.date));
    const firstDay = exported!.days[0]!.meals;
    // The meals of the plan, the one of the account's own among them, and the one that was marked as eaten.
    expect(firstDay).toHaveLength(plan.days[0]!.meals.length + 1);
    expect(firstDay.filter((meal) => meal.eatenAt !== null)).toHaveLength(1);
    expect(firstDay.find((meal) => meal.recipeId === null)).toMatchObject({ mealType: 'snack', ownName: 'Soup from the canteen', ownNutrition: { calories: 200, protein: 10, fat: 5, carbs: 25 } });
    expect(firstDay.find((meal) => meal.recipeId !== null)).toMatchObject({ recipe: expect.any(String), servings: expect.any(Number) });
    expect(exported!.shoppingLists).toHaveLength(1);
    expect(exported!.shoppingLists[0]!.items.length).toBeGreaterThan(0);
  });

  it('holds nothing that proves who the account is: no password, no token, no key, no secret', async () => {
    await filled();
    // A second factor, which the session the account holds has passed.
    await t.prisma.secondFactor.create({ data: { userId: user.id, secretEncrypted: 'the-sealed-secret', lastStep: 0, recoveryCodes: { create: [{ codeHash: 'a-recovery-hash' }] } } });
    await t.prisma.refreshToken.updateMany({ where: { userId: user.id }, data: { secondFactorAt: new Date() } });
    const stored = await t.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const tokens = await t.prisma.refreshToken.findMany({ where: { userId: user.id } });
    const config = await t.prisma.aiProviderConfig.findFirstOrThrow({ where: { userId: user.id } });

    const { text, file } = await fileOf();

    for (const secret of [user.password, stored.passwordHash, stored.emailIndex, stored.emailEncrypted, user.accessToken, user.refreshToken, 'sk-of-the-account', config.encryptedKey!, 'the-sealed-secret', 'a-recovery-hash', ...tokens.map((token) => token.tokenHash)]) {
      expect(text.includes(secret), `the file holds "${secret.slice(0, 12)}…"`).toBe(false);
    }
    for (const name of ['passwordHash', 'encryptedKey', 'secretEncrypted', 'tokenHash', 'codeHash', 'emailIndex']) expect(text.includes(name), name).toBe(false);
    // That there is a key, and that sign-in takes a second step, it does say.
    expect(file.aiProviders).toEqual([expect.objectContaining({ provider: 'openai', model: 'gpt', hasKey: true })]);
    expect(file.account.secondFactorSince).toEqual(expect.any(String));
  });

  it('holds nothing of another account', async () => {
    const other = await aUser(t);
    const { profile: theirs, plan: theirPlan } = await filled(other);
    await filled();

    const { text, file } = await fileOf();

    expect(text.includes(other.email)).toBe(false);
    expect(text.includes(theirs.id)).toBe(false);
    expect(text.includes(theirPlan.id)).toBe(false);
    expect(file.profiles).toHaveLength(1);
    expect(file.plans).toHaveLength(1);
    expect(file.aiCalls).toHaveLength(1);
  });

  it('writes every row of a long table once, however many pages it is read in', async () => {
    const profile = await aProfile(t, user);
    const second = await aProfile(t, user, { name: 'Second' });
    // More weights than two pages hold, and more plans than two pages of plans.
    await t.prisma.weightEntry.createMany({ data: Array.from({ length: 450 }, (_, index) => ({ profileId: index % 2 ? profile.id : second.id, kg: 60 + index / 10 })) });
    await t.prisma.mealPlan.createMany({
      data: Array.from({ length: 45 }, (_, index) => ({ profileId: profile.id, startDate: new Date(Date.UTC(2026, 0, 1 + index)), durationDays: 1, dietType: 'balanced' as const, calorieTarget: 2000, options: {}, seed: index })),
    });

    const { file } = await fileOf();

    expect(file.weights).toHaveLength(450);
    expect(new Set(file.weights.map((entry) => entry.kg)).size).toBe(450);
    expect(file.plans).toHaveLength(45);
    expect(new Set(file.plans.map((plan) => plan.id)).size).toBe(45);
    expect(file.complete).toBe(true);
  });

  it('leaves out a recipe the account deleted from its library', async () => {
    const kept = await aPrivateRecipe(t, user, { title: 'Kept' });
    const gone = await aPrivateRecipe(t, user, { title: 'Gone' });
    await t.prisma.recipe.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });

    const { file } = await fileOf();

    expect(file.ownRecipes.map((recipe) => recipe.title)).toEqual(['Kept']);
    expect(file.ownRecipes[0]).toMatchObject({ id: kept.id });
  });

  it('is for the account that is signed in, a few times an hour', async () => {
    await t.http().get('/api/users/me/export').expect(401);

    for (let time = 0; time < 6; time += 1) await asked().expect(200);
    const held = await t.http().get('/api/users/me/export').set(as(user));
    // Another account has its own count.
    const other = await aUser(t);

    expect(held.status).toBe(429);
    await asked(other).expect(200);
  });
});
