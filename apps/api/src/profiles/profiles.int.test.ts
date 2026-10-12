// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { DEFAULT_PROFILES_PER_ACCOUNT, type Profile } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aProfile, aUser, as, race, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

describe('changing a profile', () => {
  let t: TestApp;
  let user: TestUser;
  let profile: Profile;
  let rice: string;
  let oats: string;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
    rice = (await t.prisma.ingredient.findFirstOrThrow({ where: { slug: 'white-rice' } })).id;
    oats = (await t.prisma.ingredient.findFirstOrThrow({ where: { slug: 'rolled-oats' } })).id;
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await resetUserData(t.prisma);
    user = await aUser(t);
    // A profile that is nowhere at its defaults, so that a default put back would show.
    profile = await aProfile(t, user, {
      name: 'Anna',
      sex: 'female',
      activityLevel: 'active',
      dietType: 'vegan',
      weeklyLossTarget: null,
      manualCalorieTarget: 2100,
      mealCount: 5,
      weightReminderCadence: 'off',
      preferences: {
        favoriteIngredientIds: [rice],
        excludedIngredientIds: [oats],
        allergens: ['peanuts', 'fish'],
        dislikedFoods: ['liver'],
        preferredCuisines: ['thai'],
        maxConsecutiveDaysSameMeal: 4,
        maxTimesPerWeekSameMeal: 5,
        maxWeeklyAmountPerIngredient: 2000,
        inventoryBiasResetEvery: 9,
      },
    });
  });

  /** `from` without some of its parts. */
  const without = (from: object, ...parts: string[]): Record<string, unknown> => Object.fromEntries(Object.entries(from).filter(([part]) => !parts.includes(part)));
  /** What a client that shows every part of the profile sends back. */
  const whole = (): Record<string, unknown> => without(profile, 'id', 'userId', 'riskAcknowledgedAt', 'createdAt', 'updatedAt');
  const put = (body: Record<string, unknown>) => t.http().put(`/api/profiles/${profile.id}`).set(as(user)).send(body);
  const patch = (body: unknown) => t.http().patch(`/api/profiles/${profile.id}/preferences`).set(as(user)).send(body as object);
  const stored = async (): Promise<Profile> => (await t.http().get(`/api/profiles/${profile.id}`).set(as(user)).expect(200)).body;

  describe('as a whole', () => {
    it('takes every part of it, and changes what was sent', async () => {
      const changed: Profile = (await put({ ...whole(), name: 'Anna K.', weightKg: 61.5, weightReminderCadence: 'daily' }).expect(200)).body;

      expect(changed).toMatchObject({ name: 'Anna K.', weightKg: 61.5, weightReminderCadence: 'daily', dietType: 'vegan', mealCount: 5 });
      expect(changed.preferences).toEqual(profile.preferences);
    });

    it.each(['name', 'age', 'sex', 'heightCm', 'weightKg', 'activityLevel', 'dietType', 'weeklyLossTarget', 'manualCalorieTarget', 'mealCount', 'weightReminderCadence', 'customMacroSplit', 'preferences'])(
      'refuses a profile without its %s, and puts nothing back to a default',
      async (part) => {
        const refused = await put(without(whole(), part)).expect(400);

        expect(refused.body.error).toBe('VALIDATION_FAILED');
        expect(refused.body.issues[0].path).toBe(part);
        expect(await stored()).toEqual(profile);
      },
    );

    it('refuses preferences that are not whole', async () => {
      const refused = await put({ ...whole(), preferences: without(profile.preferences, 'allergens') }).expect(400);

      expect(refused.body.issues[0].path).toBe('preferences.allergens');
      expect((await stored()).preferences.allergens).toEqual(['peanuts', 'fish']);
    });

    it('still gives a new profile what it leaves out', async () => {
      await t.prisma.profile.delete({ where: { id: profile.id } });

      const made: Profile = (await t.http().post('/api/profiles').set(as(user)).send({ name: 'New', age: 30, heightCm: 180, weightKg: 80 }).expect(201)).body;

      expect(made).toMatchObject({ sex: null, activityLevel: 'moderate', dietType: 'balanced', weeklyLossTarget: '0.5', mealCount: 3, weightReminderCadence: 'weekly' });
      expect(made.preferences).toMatchObject({ allergens: [], maxConsecutiveDaysSameMeal: 2, maxTimesPerWeekSameMeal: 3, inventoryBiasResetEvery: 5 });
    });
  });

  describe('to the custom diet', () => {
    const OWN = { protein: 30, fat: 40, carbs: 30 };

    it('is refused without the split the profile aims at, and stays on its diet', async () => {
      const refused = await put({ ...whole(), dietType: 'custom' }).expect(400);

      expect(refused.body.issues[0].path).toBe('customMacroSplit');
      expect((await stored()).dietType).toBe('vegan');
    });

    it.each([
      ['does not add up to a hundred', { protein: 30, fat: 40, carbs: 40 }],
      ['gives protein less than a diet needs', { protein: 5, fat: 45, carbs: 50 }],
      ['is not in whole per cent', { protein: 30.5, fat: 39.5, carbs: 30 }],
    ])('is refused with a split that %s', async (_why, split) => {
      const refused = await put({ ...whole(), dietType: 'custom', customMacroSplit: split }).expect(400);

      expect(refused.body.error).toBe('VALIDATION_FAILED');
      expect(refused.body.issues[0].path).toMatch(/^customMacroSplit/);
      expect((await stored()).customMacroSplit).toBeNull();
    });

    it('takes the split, and the profile\'s target is split by it', async () => {
      const changed: Profile = (await put({ ...whole(), dietType: 'custom', customMacroSplit: OWN }).expect(200)).body;
      const calories = (await t.http().get(`/api/profiles/${profile.id}/calories`).set(as(user)).expect(200)).body;

      expect(changed).toMatchObject({ dietType: 'custom', customMacroSplit: OWN });
      // The typed target of 2,100 kcal: 630, 840 and 630 of them, at four, nine and four a gram.
      expect(calories).toMatchObject({ dailyTarget: 2100, targetMacros: { protein: 158, fat: 93, carbs: 158 } });
    });

    it('keeps the split for a profile that goes to another diet, where it changes nothing', async () => {
      await put({ ...whole(), dietType: 'custom', customMacroSplit: OWN }).expect(200);
      const vegan = (await t.http().get(`/api/profiles/${profile.id}/calories`).set(as(user)).expect(200)).body.targetMacros;
      const back: Profile = (await put({ ...whole(), dietType: 'vegan', customMacroSplit: OWN }).expect(200)).body;
      const calories = (await t.http().get(`/api/profiles/${profile.id}/calories`).set(as(user)).expect(200)).body;

      expect(back).toMatchObject({ dietType: 'vegan', customMacroSplit: OWN });
      expect(calories.targetMacros).not.toEqual(vegan);
      // 20 %, 28 % and 52 % of 2,100 kcal: the vegan diet's own split.
      expect(calories.targetMacros).toEqual({ protein: 105, fat: 65, carbs: 273 });
    });

    it('is where a new profile can begin', async () => {
      const made = await t.http().post('/api/profiles').set(as(user)).send({ name: 'Second', age: 30, heightCm: 180, weightKg: 80, dietType: 'custom', customMacroSplit: OWN }).expect(201);
      const refused = await t.http().post('/api/profiles').set(as(user)).send({ name: 'Third', age: 30, heightCm: 180, weightKg: 80, dietType: 'custom' }).expect(400);

      expect(made.body.customMacroSplit).toEqual(OWN);
      expect(refused.body.issues[0].path).toBe('customMacroSplit');
    });
  });

  describe('in some of its preferences', () => {
    it('changes what was sent and leaves the rest of the profile as it is', async () => {
      const changed: Profile = (await patch({ allergens: ['gluten'] }).expect(200)).body;

      expect(changed.preferences).toEqual({ ...profile.preferences, allergens: ['gluten'] });
      expect({ ...changed, preferences: null, updatedAt: null }).toEqual({ ...profile, preferences: null, updatedAt: null });
    });

    it('takes several at once, and an empty list for a list that is emptied', async () => {
      const changed: Profile = (await patch({ favoriteIngredientIds: [], excludedIngredientIds: [rice, oats], maxWeeklyAmountPerIngredient: 5000 }).expect(200)).body;

      expect(changed.preferences).toEqual({ ...profile.preferences, favoriteIngredientIds: [], excludedIngredientIds: [rice, oats], maxWeeklyAmountPerIngredient: 5000 });
    });

    it.each([
      ['nothing', {}, ''],
      ['a preference there is not', { allergens: [], spiceLevel: 3 }, ''],
      ['an allergen there is not', { allergens: ['gluten', 'kryptonite'] }, 'allergens.1'],
      ['an ingredient that is no id', { favoriteIngredientIds: ['rice'] }, 'favoriteIngredientIds.0'],
      ['more ingredients than a profile holds', { excludedIngredientIds: Array.from({ length: 201 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`) }, 'excludedIngredientIds'],
      ['a food of two hundred characters', { dislikedFoods: ['x'.repeat(200)] }, 'dislikedFoods.0'],
      ['a limit outside its range', { maxTimesPerWeekSameMeal: 0 }, 'maxTimesPerWeekSameMeal'],
    ])('refuses %s, and changes nothing', async (_name, body, part) => {
      const refused = await patch(body).expect(400);

      expect(refused.body.error).toBe('VALIDATION_FAILED');
      expect(refused.body.issues[0].path).toBe(part);
      expect(await stored()).toEqual(profile);
    });

    it('gives a profile from before preferences were kept the ones a new profile starts with, and the change', async () => {
      await t.prisma.profilePreference.deleteMany({ where: { profileId: profile.id } });

      const changed: Profile = (await patch({ allergens: ['soy'] }).expect(200)).body;

      expect(changed.preferences).toMatchObject({ allergens: ['soy'], favoriteIngredientIds: [], maxConsecutiveDaysSameMeal: 2, maxTimesPerWeekSameMeal: 3 });
    });
  });

  it('is one of as many as an account may have, however many more are asked for together', async () => {
    const another = { name: 'Another', age: 30, sex: 'male', heightCm: 180, weightKg: 80 };

    const answers = await race(DEFAULT_PROFILES_PER_ACCOUNT + 3, () => t.http().post('/api/profiles').set(as(user)).send(another));

    const made = answers.flatMap((answer) => (answer.status === 'fulfilled' ? [answer.value] : []));
    expect(made).toHaveLength(DEFAULT_PROFILES_PER_ACCOUNT + 3);
    // The account has one already.
    expect(made.filter((answer) => answer.status === 201)).toHaveLength(DEFAULT_PROFILES_PER_ACCOUNT - 1);
    expect(new Set(made.filter((answer) => answer.status !== 201).map((answer) => `${answer.status} ${answer.body.error}`))).toEqual(new Set(['409 PROFILE_LIMIT_REACHED']));
    expect(await t.prisma.profile.count({ where: { userId: user.id } })).toBe(DEFAULT_PROFILES_PER_ACCOUNT);
  });
});
