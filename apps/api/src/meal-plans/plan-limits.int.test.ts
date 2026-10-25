// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { PLAN_RELAXATIONS, ProfileInput, type MealPlan, type Profile } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, as, aSwap, aUser, race, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

describe('the limits of a plan', () => {
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

  const generate = (body: Record<string, unknown>) =>
    t
      .http()
      .post('/api/meal-plans/generate')
      .set(as(user))
      .send({ profileId: profile.id, startDate: '2026-01-05', ...body });
  const regenerate = (plan: MealPlan, body?: Record<string, unknown>) =>
    t.http().post(`/api/meal-plans/${plan.id}/regenerate`).set(as(user)).send(body);
  const fresh = async (plan: MealPlan): Promise<MealPlan> =>
    (await t.http().get(`/api/meal-plans/${plan.id}`).set(as(user)).expect(200)).body;

  // The catalogue has five breakfasts. Six days of breakfast and dinner with no recipe twice: the sixth
  // breakfast has none left, and nothing else is short.
  const sixBreakfasts = { durationDays: 6, mealCount: 2, maxRepeatsPerRecipe: 1 };
  const theSixth = { date: '2026-01-10', slot: 'breakfast', gaveWay: ['variety_floor'] };

  it('refuses a plan that could only be filled outside them, says which limits and which meals, and writes nothing', async () => {
    const refused = await generate(sixBreakfasts).expect(422);

    expect(refused.body).toMatchObject({
      error: 'PLAN_NEEDS_RELAXATION',
      details: { needs: ['variety_floor'], meals: [theSixth] },
    });
    expect(await t.prisma.mealPlan.count()).toBe(0);
  });

  it('makes the plan once the limits it named may give way, and says on the plan which meal is outside which', async () => {
    const made: MealPlan = (
      await generate({ ...sixBreakfasts, allowRelaxations: ['variety_floor'] }).expect(201)
    ).body;

    expect(made.options.allowRelaxations).toEqual(['variety_floor']);
    expect(made.report).toEqual({ relaxations: [theSixth], singleCandidate: [], pantry: 'empty' });
    // The limit gave way where it had to, and nowhere else.
    const breakfasts = made.days.map(
      (day) => day.meals.find((meal) => meal.mealType === 'breakfast')!.recipe!.id,
    );
    expect(new Set(breakfasts.slice(0, 5)).size).toBe(5);
    const dinners = made.days.map(
      (day) => day.meals.find((meal) => meal.mealType === 'dinner')!.recipe!.id,
    );
    expect(new Set(dinners).size).toBe(6);
  });

  it('does not let a limit give way that was not named', async () => {
    const refused = await generate({
      ...sixBreakfasts,
      allowRelaxations: ['weekly_cap', 'cook_time'],
    }).expect(422);

    expect(refused.body.details.needs).toEqual(['variety_floor']);
  });

  it('refuses a limit it does not know', async () => {
    await generate({ ...sixBreakfasts, allowRelaxations: ['calories'] }).expect(400);
  });

  it('is made again with what it may let give way, and is refused, unchanged, once that is taken back', async () => {
    const made: MealPlan = (
      await generate({ ...sixBreakfasts, allowRelaxations: ['variety_floor'] }).expect(201)
    ).body;

    const again: MealPlan = (await regenerate(made).expect(201)).body;
    expect(again.report!.relaxations).toEqual([theSixth]);

    const refused = await regenerate(again, { allowRelaxations: [] }).expect(422);
    expect(refused.body).toMatchObject({
      error: 'PLAN_NEEDS_RELAXATION',
      details: { needs: ['variety_floor'], meals: [theSixth] },
    });
    const after = await fresh(again);
    expect(after.revision).toBe(again.revision);
    expect(after.options.allowRelaxations).toEqual(['variety_floor']);
    expect(after.days.map((day) => day.meals.map((meal) => meal.id))).toEqual(
      again.days.map((day) => day.meals.map((meal) => meal.id)),
    );
  });

  it('keeps with the plan what a later regeneration let give way', async () => {
    // Made inside its limits; then the floor is as tight as before, by way of the profile's limit for a week.
    const strict: MealPlan = (await generate({ durationDays: 6, mealCount: 2 }).expect(201)).body;
    expect(strict.report).toEqual({ relaxations: [], singleCandidate: [], pantry: 'empty' });
    await t.prisma.profilePreference.update({
      where: { profileId: profile.id },
      data: { maxTimesPerWeekSameMeal: 1 },
    });

    expect((await regenerate(strict).expect(422)).body.details.needs).toEqual(['weekly_cap']);
    const allowed: MealPlan = (
      await regenerate(strict, { allowRelaxations: ['weekly_cap'] }).expect(201)
    ).body;

    expect(allowed.options.allowRelaxations).toEqual(['weekly_cap']);
    expect(allowed.report!.relaxations).toEqual([
      { date: '2026-01-10', slot: 'breakfast', gaveWay: ['weekly_cap'] },
    ]);
    // From here on the plan is made again without asking.
    await regenerate(allowed).expect(201);
  });

  describe('a day with less cooking time than any recipe takes', () => {
    // Every recipe of the catalogue takes twenty minutes.
    const aRushedDay = {
      durationDays: 2,
      dayOverrides: [{ date: '2026-01-06', cookTimeBudgetMinutes: 15 }],
    };
    const outsideOnTheSecondDay = ['breakfast', 'lunch', 'dinner'].map((slot) => ({
      date: '2026-01-06',
      slot,
      gaveWay: ['cook_time'],
    }));

    it('is refused with every meal of that day named, and made once the cooking time may give way', async () => {
      const refused = await generate(aRushedDay).expect(422);
      expect(refused.body.details).toEqual({ needs: ['cook_time'], meals: outsideOnTheSecondDay });

      const made: MealPlan = (
        await generate({ ...aRushedDay, allowRelaxations: ['cook_time'] }).expect(201)
      ).body;
      expect(made.report!.relaxations).toEqual(outsideOnTheSecondDay);
    });

    it('is changed on its own within what the plan may let give way, or within what the request says', async () => {
      const made: MealPlan = (
        await generate({ ...aRushedDay, allowRelaxations: ['cook_time'] }).expect(201)
      ).body;
      const changeDay = (body?: Record<string, unknown>) =>
        t
          .http()
          .post(`/api/meal-plans/${made.id}/days/${made.days[1]!.id}/regenerate`)
          .set(as(user))
          .send(body);

      const changed: MealPlan = (await changeDay().expect(201)).body;
      // What the report says of that day is what the new run found.
      expect(changed.report!.relaxations).toEqual(outsideOnTheSecondDay);

      expect((await changeDay({ allowRelaxations: [] }).expect(422)).body.details).toEqual({
        needs: ['cook_time'],
        meals: outsideOnTheSecondDay,
      });
      // What a request says for one day is not kept with the plan.
      expect((await fresh(made)).options.allowRelaxations).toEqual(['cook_time']);
    });
  });

  it('says nothing any more of a meal that was changed since', async () => {
    const made: MealPlan = (
      await generate({ ...sixBreakfasts, allowRelaxations: ['variety_floor'] }).expect(201)
    ).body;
    const sixth = made.days[5]!.meals.find((meal) => meal.mealType === 'breakfast')!;

    const swapped = await aSwap(t, user, {
      planId: made.id,
      plannedMealId: sixth.id,
      strategy: 'random',
    });

    expect(swapped.plan.report).toEqual({ relaxations: [], singleCandidate: [], pantry: 'empty' });
  });

  it('reports the meals for which there was one recipe to choose from', async () => {
    // Four of the five second breakfasts are marked to avoid.
    const avoided = await t.prisma.recipe.findMany({
      where: {
        slug: {
          in: ['oat-porridge-with-banana', 'banana-oat-shake', 'egg-sandwich', 'yogurt-oat-cup'],
        },
      },
    });
    await t.prisma.favorite.createMany({
      data: avoided.map((recipe) => ({
        profileId: profile.id,
        recipeId: recipe.id,
        sentiment: 'avoid' as const,
      })),
    });

    const made: MealPlan = (await generate({ durationDays: 2, mealCount: 5 }).expect(201)).body;

    expect(made.report).toEqual({
      relaxations: [],
      singleCandidate: [
        { date: '2026-01-05', slot: 'second_breakfast' },
        { date: '2026-01-06', slot: 'second_breakfast' },
      ],
      pantry: 'empty',
    });
  });

  describe('the most of one ingredient in a week', () => {
    const halfAKilo = () =>
      t.prisma.profilePreference.update({
        where: { profileId: profile.id },
        data: { maxWeeklyAmountPerIngredient: 500 },
      });
    /** The most of any one ingredient that the meals of a plan hold together. */
    const mostOfOne = (plan: MealPlan): number => {
      const held = new Map<string, number>();
      for (const day of plan.days) {
        for (const meal of day.meals)
          for (const line of meal.ingredients)
            held.set(line.ingredientId, (held.get(line.ingredientId) ?? 0) + line.quantity);
      }
      return Math.max(...held.values());
    };
    // Breakfast and dinner take a whole day's energy between them, so most dishes are served in amounts over half a kilogram of something.
    const oneDay = { durationDays: 1, mealCount: 2 };

    it('is part of the profile, within what it may be set to', async () => {
      expect(profile.preferences.maxWeeklyAmountPerIngredient).toBe(3000);
      const save = (amount: number) =>
        t
          .http()
          .put(`/api/profiles/${profile.id}`)
          .set(as(user))
          .send({
            ...ProfileInput.parse(profile),
            preferences: { ...profile.preferences, maxWeeklyAmountPerIngredient: amount },
          });

      expect((await save(800).expect(200)).body.preferences.maxWeeklyAmountPerIngredient).toBe(800);
      await save(100).expect(400);
      await save(20_000).expect(400);
    });

    it('keeps the meals of a plan under it, where the recipes allow', async () => {
      let without = 0;
      for (let i = 0; i < 10; i += 1)
        without = Math.max(without, mostOfOne(await aPlan(t, user, profile, oneDay)));
      // Left to themselves, plans hold more than half a kilogram of something.
      expect(without).toBeGreaterThan(500);

      await halfAKilo();
      for (let i = 0; i < 10; i += 1)
        expect(mostOfOne(await aPlan(t, user, profile, oneDay))).toBeLessThanOrEqual(500);
    });

    it('stands in the way of a week that cannot stay under it, and gives way when the request says it may', async () => {
      await halfAKilo();

      const refused = await generate({ durationDays: 7, mealCount: 2 }).expect(422);
      expect(refused.body.details.needs).toContain('ingredient_cap');

      const made: MealPlan = (
        await generate({
          durationDays: 7,
          mealCount: 2,
          allowRelaxations: [...PLAN_RELAXATIONS],
        }).expect(201)
      ).body;
      expect(made.report!.relaxations.some((meal) => meal.gaveWay.includes('ingredient_cap'))).toBe(
        true,
      );
    });
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

    it('says that the pantry counted, and counts the plan as one made with it', async () => {
      const made: MealPlan = (await generate({ durationDays: 2 }).expect(201)).body;

      expect(made.report!.pantry).toBe('counted');
      expect(await streak()).toBe(1);
    });

    it('does not count a plan that was refused', async () => {
      await generate(sixBreakfasts).expect(422);
      expect(await streak()).toBe(0);

      await generate({ ...sixBreakfasts, allowRelaxations: ['variety_floor'] }).expect(201);
      expect(await streak()).toBe(1);
    });

    it('says when no recipe uses what is in it, and when the plan was asked to leave it aside', async () => {
      const pepper = await t.prisma.ingredient.create({
        data: {
          slug: 'pantry-only-pepper',
          name: 'Pantry-only pepper',
          category: 'spices',
          canonicalUnit: 'g',
          caloriesPer100: 250,
          proteinPer100: 10,
          fatPer100: 3,
          carbsPer100: 60,
        },
      });
      await t.prisma.inventoryItem.deleteMany({ where: { profileId: profile.id } });
      await t.prisma.inventoryItem.create({
        data: { profileId: profile.id, ingredientId: pepper.id, quantity: 50, unit: 'g' },
      });
      try {
        expect(
          ((await generate({ durationDays: 2 }).expect(201)).body as MealPlan).report!.pantry,
        ).toBe('unused');
        expect(
          (
            (
              await generate({
                durationDays: 2,
                startDate: '2026-02-02',
                respectInventory: false,
              }).expect(201)
            ).body as MealPlan
          ).report!.pantry,
        ).toBe('not_asked');
        expect(await streak()).toBe(0);
      } finally {
        await t.prisma.inventoryItem.deleteMany({ where: { profileId: profile.id } });
        await t.prisma.ingredient.delete({ where: { id: pepper.id } });
      }
    });

    it('counts a plan that is made again, and not a day or a few days of it filled again', async () => {
      const made: MealPlan = (await generate({ durationDays: 3 }).expect(201)).body;
      expect(await streak()).toBe(1);

      await t
        .http()
        .post(`/api/meal-plans/${made.id}/days/${made.days[1]!.id}/regenerate`)
        .set(as(user))
        .send({ includePast: true })
        .expect(201);
      await t
        .http()
        .post(`/api/meal-plans/${made.id}/regenerate`)
        .set(as(user))
        .send({ from: made.days[0]!.date, to: made.days[1]!.date, includePast: true })
        .expect(201);
      expect(await streak()).toBe(1);

      await t
        .http()
        .post(`/api/meal-plans/${made.id}/regenerate`)
        .set(as(user))
        .send({ includePast: true })
        .expect(201);
      expect(await streak()).toBe(2);
    });

    it('loses no step when plans are made at the same moment', async () => {
      const made = await race(4, (index) =>
        generate({ durationDays: 1, startDate: `2026-03-0${index + 1}` }).then((res) => res.status),
      );

      expect(made.map((result) => (result.status === 'fulfilled' ? result.value : 0))).toEqual([
        201, 201, 201, 201,
      ]);
      expect(await streak()).toBe(4);
    });

    it('says that the pantry did not count in the round that leaves it out', async () => {
      await t.prisma.profile.update({
        where: { id: profile.id },
        data: { inventoryBiasStreak: 5 },
      });

      const made: MealPlan = (await generate({ durationDays: 2 }).expect(201)).body;

      expect(made.report!.pantry).toBe('left_out');
      expect(await streak()).toBe(0);
    });
  });
});
