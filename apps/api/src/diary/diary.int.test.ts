// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type {
  DaySettingsPreview,
  DayVariations,
  DiaryCopyResult,
  DiaryDay,
  DiaryEntry,
  MealPlan,
  PlanCalendar,
  Profile,
  RebalanceResult,
} from '@diet-app/shared';
import { DIARY_DAYS_BACK, MAX_DIARY_ENTRIES_A_DAY } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aPrivateRecipe, aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

const DAY_MS = 86_400_000;
/** The day `offset` days from today: the API takes a client's date only near its own. */
const day = (offset: number): string =>
  new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);

describe('the diary of a profile', () => {
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

  /** Write an entry for the profile, on the client's today unless it says otherwise. */
  const write = (
    entry: Record<string, unknown>,
    { key, today = day(0), locale }: { key?: string; today?: string; locale?: string } = {},
  ) => {
    const request = t.http().post('/api/diary/entries').set(as(user)).set('X-Client-Date', today);
    if (key) request.set('Idempotency-Key', key);
    if (locale) request.set('Accept-Language', locale);
    return request.send({ profileId: profile.id, date: day(0), mealType: 'lunch', ...entry });
  };
  const written = async (entry: Record<string, unknown>): Promise<DiaryEntry> =>
    (await write(entry).expect(201)).body;
  const aMeal = (calories: number, date = day(0)) =>
    written({
      kind: 'meal',
      name: 'Out',
      date,
      nutrition: { calories, protein: 0, fat: 0, carbs: calories / 4 },
    });
  const dayOf = async (date: string, locale = 'en'): Promise<DiaryDay> =>
    (
      await t
        .http()
        .get(`/api/diary/day?profileId=${profile.id}&date=${date}`)
        .set(as(user))
        .set('Accept-Language', locale)
        .expect(200)
    ).body;
  const planOf = async (id: string): Promise<MealPlan> =>
    (await t.http().get(`/api/meal-plans/${id}`).set(as(user)).expect(200)).body;
  const ingredient = (slug: string) => t.prisma.ingredient.findFirstOrThrow({ where: { slug } });
  const aLibraryRecipe = () =>
    t.prisma.recipe.findFirstOrThrow({
      where: { createdByUserId: null, mealTypes: { has: 'lunch' } },
      orderBy: { slug: 'asc' },
    });

  describe('a day no plan holds', () => {
    it("aims at the profile's own target, and holds nothing until something is written", async () => {
      const own = (
        await t.http().get(`/api/profiles/${profile.id}/calories`).set(as(user)).expect(200)
      ).body;

      const shown = await dayOf(day(-3));

      expect(shown).toEqual({
        profileId: profile.id,
        date: day(-3),
        target: { calories: own.dailyTarget, ...own.targetMacros, from: 'profile' },
        plan: null,
        entries: [],
        eaten: { calories: 0, protein: 0, fat: 0, carbs: 0 },
        estimated: false,
      });
    });
  });

  describe('an entry', () => {
    it('of a recipe holds its servings, with the figures of one serving worked out when it was written', async () => {
      const recipe = await aLibraryRecipe();

      const entry = await written({ kind: 'recipe', recipeId: recipe.id, servings: 1.5 });

      expect(entry).toMatchObject({
        kind: 'recipe',
        recipeId: recipe.id,
        ingredientId: null,
        name: recipe.title,
        servings: 1.5,
        amount: null,
        estimated: false,
        nutrition: {
          calories: Math.round(recipe.caloriesPerServing * 1.5),
          protein: Math.round(recipe.proteinPerServing * 1.5),
          fat: Math.round(recipe.fatPerServing * 1.5),
          carbs: Math.round(recipe.carbsPerServing * 1.5),
        },
      });
      // A later change of the recipe does not rewrite what was eaten.
      await t.prisma.recipe.update({
        where: { id: recipe.id },
        data: { caloriesPerServing: recipe.caloriesPerServing * 2 },
      });
      try {
        expect((await dayOf(day(0))).entries[0]!.nutrition).toEqual(entry.nutrition);
      } finally {
        await t.prisma.recipe.update({
          where: { id: recipe.id },
          data: { caloriesPerServing: recipe.caloriesPerServing },
        });
      }
    });

    it('of an ingredient holds its amount in a unit it converts from, shown as a person reads it', async () => {
      // 360 kcal, 7 g of protein, 0.6 g of fat and 79 g of carbohydrate in 100 g.
      const rice = await ingredient('white-rice');
      // 143 kcal, 13, 9.5 and 1.1 g in 100 g; a piece weighs 55 g.
      const egg = await ingredient('large-egg');

      const ofRice = await written({
        kind: 'ingredient',
        ingredientId: rice.id,
        amount: { quantity: 200, unit: 'g' },
      });
      const ofEggs = await written({
        kind: 'ingredient',
        ingredientId: egg.id,
        amount: { quantity: 2, unit: 'piece' },
      });

      expect(ofRice).toMatchObject({
        kind: 'ingredient',
        ingredientId: rice.id,
        recipeId: null,
        servings: null,
        amount: { quantity: 200, unit: 'g', shown: { quantity: 200, unit: 'g' } },
        nutrition: { calories: 720, protein: 14, fat: 1, carbs: 158 },
      });
      // Two eggs are 110 g.
      expect(ofEggs).toMatchObject({
        amount: { quantity: 2, unit: 'piece', shown: { quantity: 2, unit: 'piece' } },
        nutrition: { calories: 157, protein: 14, fat: 10, carbs: 1 },
      });
    });

    it('is refused for a unit its ingredient cannot be given in, and for an ingredient taken out of the catalogue', async () => {
      const rice = await ingredient('white-rice');
      const banana = await ingredient('banana');

      const unit = await write({
        kind: 'ingredient',
        ingredientId: rice.id,
        amount: { quantity: 2, unit: 'piece' },
      }).expect(400);
      await t.prisma.ingredient.update({
        where: { id: banana.id },
        data: { retiredAt: new Date() },
      });
      try {
        const retired = await write({
          kind: 'ingredient',
          ingredientId: banana.id,
          amount: { quantity: 100, unit: 'g' },
        }).expect(404);

        expect(unit.body.error).toBe('DIARY_UNIT_NOT_CONVERTIBLE');
        expect(retired.body.error).toBe('INGREDIENT_NOT_FOUND');
        expect(await t.prisma.diaryEntry.count()).toBe(0);
      } finally {
        await t.prisma.ingredient.update({ where: { id: banana.id }, data: { retiredAt: null } });
      }
    });

    it('of a meal of one’s own holds its figures as typed, for the servings it was', async () => {
      const entry = await written({
        kind: 'meal',
        name: 'Pierogi at Gran’s',
        servings: 2,
        nutrition: { calories: 500, protein: 30, fat: 20, carbs: 50 },
      });

      expect(entry).toMatchObject({
        kind: 'meal',
        name: 'Pierogi at Gran’s',
        servings: 2,
        amount: null,
        estimated: false,
        nutrition: { calories: 1000, protein: 60, fat: 40, carbs: 100 },
      });
    });

    it("of a meal of one's own known by its energy has the macronutrients left out estimated from the day's split, and says so", async () => {
      // The profile is on the balanced diet: a quarter of the energy from protein, 30 % from fat, 45 % from carbohydrate.
      const byEnergy = await written({ kind: 'meal', name: 'Lunch', nutrition: { calories: 600 } });
      // 30 g of protein carry 120 kcal of 500; fat and carbohydrate share the 380 left, 30 to 45.
      const byPart = await written({
        kind: 'meal',
        name: 'Snack',
        nutrition: { calories: 500, protein: 30 },
      });

      expect(byEnergy).toMatchObject({
        estimated: true,
        nutrition: { calories: 600, protein: 38, fat: 20, carbs: 68 },
      });
      expect(byPart).toMatchObject({
        estimated: true,
        nutrition: { calories: 500, protein: 30, fat: 17, carbs: 57 },
      });
      expect((await dayOf(day(0))).estimated).toBe(true);
    });

    it('is refused where the macronutrients given carry clearly more energy than the whole', async () => {
      const refused = await write({
        kind: 'meal',
        name: 'Typo',
        nutrition: { calories: 100, protein: 50 },
      }).expect(400);

      expect(refused.body.error).toBe('DIARY_MACROS_OVER_ENERGY');
    });

    it("takes a recipe of the library and of the account's own, and none of another account's or one its owner deleted", async () => {
      const own = await aPrivateRecipe(t, user);
      const theirs = await aPrivateRecipe(t, await aUser(t));
      const gone = await aPrivateRecipe(t, user, { title: 'Gone' });
      await t.http().delete(`/api/recipes/${gone.id}`).set(as(user)).expect(204);

      await write({ kind: 'recipe', recipeId: own.id, servings: 1 }).expect(201);
      const other = await write({ kind: 'recipe', recipeId: theirs.id, servings: 1 }).expect(404);
      const deleted = await write({ kind: 'recipe', recipeId: gone.id, servings: 1 }).expect(404);

      expect([other.body.error, deleted.body.error]).toEqual([
        'RECIPE_NOT_FOUND',
        'RECIPE_NOT_FOUND',
      ]);
    });

    it("is written for the client's today and the days before it, never a day still to come", async () => {
      const ahead = await write({
        kind: 'meal',
        name: 'Later',
        nutrition: { calories: 100 },
        date: day(1),
      }).expect(409);
      // Where the client is, it may be tomorrow already.
      await write(
        { kind: 'meal', name: 'In Tokyo', nutrition: { calories: 100 }, date: day(1) },
        { today: day(1) },
      ).expect(201);
      await write({
        kind: 'meal',
        name: 'Last week',
        nutrition: { calories: 100 },
        date: day(-7),
      }).expect(201);

      expect(ahead.body.error).toBe('DIARY_DAY_AHEAD');
    });

    it('is written at most a year back, and naming an older today gets no further', async () => {
      const entry = (date: string) => ({
        kind: 'meal',
        name: 'Long ago',
        nutrition: { calories: 100 },
        date,
      });
      const oldest = day(-DIARY_DAYS_BACK);
      const older = day(-DIARY_DAYS_BACK - 1);

      await write(entry(oldest)).expect(201);
      const refused = await write(entry(older)).expect(409);
      // A client whose day is still yesterday reaches a day further, and that is all it can do.
      await write(entry(older), { today: day(-1) }).expect(201);
      const named = await write(entry(day(-DIARY_DAYS_BACK - 2)), { today: day(-1) }).expect(409);
      await write(entry(older), { today: older }).expect(400);
      // A client that names no day goes by the server's.
      const unnamed = await t
        .http()
        .post('/api/diary/entries')
        .set(as(user))
        .send({ profileId: profile.id, mealType: 'lunch', ...entry(older) })
        .expect(409);

      expect([refused.body.error, named.body.error, unnamed.body.error]).toEqual([
        'DIARY_DAY_TOO_OLD',
        'DIARY_DAY_TOO_OLD',
        'DIARY_DAY_TOO_OLD',
      ]);
    });

    it('can still be changed and removed once its day is more than a year back', async () => {
      const row = await t.prisma.diaryEntry.create({
        data: {
          profileId: profile.id,
          date: new Date(day(-DIARY_DAYS_BACK - 30)),
          mealType: 'lunch',
          kind: 'meal',
          name: 'Long ago',
          servings: 1,
          calories: 100,
          protein: 5,
          fat: 2,
          carbs: 15,
        },
      });

      const changed = await t
        .http()
        .patch(`/api/diary/entries/${row.id}`)
        .set(as(user))
        .send({ servings: 2 })
        .expect(200);
      await t.http().delete(`/api/diary/entries/${row.id}`).set(as(user)).expect(204);

      expect(changed.body.nutrition.calories).toBe(200);
      expect((await dayOf(day(-DIARY_DAYS_BACK - 30))).entries).toEqual([]);
    });

    it('is one of at most forty a day, however many requests come together', async () => {
      await t.prisma.diaryEntry.createMany({
        data: Array.from({ length: MAX_DIARY_ENTRIES_A_DAY - 5 }, () => ({
          profileId: profile.id,
          date: new Date(day(0)),
          mealType: 'snack',
          kind: 'meal' as const,
          name: 'Nut',
          servings: 1,
          calories: 10,
          protein: 0,
          fat: 1,
          carbs: 0,
        })),
      });

      // Ten for the five places left.
      const answers = await Promise.all(
        Array.from({ length: 10 }, () =>
          write({ kind: 'meal', name: 'Nut', nutrition: { calories: 10 } }),
        ),
      );

      expect(answers.map((answer) => answer.status).sort()).toEqual([
        ...Array<number>(5).fill(201),
        ...Array<number>(5).fill(409),
      ]);
      expect(answers.find((answer) => answer.status === 409)!.body.error).toBe('DIARY_DAY_FULL');
      expect(await t.prisma.diaryEntry.count({ where: { date: new Date(day(0)) } })).toBe(
        MAX_DIARY_ENTRIES_A_DAY,
      );
      // Another day has room of its own.
      await write({ kind: 'meal', name: 'Nut', nutrition: { calories: 10 }, date: day(-1) }).expect(
        201,
      );
    });

    it('is written once however many times it is sent with its key, and the key is not taken for another', async () => {
      const entry = { kind: 'meal', name: 'Soup', nutrition: { calories: 300 } };

      const first = await write(entry, { key: 'diary-1' }).expect(201);
      const again = await write(entry, { key: 'diary-1' }).expect(201);
      const other = await write({ ...entry, name: 'Stew' }, { key: 'diary-1' }).expect(422);

      expect(again.body).toEqual(first.body);
      expect(other.body.error).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(await t.prisma.diaryEntry.count()).toBe(1);
    });

    it('is named in the language of whoever reads it while what it is of is there, and by the name it was written with after', async () => {
      const lonely = await t.prisma.ingredient.create({
        data: {
          slug: 'lonely-fruit',
          name: 'Lonely fruit',
          category: 'fruits',
          canonicalUnit: 'g',
          caloriesPer100: 50,
          proteinPer100: 1,
          fatPer100: 0,
          carbsPer100: 12,
          translations: { create: [{ locale: 'pl', name: 'Samotny owoc' }] },
        },
      });

      const entry = (
        await write(
          { kind: 'ingredient', ingredientId: lonely.id, amount: { quantity: 100, unit: 'g' } },
          { locale: 'pl' },
        ).expect(201)
      ).body as DiaryEntry;
      const inEnglish = (await dayOf(day(0), 'en')).entries[0]!;
      await t.prisma.ingredient.delete({ where: { id: lonely.id } });
      const gone = (await dayOf(day(0), 'en')).entries[0]!;

      expect(entry.name).toBe('Samotny owoc');
      expect(inEnglish.name).toBe('Lonely fruit');
      expect(gone).toMatchObject({
        name: 'Samotny owoc',
        ingredientId: null,
        amount: { quantity: 100, unit: 'g', shown: { quantity: 100, unit: 'g' } },
        nutrition: { calories: 50, protein: 1, fat: 0, carbs: 12 },
      });
    });
  });

  describe('a change of an entry', () => {
    it('moves it to another meal, and changes its figures in proportion to its amount', async () => {
      const recipe = await aLibraryRecipe();
      const rice = await ingredient('white-rice');
      const ofRecipe = await written({ kind: 'recipe', recipeId: recipe.id, servings: 1 });
      const ofRice = await written({
        kind: 'ingredient',
        ingredientId: rice.id,
        amount: { quantity: 200, unit: 'g' },
      });

      const doubled = (
        await t
          .http()
          .patch(`/api/diary/entries/${ofRecipe.id}`)
          .set(as(user))
          .send({ servings: 2, mealType: 'dinner' })
          .expect(200)
      ).body as DiaryEntry;
      const halved = (
        await t
          .http()
          .patch(`/api/diary/entries/${ofRice.id}`)
          .set(as(user))
          .send({ quantity: 100 })
          .expect(200)
      ).body as DiaryEntry;

      expect(doubled).toMatchObject({
        mealType: 'dinner',
        servings: 2,
        nutrition: {
          calories: Math.round(recipe.caloriesPerServing * 2),
          protein: Math.round(recipe.proteinPerServing * 2),
        },
      });
      expect(halved).toMatchObject({
        amount: { quantity: 100, unit: 'g' },
        nutrition: { calories: 360, protein: 7, fat: 1, carbs: 79 },
      });
    });

    it('takes servings for a recipe or a meal, a quantity for an ingredient, and no more of it than a day holds', async () => {
      const egg = await ingredient('large-egg');
      const ofEggs = await written({
        kind: 'ingredient',
        ingredientId: egg.id,
        amount: { quantity: 2, unit: 'piece' },
      });
      const meal = await written({ kind: 'meal', name: 'Soup', nutrition: { calories: 300 } });
      const change = (id: string, body: object) =>
        t.http().patch(`/api/diary/entries/${id}`).set(as(user)).send(body);

      const servings = await change(ofEggs.id, { servings: 2 }).expect(400);
      const quantity = await change(meal.id, { quantity: 2 }).expect(400);
      // Fifty pieces of one food is the most of a day.
      const tooMany = await change(ofEggs.id, { quantity: 60 }).expect(400);
      await change(ofEggs.id, { quantity: 4 }).expect(200);

      expect([servings, quantity, tooMany].map((answer) => answer.body.issues[0].path)).toEqual([
        'servings',
        'quantity',
        'quantity',
      ]);
      expect((await dayOf(day(0))).entries.map((entry) => entry.nutrition.calories)).toEqual([
        315, 300,
      ]);
    });

    it('takes it away, and answers one that is gone as not there', async () => {
      const entry = await aMeal(300);

      await t.http().delete(`/api/diary/entries/${entry.id}`).set(as(user)).expect(204);
      const again = await t
        .http()
        .delete(`/api/diary/entries/${entry.id}`)
        .set(as(user))
        .expect(404);
      const changed = await t
        .http()
        .patch(`/api/diary/entries/${entry.id}`)
        .set(as(user))
        .send({ servings: 2 })
        .expect(404);

      expect([again.body.error, changed.body.error]).toEqual([
        'DIARY_ENTRY_NOT_FOUND',
        'DIARY_ENTRY_NOT_FOUND',
      ]);
    });
  });

  describe('a day a plan holds', () => {
    /** A plan of yesterday, today and tomorrow. */
    let plan: MealPlan;

    beforeEach(async () => {
      plan = await aPlan(t, user, profile, { startDate: day(-1), durationDays: 3 });
    });

    const planDay = (of: MealPlan, date: string) => of.days.find((d) => d.date === date)!;
    const mealsKcal = (of: MealPlan['days'][number]) =>
      of.meals.reduce((sum, meal) => sum + meal.nutrition.calories, 0);
    const eat = async (mealId: string): Promise<RebalanceResult> =>
      (
        await t
          .http()
          .patch(`/api/meal-plans/${plan.id}/meals/${mealId}/eaten`)
          .set(as(user))
          .send({ eaten: true })
          .expect(200)
      ).body;
    const rebalance = async (body: object): Promise<RebalanceResult> =>
      (
        await t
          .http()
          .post(`/api/meal-plans/${plan.id}/rebalance`)
          .set(as(user))
          .set('X-Client-Date', day(0))
          .send(body)
          .expect(201)
      ).body;

    it("aims at the plan's day, shows its meals, and counts those marked as eaten with the entries", async () => {
      const today = planDay(plan, day(0));
      const first = today.meals[0]!;
      await eat(first.id);
      const entry = await aMeal(300);

      const shown = await dayOf(day(0));

      expect(shown.target).toEqual({
        calories: today.calorieTarget,
        ...today.targetMacros,
        from: 'plan',
      });
      expect(shown.plan!.id).toBe(plan.id);
      expect(shown.plan!.meals.map((meal) => [meal.id, meal.mealType, meal.name])).toEqual(
        today.meals.map((meal) => [meal.id, meal.mealType, meal.recipe!.title]),
      );
      expect(shown.plan!.meals.map((meal) => meal.eaten)).toEqual(
        today.meals.map((meal) => meal.id === first.id),
      );
      const eatenMeal = (await planOf(plan.id)).days
        .find((d) => d.date === day(0))!
        .meals.find((meal) => meal.id === first.id)!;
      expect(shown.eaten.calories).toBe(eatenMeal.nutrition.calories + entry.nutrition.calories);
    });

    it('goes by the plan made last where several hold the day', async () => {
      const later = await aPlan(t, user, profile, { startDate: day(0), durationDays: 1 });

      expect((await dayOf(day(0))).plan!.id).toBe(later.id);
      expect((await dayOf(day(-1))).plan!.id).toBe(plan.id);
    });

    it('counts the entries in the day of the plan, in where it stands and in the calendar', async () => {
      const before = planDay(plan, day(0));
      await aMeal(1200);

      const after = planDay(await planOf(plan.id), day(0));
      const calendar = (
        await t
          .http()
          .get(`/api/meal-plans/calendar?profileId=${profile.id}&from=${day(-1)}&to=${day(1)}`)
          .set(as(user))
          .expect(200)
      ).body as PlanCalendar;
      const shown = await dayOf(day(0));

      expect(after.diary).toEqual({
        entries: 1,
        nutrition: { calories: 1200, protein: 0, fat: 0, carbs: 300 },
      });
      expect(after.dayNutrition.calories).toBe(before.dayNutrition.calories + 1200);
      expect(after.calorieDelta).toBe(after.dayNutrition.calories - after.calorieTarget);
      expect(after.offTarget).toBe('over');
      expect(planDay(await planOf(plan.id), day(1)).diary).toBeNull();
      expect(calendar.days.find((d) => d.date === day(0))).toMatchObject({
        calories: after.dayNutrition.calories,
        offTarget: 'over',
      });
      expect(shown.plan).toMatchObject({ calorieDelta: after.calorieDelta, offTarget: 'over' });
    });

    it('leaves room for the entries when the day is rebalanced, so that a second rebalance changes nothing', async () => {
      await aMeal(600);

      const first = await rebalance({ scope: 'day', date: day(0) });
      const second = await rebalance({ scope: 'day', date: day(0) });

      const today = planDay(first.plan, day(0));
      expect(first.rebalance!.changes.length).toBeGreaterThan(0);
      expect(today.offTarget).toBeNull();
      expect(Math.abs(today.dayNutrition.calories - today.calorieTarget)).toBeLessThanOrEqual(
        today.calorieTarget * 0.1,
      );
      expect(second.rebalance!.changes).toEqual([]);
      // The day a meal is marked as eaten is rebalanced with the entries counted as well.
      const eaten = await eat(today.meals[0]!.id);
      expect(planDay(eaten.plan, day(0)).offTarget).toBeNull();
    });

    it('spreads what the entries of a day put over its target over the days from today on', async () => {
      const before = await planOf(plan.id);
      await aMeal(900, day(-1));

      const spread = await rebalance({ scope: 'plan', date: day(-1) });

      const kcal = (of: MealPlan, date: string) =>
        planDay(of, date).meals.reduce((sum, meal) => sum + meal.nutrition.calories, 0);
      // Yesterday is done with: its meals stay as they are, and today and tomorrow make up for it.
      expect(kcal(spread.plan, day(-1))).toBe(kcal(before, day(-1)));
      expect(kcal(spread.plan, day(0))).toBeLessThan(kcal(before, day(0)));
      expect(kcal(spread.plan, day(1))).toBeLessThan(kcal(before, day(1)));
    });

    it('makes the day again around its entries: the meals fill what is left of its target', async () => {
      await aMeal(900);
      const today = planDay(plan, day(0));

      const again = (
        await t
          .http()
          .post(`/api/meal-plans/${plan.id}/days/${today.id}/regenerate`)
          .set(as(user))
          .set('X-Client-Date', day(0))
          .send({})
          .expect(201)
      ).body as MealPlan;

      const made = planDay(again, day(0));
      expect(made.diary!.nutrition.calories).toBe(900);
      expect(made.offTarget).toBeNull();
      expect(made.dayNutrition.calories).toBe(mealsKcal(made) + 900);
      // A day of the plan without entries fills its whole target.
      expect(mealsKcal(made)).toBeLessThan(mealsKcal(planDay(again, day(1))) - 450);
      // Inside its window, the day has nothing left for a rebalance to do.
      expect((await rebalance({ scope: 'day', date: day(0) })).rebalance!.changes).toEqual([]);
    });

    it('fills every other way of the day around its entries, and counts them in its figures', async () => {
      await aMeal(900);
      const today = planDay(plan, day(0));

      const offered = (
        await t
          .http()
          .post(`/api/meal-plans/${plan.id}/days/${today.id}/variations`)
          .set(as(user))
          .set('X-Client-Date', day(0))
          .send({})
          .expect(200)
      ).body as DayVariations;

      expect(offered.diary).toEqual({ calories: 900, protein: 0, fat: 0, carbs: 225 });
      expect(offered.current.dayNutrition).toEqual(
        planDay(await planOf(plan.id), day(0)).dayNutrition,
      );
      expect(offered.variations.length).toBeGreaterThan(0);
      for (const way of offered.variations) {
        const meals = way.meals.reduce((sum, meal) => sum + meal.nutrition.calories, 0);
        expect(way.dayNutrition.calories).toBe(meals + 900);
        expect(Math.abs(way.dayNutrition.calories - today.calorieTarget)).toBeLessThanOrEqual(
          today.calorieTarget * 0.1,
        );
      }
      const taken = (
        await t
          .http()
          .post(`/api/meal-plans/${plan.id}/days/${today.id}/variations/take`)
          .set(as(user))
          .send({ offer: offered.variations[0]!.offer })
          .expect(200)
      ).body as MealPlan;
      expect(planDay(taken, day(0)).offTarget).toBeNull();
    });

    it('draws what a new number of meals brings around its entries', async () => {
      await aMeal(900);
      const today = planDay(await planOf(plan.id), day(0));
      const revision = (await planOf(plan.id)).revision;

      const changed = (
        await t
          .http()
          .put(`/api/meal-plans/${plan.id}/days/${today.id}/settings`)
          .set(as(user))
          .set('X-Client-Date', day(0))
          .send({
            dayType: 'normal',
            skip: false,
            mealCount: 4,
            calorieTarget: null,
            cookTimeBudgetMinutes: null,
            useUpBy: false,
            revision,
          })
          .expect(200)
      ).body as MealPlan;

      const made = planDay(changed, day(0));
      expect(made.meals).toHaveLength(4);
      expect(made.offTarget).toBeNull();
    });

    it('is filled around its entries by a new plan as well, and a day without any fills its whole target', async () => {
      await aMeal(900);

      const fresh = await aPlan(t, user, profile, { startDate: day(0), durationDays: 2 });

      const [first, second] = fresh.days;
      expect(first!.diary!.nutrition.calories).toBe(900);
      expect(first!.offTarget).toBeNull();
      expect(second!.diary).toBeNull();
      expect(second!.offTarget).toBeNull();
      expect(mealsKcal(first!)).toBeLessThan(mealsKcal(second!) - 450);
    });

    it('says that a new target of the day does not fit where its entries leave its meals too little room', async () => {
      await aMeal(3000);
      const today = planDay(plan, day(0));

      const preview = (
        await t
          .http()
          .post(`/api/meal-plans/${plan.id}/days/${today.id}/settings/preview`)
          .set(as(user))
          .set('X-Client-Date', day(0))
          .send({
            dayType: 'training',
            skip: false,
            mealCount: today.mealCount,
            calorieTarget: null,
            cookTimeBudgetMinutes: null,
            useUpBy: false,
          })
          .expect(200)
      ).body as DaySettingsPreview;

      // The meals go no smaller than half a serving: with 3,000 kcal eaten the day stays over.
      expect(preview.dayCalories).toBeGreaterThan(preview.calorieTarget.then);
      expect(preview.fits).toBe(false);
    });
  });

  describe('copying a day', () => {
    const copy = (body: object, { key, today = day(0) }: { key?: string; today?: string } = {}) => {
      const request = t.http().post('/api/diary/copy').set(as(user)).set('X-Client-Date', today);
      if (key) request.set('Idempotency-Key', key);
      return request.send({ profileId: profile.id, ...body });
    };

    it('brings the entries of the day and the meals its plan marked as eaten, as entries, in that order', async () => {
      const plan = await aPlan(t, user, profile, { startDate: day(0), durationDays: 1 });
      const meal = plan.days[0]!.meals[0]!;
      await t
        .http()
        .patch(`/api/meal-plans/${plan.id}/meals/${meal.id}/eaten`)
        .set(as(user))
        .send({ eaten: true })
        .expect(200);
      const eaten = (await planOf(plan.id)).days[0]!.meals.find((m) => m.id === meal.id)!;
      const soup = await aMeal(300);
      const rice = await written({
        kind: 'ingredient',
        ingredientId: (await ingredient('white-rice')).id,
        amount: { quantity: 200, unit: 'g' },
        mealType: 'dinner',
      });

      const copied = (await copy({ from: day(0), to: day(-3) }).expect(201))
        .body as DiaryCopyResult;

      expect(copied.copied).toBe(3);
      expect(copied.day.date).toBe(day(-3));
      expect(
        copied.day.entries.map((entry) => [
          entry.kind,
          entry.mealType,
          entry.name,
          entry.nutrition,
        ]),
      ).toEqual([
        ['recipe', eaten.mealType, eaten.recipe!.title, eaten.nutrition],
        ['meal', 'lunch', soup.name, soup.nutrition],
        ['ingredient', 'dinner', rice.name, rice.nutrition],
      ]);
      expect(copied.day.entries[0]).toMatchObject({
        recipeId: eaten.recipe!.id,
        servings: eaten.servings * eaten.quantityScale,
      });
      expect(copied.day.entries[2]!.amount).toEqual(rice.amount);
    });

    it('copies nothing into a day it would fill past the most, and nothing twice under one key', async () => {
      await aMeal(100);
      await aMeal(200);
      await t.prisma.diaryEntry.createMany({
        data: Array.from({ length: MAX_DIARY_ENTRIES_A_DAY - 1 }, () => ({
          profileId: profile.id,
          date: new Date(day(-2)),
          mealType: 'snack',
          kind: 'meal' as const,
          name: 'Nut',
          servings: 1,
          calories: 10,
          protein: 0,
          fat: 1,
          carbs: 0,
        })),
      });

      const full = await copy({ from: day(0), to: day(-2) }).expect(409);
      const first = (await copy({ from: day(0), to: day(-4) }, { key: 'copy-1' }).expect(201))
        .body as DiaryCopyResult;
      const again = (await copy({ from: day(0), to: day(-4) }, { key: 'copy-1' }).expect(201))
        .body as DiaryCopyResult;

      expect(full.body.error).toBe('DIARY_DAY_FULL');
      expect(await t.prisma.diaryEntry.count({ where: { date: new Date(day(-2)) } })).toBe(
        MAX_DIARY_ENTRIES_A_DAY - 1,
      );
      expect([first.copied, again.copied]).toEqual([2, 2]);
      expect(again.day.entries).toHaveLength(2);
    });

    it('takes no day still to come, and no day into itself', async () => {
      const ahead = await copy({ from: day(-1), to: day(1) }).expect(409);
      const itself = await copy({ from: day(0), to: day(0) }).expect(400);

      expect(ahead.body.error).toBe('DIARY_DAY_AHEAD');
      expect(itself.body.error).toBe('VALIDATION_FAILED');
    });

    it('goes into a day at most a year back, and may come from a day older than that', async () => {
      const long = day(-DIARY_DAYS_BACK - 30);
      await t.prisma.diaryEntry.create({
        data: {
          profileId: profile.id,
          date: new Date(long),
          mealType: 'lunch',
          kind: 'meal',
          name: 'Long ago',
          servings: 1,
          calories: 100,
          protein: 5,
          fat: 2,
          carbs: 15,
        },
      });

      const refused = await copy({ from: long, to: day(-DIARY_DAYS_BACK - 1) }).expect(409);
      const copied = (await copy({ from: long, to: day(-DIARY_DAYS_BACK) }).expect(201))
        .body as DiaryCopyResult;

      expect(refused.body.error).toBe('DIARY_DAY_TOO_OLD');
      expect(copied.copied).toBe(1);
    });
  });

  describe('what an entry is of', () => {
    it('may go, and the entry keeps the name and the figures it was written with', async () => {
      const own = await aPrivateRecipe(t, user, { title: 'Our curry' });
      const entry = await written({ kind: 'recipe', recipeId: own.id, servings: 1 });

      await t.http().delete(`/api/recipes/${own.id}`).set(as(user)).expect(204);

      expect((await dayOf(day(0))).entries[0]).toMatchObject({
        name: 'Our curry',
        recipeId: null,
        nutrition: entry.nutrition,
      });
    });

    it('is the profile, whose entries go with it', async () => {
      await aMeal(300);

      await t.http().delete(`/api/profiles/${profile.id}`).set(as(user)).expect(204);

      expect(await t.prisma.diaryEntry.count()).toBe(0);
    });
  });
});
