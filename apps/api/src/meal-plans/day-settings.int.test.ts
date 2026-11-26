// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type {
  ChangedPlan,
  DayHistory,
  DaySettings,
  DaySettingsPreview,
  MealPlan,
  MealPlanDay,
} from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ShoppingListsService } from '../shopping-lists/shopping-lists.service.js';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, as, aUser, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

const DAY_MS = 86_400_000;
/** The day `offset` days from today: the API takes a client's date only near its own. */
const day = (offset: number): string =>
  new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);
/** The day whose settings are changed: tomorrow, in a plan that began the day before yesterday. */
const DATE = day(1);

describe('the settings of a day of a running plan', () => {
  let t: TestApp;
  let user: TestUser;
  let plan: MealPlan;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
  });

  beforeEach(async () => {
    await resetUserData(t.prisma);
    user = await aUser(t);
    plan = await aPlan(t, user, await aProfile(t, user), { startDate: day(-2) });
  });

  afterAll(async () => {
    await t.close();
  });

  const dayOf = (of: MealPlan, date = DATE): MealPlanDay =>
    of.days.find((day) => day.date === date)!;
  /** The settings a day has, as a window opens on them. */
  const settingsOf = (day: MealPlanDay): DaySettings => ({
    dayType: day.overrides?.dayType ?? 'normal',
    skip: day.overrides?.skip ?? false,
    mealCount: day.mealCount,
    calorieTarget: day.overrides?.calorieTarget ?? null,
    cookTimeBudgetMinutes: day.overrides?.cookTimeBudgetMinutes ?? null,
    useUpBy: day.overrides?.useUpBy ?? false,
  });
  const preview = async (of: MealPlan, change: Partial<DaySettings>) =>
    (
      await t
        .http()
        .post(`/api/meal-plans/${of.id}/days/${dayOf(of).id}/settings/preview`)
        .set(as(user))
        .set('X-Client-Date', day(0))
        .send({ ...settingsOf(dayOf(of)), ...change })
        .expect(200)
    ).body as DaySettingsPreview;
  const apply = async (
    of: MealPlan,
    change: Partial<DaySettings> & {
      allowRelaxations?: string[];
      evenWeek?: boolean;
      spreadShort?: boolean;
    },
  ) =>
    (
      await t
        .http()
        .put(`/api/meal-plans/${of.id}/days/${dayOf(of).id}/settings`)
        .set(as(user))
        .set('X-Client-Date', day(0))
        .send({ ...settingsOf(dayOf(of)), ...change, revision: of.revision })
        .expect(200)
    ).body as ChangedPlan;
  /** The recipe of each meal of the catalogue on a day, by its meal. */
  const dishes = (day: MealPlanDay) =>
    Object.fromEntries(
      day.meals.filter((meal) => meal.recipe).map((meal) => [meal.mealType, meal.recipe!.id]),
    );
  const insideItsWindow = (day: MealPlanDay) =>
    Math.abs(day.dayNutrition.calories - day.calorieTarget) <= day.calorieTarget * 0.1;

  it('says that the settings the day has change nothing, and changes nothing for them', async () => {
    const said = await preview(plan, {});
    expect(said).toMatchObject({
      unchanged: true,
      added: [],
      calorieTarget: { now: dayOf(plan).calorieTarget, then: dayOf(plan).calorieTarget },
    });
    expect(said.meals.every((meal) => meal.fate === 'stays')).toBe(true);

    const after = await apply(plan, {});
    expect(after.revision).toBe(plan.revision);
  });

  describe('another kind of day', () => {
    it('keeps the dishes in larger portions on a training day, at the target its kind gives', async () => {
      const day = dayOf(plan);
      // A training day aims fifteen in a hundred over the usual days of its week, to ten kilocalories.
      const target = Math.round((day.calorieTarget * 1.15) / 10) * 10;

      const said = await preview(plan, { dayType: 'training' });
      expect(said.calorieTarget).toEqual({ now: day.calorieTarget, then: target });
      expect(said.meals.map((meal) => [meal.fate, meal.because])).toEqual(
        day.meals.map(() => ['resized', null]),
      );
      expect(said).toMatchObject({ added: [], fits: true, unchanged: false });
      expect(said.targetMacros.then.carbs).toBeGreaterThan(said.targetMacros.now.carbs);

      const after = dayOf(await apply(plan, { dayType: 'training' }));
      expect(after.calorieTarget).toBe(target);
      expect(after.overrides).toEqual({ dayType: 'training' });
      expect(dishes(after)).toEqual(dishes(day));
      // What the preview said the day would hold is what it holds, to the rounding of its meals.
      expect(Math.abs(after.dayNutrition.calories - said.dayCalories!)).toBeLessThanOrEqual(2);
      expect(insideItsWindow(after)).toBe(true);
    });

    it("takes a target of the day's own in place of its kind, and says when it goes under the floor", async () => {
      // A man's floor is 1500.
      const said = await preview(plan, { dayType: 'training', calorieTarget: 1400 });
      expect(said).toMatchObject({ calorieTarget: { then: 1400 }, belowSafetyFloor: true });

      const after = dayOf(await apply(plan, { calorieTarget: 2100 }));
      expect(after).toMatchObject({ calorieTarget: 2100, overrides: { calorieTarget: 2100 } });
      expect(insideItsWindow(after)).toBe(true);
    });

    it("refuses a target of the day's own under the least this body may be given", async () => {
      const refused = await t
        .http()
        .put(`/api/meal-plans/${plan.id}/days/${dayOf(plan).id}/settings`)
        .set(as(user))
        .set('X-Client-Date', day(0))
        .send({ ...settingsOf(dayOf(plan)), calorieTarget: 1150, revision: plan.revision })
        .expect(400);

      expect(refused.body).toMatchObject({ error: 'VALIDATION_FAILED' });
      expect(refused.body.issues[0]).toMatchObject({ path: 'calorieTarget' });
      expect(dayOf(await apply(plan, { calorieTarget: 1200 }))).toMatchObject({
        calorieTarget: 1200,
      });
    });
  });

  describe('the week of the day', () => {
    const planTarget = async () =>
      (await t.prisma.mealPlan.findUniqueOrThrow({ where: { id: plan.id } })).calorieTarget;
    const mean = (days: MealPlanDay[]) =>
      days.reduce((sum, one) => sum + one.calorieTarget, 0) / days.length;
    const slack = (target: number) => Math.max(10, target / 100);
    const even = (of: MealPlan, date: string, revision = of.revision) =>
      t
        .http()
        .post(`/api/meal-plans/${of.id}/weeks/even`)
        .set(as(user))
        .set('X-Client-Date', day(0))
        .send({ date, revision });
    /** The days of the plan from today on, but the one whose settings change. */
    const toCome = [day(0), day(2), day(3), day(4)];

    it('names its days, once it is evened out from its line, as evened in their history', async () => {
      const changed = await apply(plan, { dayType: 'training' });
      const evened = (await even(changed, DATE).expect(200)).body as MealPlan;

      const moved = evened.days.find((one) => one.date === day(0))!;
      const history = (
        await t
          .http()
          .get(`/api/meal-plans/${plan.id}/days/${moved.id}/history`)
          .set(as(user))
          .expect(200)
      ).body as DayHistory;
      expect(history.events[0]!.cause).toBe('week-evened');
    });

    it('says in its answer, as a day changes and as its week is evened, the lists the change made stop matching', async () => {
      const listOf = (of: MealPlan) =>
        t.app.get(ShoppingListsService).generate(user.id, 'en', {
          planId: of.id,
          fromDate: day(0),
          toDate: of.days.at(-1)!.date,
        });
      const first = await listOf(plan);

      const changed = await apply(plan, { dayType: 'training' });
      expect(changed.effects?.lists.map((list) => list.id)).toEqual([first.id]);

      // A list made since is matched by the plan until the week is evened: the other days move.
      const second = await listOf(changed);
      const evened = (await even(changed, DATE).expect(200)).body as ChangedPlan;
      expect(evened.effects?.lists.map((list) => list.id)).toEqual([second.id]);
      // A meal more, which a recipe is drawn for, says the same.
      const third = await listOf(evened);
      const more = await apply(evened, { mealCount: dayOf(evened).mealCount + 1 });
      expect(dayOf(more).meals).toHaveLength(dayOf(evened).meals.length + 1);
      expect(more.effects?.lists.map((list) => list.id)).toEqual([third.id]);
      // A change that changes nothing says nothing.
      expect((await apply(more, {})).effects).toBeNull();
    });

    it("says how a kind changed alone moves the week's average and its pace, and changes that day alone, at the level of its week", async () => {
      const target = await planTarget();
      const usual = dayOf(plan).calorieTarget;
      const training = Math.round((usual * 1.15) / 10) * 10;

      const said = await preview(plan, { dayType: 'training' });
      expect(said.calorieTarget.then).toBe(training);
      expect(said.week).toMatchObject({ target, unevenAlone: true, otherDays: toCome.length });
      expect(said.week!.average.alone - said.week!.average.now).toBeCloseTo(
        (training - usual) / 7,
        0,
      );
      expect(said.week!.pace.alone).toBeLessThan(said.week!.pace.now);
      expect(Math.abs(said.week!.average.evened - target)).toBeLessThanOrEqual(slack(target));

      const after = await apply(plan, { dayType: 'training' });
      expect(dayOf(after).calorieTarget).toBe(training);
      const others = (of: MealPlan) =>
        of.days.filter((one) => one.date !== DATE).map((one) => one.calorieTarget);
      expect(others(after)).toEqual(others(plan));
      expect(after.weeks).toEqual([expect.objectContaining({ target, uneven: true })]);
    });

    it('evens the week out with the change: the days from today on give back what the day takes, in other portions of the same dishes, and the days before today stay', async () => {
      const target = await planTarget();
      const said = await preview(plan, { dayType: 'training' });

      const after = await apply(plan, { dayType: 'training', evenWeek: true });

      expect(dayOf(after).calorieTarget).toBe(said.week!.evenedTarget);
      for (const date of [day(-2), day(-1)])
        expect(dayOf(after, date).calorieTarget).toBe(dayOf(plan, date).calorieTarget);
      for (const date of toCome) {
        expect(dayOf(after, date).calorieTarget).toBeLessThan(dayOf(plan, date).calorieTarget);
        expect(dishes(dayOf(after, date))).toEqual(dishes(dayOf(plan, date)));
        expect(insideItsWindow(dayOf(after, date))).toBe(true);
      }
      expect(Math.abs(mean(after.days) - target)).toBeLessThanOrEqual(slack(target));
      expect(after.weeks).toEqual([expect.objectContaining({ uneven: false })]);
    });

    it('is evened out later from any of its days, on the plan as it was read; a week that is even is left as it is', async () => {
      const alone = await apply(plan, { dayType: 'training' });

      expect((await even(alone, DATE, plan.revision).expect(409)).body.error).toBe('PLAN_CHANGED');

      const evened = (await even(alone, day(-1)).expect(200)).body as MealPlan;
      expect(evened.weeks).toEqual([expect.objectContaining({ uneven: false })]);
      expect(dayOf(evened).calorieTarget).toBeLessThan(dayOf(alone).calorieTarget);
      expect(dayOf(evened).overrides).toEqual({ dayType: 'training' });
      for (const date of [day(-2), day(-1)])
        expect(dayOf(evened, date).calorieTarget).toBe(dayOf(plan, date).calorieTarget);

      const again = (await even(evened, DATE).expect(200)).body as MealPlan;
      expect(again.revision).toBe(evened.revision);
    });

    it('says when the shopping list of days that evening the week changes goes out of date, and marks the days a list covers', async () => {
      await t
        .http()
        .post('/api/shopping-lists/generate')
        .set(as(user))
        .send({ planId: plan.id, fromDate: day(2), toDate: day(4) })
        .expect(201);

      const said = await preview(plan, { dayType: 'training' });
      // The list covers other days of the week, not this one.
      expect(said.listOutOfDate).toBe(false);
      expect(said.week).toMatchObject({ unevenAlone: true, listOutOfDate: true });

      const read = (
        await t
          .http()
          .get(`/api/meal-plans/${plan.id}`)
          .set(as(user))
          .set('X-Client-Date', day(0))
          .expect(200)
      ).body as MealPlan;
      expect(read.days.map((one) => [one.date, one.listed])).toEqual(
        read.days.map((one) => [one.date, one.date >= day(2) && one.date <= day(4)]),
      );
      expect(read.weeks).toEqual([expect.objectContaining({ listOutOfDate: true })]);
    });

    it('keeps the protein of the usual days of the week on a training day, which gains carbohydrate', async () => {
      const after = await apply(plan, { dayType: 'training' });

      expect(dayOf(after).targetMacros.protein).toBe(dayOf(after, day(2)).targetMacros.protein);
      expect(dayOf(after).targetMacros.carbs).toBeGreaterThan(
        dayOf(after, day(2)).targetMacros.carbs,
      );
    });
  });

  describe('another number of meals', () => {
    it('keeps the dishes of the meals that stay, in other portions, and draws a recipe for the meal the day gains', async () => {
      const day = dayOf(plan);
      expect(day.mealCount).toBe(3);

      const said = await preview(plan, { mealCount: 4 });
      expect(said.added).toEqual(['snack']);
      expect(said.meals.map((meal) => meal.fate)).toEqual(['resized', 'resized', 'resized']);
      expect(said).toMatchObject({ dayCalories: null, fits: null });

      const after = dayOf(await apply(plan, { mealCount: 4 }));
      expect(after.meals.map((meal) => meal.mealType)).toEqual([
        'breakfast',
        'lunch',
        'snack',
        'dinner',
      ]);
      expect(dishes(after)).toMatchObject(dishes(day));
      expect(after).toMatchObject({ mealCount: 4, overrides: { mealCount: 4 } });
      expect(insideItsWindow(after)).toBe(true);
      // A dish that stays keeps the portion the plan gave it, which it grows from: the change moves its scale.
      for (const meal of day.meals) {
        const kept = after.meals.find((one) => one.id === meal.id)!;
        expect(kept.servings).toBe(meal.servings);
        expect(kept.quantityScale).toBeLessThanOrEqual(2);
      }
    });

    it("draws no recipe for the time of day the user's own meal took when the day gains meals", async () => {
      const lunch = dayOf(plan).meals.find((meal) => meal.mealType === 'lunch')!;
      const withOwn = (
        await t
          .http()
          .post(`/api/meal-plans/${plan.id}/days/${DATE}/custom-meal`)
          .set(as(user))
          .set('X-Client-Date', day(0))
          .send({
            name: 'Soup of my own',
            mealType: 'lunch',
            nutrition: { calories: 500, protein: 25, fat: 15, carbs: 60 },
            replaces: lunch.id,
          })
          .expect(201)
      ).body.plan as MealPlan;

      const said = await preview(withOwn, { mealCount: 4 });
      expect(said.added).toEqual(['snack']);

      const after = dayOf(await apply(withOwn, { mealCount: 4 }));
      expect(
        after.meals.filter((meal) => meal.source === 'CATALOGUE').map((meal) => meal.mealType),
      ).toEqual(['breakfast', 'snack', 'dinner']);
      expect(
        after.meals.filter((meal) => meal.source === 'USER_CUSTOM').map((meal) => meal.mealType),
      ).toEqual(['lunch']);
    });

    it('takes away the meal the day loses, and the others take its share', async () => {
      const day = dayOf(plan);

      const said = await preview(plan, { mealCount: 2 });
      expect(said.meals.map((meal) => [meal.mealType, meal.fate, meal.because])).toEqual([
        ['breakfast', 'resized', null],
        ['lunch', 'removed', 'fewer_meals'],
        ['dinner', 'resized', null],
      ]);
      expect(said.added).toEqual([]);
      expect(said.dayCalories).not.toBeNull();

      const after = dayOf(await apply(plan, { mealCount: 2 }));
      const { lunch, ...staying } = dishes(day);
      expect(lunch).toBeDefined();
      expect(dishes(after)).toEqual(staying);
      // Two dishes may not reach the whole target at the largest serving: the preview says how near they come.
      expect(Math.abs(after.dayNutrition.calories - said.dayCalories!)).toBeLessThanOrEqual(2);
      expect(insideItsWindow(after)).toBe(said.fits);
    });
  });

  describe('the portions of the dishes that stay', () => {
    /** The plan once the meal of `mealType` on the day is eaten. */
    const eat = async (of: MealPlan, mealType: string): Promise<MealPlan> => {
      const meal = dayOf(of).meals.find((one) => one.mealType === mealType)!;
      await t
        .http()
        .patch(`/api/meal-plans/${of.id}/meals/${meal.id}/eaten`)
        .set(as(user))
        .set('X-Client-Date', DATE)
        .send({ eaten: true })
        .expect(200);
      return (await t.http().get(`/api/meal-plans/${of.id}`).set(as(user)).expect(200))
        .body as MealPlan;
    };
    /** The days of the plan after the day changed, and what each holds. */
    const after = (of: MealPlan) => of.days.filter((one) => one.date > DATE);
    const held = (of: MealPlan) =>
      after(of).reduce((sum, one) => sum + one.dayNutrition.calories, 0);

    it("says each one's servings and kcal now and after the change, as the change makes them", async () => {
      const day = dayOf(plan);

      const said = await preview(plan, { dayType: 'training' });

      for (const fate of said.meals) {
        const meal = day.meals.find((one) => one.id === fate.mealId)!;
        // Said to the hundredth of a serving.
        expect(
          Math.abs(fate.portion!.servings.now - meal.servings * meal.quantityScale),
        ).toBeLessThanOrEqual(0.0051);
        expect(Math.abs(fate.portion!.calories.now - meal.nutrition.calories)).toBeLessThanOrEqual(
          1,
        );
        expect(fate.portion!.calories.then).toBeGreaterThan(fate.portion!.calories.now);
      }
      const changed = dayOf(await apply(plan, { dayType: 'training' }));
      for (const fate of said.meals) {
        const meal = changed.meals.find((one) => one.id === fate.mealId)!;
        expect(
          Math.abs(meal.servings * meal.quantityScale - fate.portion!.servings.then),
        ).toBeLessThanOrEqual(0.0051);
        expect(Math.abs(meal.nutrition.calories - fate.portion!.calories.then)).toBeLessThanOrEqual(
          1,
        );
      }
    });

    it('grows the dish left at most to twice its portion, and spreads what the day falls short of over the next days', async () => {
      // A dinner the plan gave one serving: twice that is under the most servings a dish takes, so the bound is its own.
      const first = dayOf(plan).meals.find((meal) => meal.mealType === 'dinner')!;
      await t.prisma.plannedMeal.update({
        where: { id: first.id },
        data: { servings: 1, quantityScale: 1 },
      });
      const eaten = await eat(await eat(plan, 'breakfast'), 'lunch');
      const dinner = dayOf(eaten).meals.find((meal) => meal.mealType === 'dinner')!;
      expect(dinner.servings).toBe(1);
      // A target of its own far past what the dinner can take, after breakfast and lunch.
      const change = { calorieTarget: dayOf(eaten).calorieTarget + 1500 };

      const said = await preview(eaten, change);

      const portion = said.meals.find((meal) => meal.mealId === dinner.id)!.portion!;
      expect(portion.servings.then).toBeCloseTo(2, 2);
      expect(said.fits).toBe(false);
      expect(said.short!.kcal).toBe(change.calorieTarget - said.dayCalories!);
      // The days after it take what they can inside their windows; the rest is said.
      expect(said.short!.spread.days).toBe(after(eaten).length);
      expect(said.short!.spread.takes).toBeGreaterThan(0);
      expect(said.short!.spread.takes + said.short!.spread.left).toBe(said.short!.kcal);
      expect(said.short!.spread.listOutOfDate).toBe(false);
      expect(said.short!.spread.none).toBeNull();

      const spread = await apply(eaten, { ...change, spreadShort: true });

      // What the preview said the days after it take is what they took, to the rounding of their meals.
      expect(Math.abs(held(spread) - held(eaten) - said.short!.spread.takes)).toBeLessThanOrEqual(
        3 * after(eaten).length,
      );
      for (const day of after(spread)) expect(insideItsWindow(day)).toBe(true);
      const grown = dayOf(spread).meals.find((meal) => meal.id === dinner.id)!;
      expect(grown.servings).toBe(dinner.servings);
      expect(
        Math.abs(grown.servings * grown.quantityScale - portion.servings.then),
      ).toBeLessThanOrEqual(0.0051);
    });

    it('says that a dish already at the most it may grow to stays as it is', async () => {
      const first = dayOf(plan).meals.find((meal) => meal.mealType === 'dinner')!;
      await t.prisma.plannedMeal.update({
        where: { id: first.id },
        data: { servings: 1, quantityScale: 1 },
      });
      const eaten = await eat(await eat(plan, 'breakfast'), 'lunch');
      // The dinner grows to twice its portion, and the day is still short.
      const grown = await apply(eaten, { calorieTarget: dayOf(eaten).calorieTarget + 1500 });
      expect(dayOf(grown).meals.find((meal) => meal.id === first.id)!.quantityScale).toBeCloseTo(
        2,
        5,
      );

      const said = await preview(grown, { calorieTarget: dayOf(grown).calorieTarget + 100 });

      expect(said.meals.find((meal) => meal.mealId === first.id)).toMatchObject({
        fate: 'stays',
        because: null,
        portion: null,
      });
      expect(said.short!.kcal).toBeGreaterThan(0);
    });

    it('leaves the meal the day loses out of what it falls short of, as the change does', async () => {
      const change = { mealCount: 2, calorieTarget: dayOf(plan).calorieTarget + 1500 };

      const said = await preview(plan, change);

      expect(said.meals.filter((meal) => meal.fate === 'removed')).toHaveLength(1);
      expect(said.short!.kcal).toBe(change.calorieTarget - said.dayCalories!);
      expect(said.short!.spread.takes).toBeGreaterThan(0);

      const spread = await apply(plan, { ...change, spreadShort: true });

      expect(dayOf(spread).meals).toHaveLength(2);
      // What the preview said the days after it take is what they took.
      expect(Math.abs(held(spread) - held(plan) - said.short!.spread.takes)).toBeLessThanOrEqual(
        3 * after(plan).length,
      );
    });

    it('says when a shopping list covers a day that takes what the day falls short of', async () => {
      await t
        .http()
        .post('/api/shopping-lists/generate')
        .set(as(user))
        .send({ planId: plan.id, fromDate: day(2), toDate: day(2) })
        .expect(201);
      const eaten = await eat(await eat(plan, 'breakfast'), 'lunch');

      const said = await preview(eaten, { calorieTarget: dayOf(eaten).calorieTarget + 1500 });

      // The list covers the next day, not this one.
      expect(said.listOutOfDate).toBe(false);
      expect(said.short!.spread).toMatchObject({ listOutOfDate: true });
    });

    it('says that the days after it take no more where they are at the top of their windows', async () => {
      const eaten = await eat(await eat(plan, 'breakfast'), 'lunch');
      // The most a day's own target may be: the days after it take all they can of what it falls short of.
      const spread = await apply(eaten, { calorieTarget: 6000, spreadShort: true });

      const said = await preview(spread, { calorieTarget: 5900 });

      expect(said.short!.spread).toMatchObject({ days: 0, takes: 0, none: 'full' });
      expect(said.short!.spread.left).toBe(said.short!.kcal);
    });

    it('says that the days after it are skipped where every one of them is', async () => {
      let skipped = await eat(await eat(plan, 'breakfast'), 'lunch');
      for (const later of skipped.days.filter((one) => one.date > DATE)) {
        skipped = (
          await t
            .http()
            .put(`/api/meal-plans/${skipped.id}/days/${later.id}/settings`)
            .set(as(user))
            .set('X-Client-Date', day(0))
            .send({ ...settingsOf(later), skip: true, revision: skipped.revision })
            .expect(200)
        ).body as MealPlan;
      }

      const said = await preview(skipped, { calorieTarget: dayOf(skipped).calorieTarget + 1500 });

      expect(said.short!.spread).toMatchObject({ days: 0, takes: 0, none: 'skipped' });
    });

    it('leaves the days after it as they are where the spread is not asked for', async () => {
      const eaten = await eat(await eat(plan, 'breakfast'), 'lunch');
      const change = { calorieTarget: dayOf(eaten).calorieTarget + 1500 };

      const changed = await apply(eaten, change);

      expect(held(changed)).toBe(held(eaten));
      expect(dayOf(changed).calorieTarget).toBe(change.calorieTarget);
    });

    it('has no day to spread to on the last day of the plan: all of the shortfall is left', async () => {
      // A plan whose last day is the day changed.
      const ending = await aPlan(t, user, await aProfile(t, user), {
        startDate: day(-2),
        durationDays: 4,
      });
      const eaten = await eat(await eat(ending, 'breakfast'), 'lunch');

      const said = await preview(eaten, { calorieTarget: dayOf(eaten).calorieTarget + 1500 });

      expect(said.short!.spread).toEqual({
        days: 0,
        takes: 0,
        left: said.short!.kcal,
        listOutOfDate: false,
        none: 'last_day',
      });
    });
  });

  describe('a skipped day', () => {
    it('keeps what was eaten of it and nothing else, and is no shortfall', async () => {
      const breakfast = dayOf(plan).meals.find((meal) => meal.mealType === 'breakfast')!;
      await t
        .http()
        .patch(`/api/meal-plans/${plan.id}/meals/${breakfast.id}/eaten`)
        .set(as(user))
        .set('X-Client-Date', DATE)
        .send({ eaten: true })
        .expect(200);
      const eaten = (await t.http().get(`/api/meal-plans/${plan.id}`).set(as(user)).expect(200))
        .body as MealPlan;

      const said = await preview(eaten, { skip: true });
      expect(said.meals.map((meal) => [meal.mealType, meal.fate, meal.because])).toEqual([
        ['breakfast', 'stays', 'eaten'],
        ['lunch', 'removed', 'skipped'],
        ['dinner', 'removed', 'skipped'],
      ]);
      expect(said.fits).toBeNull();

      const after = await apply(eaten, { skip: true });
      expect(dayOf(after)).toMatchObject({ skipped: true, calorieDelta: 0, offTarget: null });
      expect(dayOf(after).meals.map((meal) => meal.id)).toEqual([breakfast.id]);
      // The day is left out of what a day of the plan holds on average.
      const others = after.days.filter((day) => day.date !== DATE);
      const average =
        others.reduce((sum, day) => sum + day.dayNutrition.calories, 0) / others.length;
      expect(Math.abs(after.averageDailyNutrition.calories - average)).toBeLessThanOrEqual(1);
    });

    it('gets the meals of its number again once it is no longer skipped', async () => {
      const skipped = await aPlan(t, user, await aProfile(t, user), {
        startDate: day(-2),
        dayOverrides: [{ date: DATE, skip: true }],
      });
      expect(dayOf(skipped).meals).toEqual([]);

      const said = await preview(skipped, { skip: false });
      expect(said.added).toEqual(['breakfast', 'lunch', 'dinner']);

      const after = dayOf(await apply(skipped, { skip: false }));
      expect(after.meals.map((meal) => meal.mealType)).toEqual(['breakfast', 'lunch', 'dinner']);
      expect(after).toMatchObject({ skipped: false, overrides: null });
      expect(insideItsWindow(after)).toBe(true);
    });
  });

  describe('a limit that rules a dish out', () => {
    it('draws another recipe for each meal over a new limit on cooking time, and leaves the others as they are', async () => {
      const day = dayOf(plan);
      const minutes = day.meals.map((meal) => meal.recipe!.prepMinutes + meal.recipe!.cookMinutes);
      // Under the longest of the day's dishes: that one, at least, is over it.
      const limit = Math.max(...minutes) - 1;
      const over = day.meals.filter((_, index) => minutes[index]! > limit).map((meal) => meal.id);

      const said = await preview(plan, { cookTimeBudgetMinutes: limit });
      for (const meal of said.meals) {
        expect([meal.fate, meal.because], meal.mealType).toEqual(
          over.includes(meal.mealId) ? ['redrawn', 'over_cook_time'] : ['stays', null],
        );
      }

      // The catalogue may have no other recipe inside the limit: it may then give way, and says so.
      const after = dayOf(
        await apply(plan, { cookTimeBudgetMinutes: limit, allowRelaxations: ['cook_time'] }),
      );
      const ids = new Set(after.meals.map((meal) => meal.id));
      expect(over.every((id) => !ids.has(id))).toBe(true);
      expect(
        day.meals.filter((meal) => !over.includes(meal.id)).every((meal) => ids.has(meal.id)),
      ).toBe(true);
      expect(after.overrides).toEqual({ cookTimeBudgetMinutes: limit });
    });

    it('draws again every meal not yet eaten to use up what the pantry has, and keeps what was eaten', async () => {
      const lunch = dayOf(plan).meals.find((meal) => meal.mealType === 'lunch')!;
      await t
        .http()
        .patch(`/api/meal-plans/${plan.id}/meals/${lunch.id}/eaten`)
        .set(as(user))
        .set('X-Client-Date', DATE)
        .send({ eaten: true })
        .expect(200);
      const eaten = (await t.http().get(`/api/meal-plans/${plan.id}`).set(as(user)).expect(200))
        .body as MealPlan;

      const said = await preview(eaten, { useUpBy: true });
      expect(said.meals.map((meal) => [meal.mealType, meal.fate, meal.because])).toEqual([
        ['breakfast', 'redrawn', 'use_up'],
        ['lunch', 'stays', 'eaten'],
        ['dinner', 'redrawn', 'use_up'],
      ]);
    });
  });

  it('says that a shopping list of the plan goes out of date, where one covers the day', async () => {
    expect((await preview(plan, { dayType: 'rest' })).listOutOfDate).toBe(false);
    await t
      .http()
      .post('/api/shopping-lists/generate')
      .set(as(user))
      .send({ planId: plan.id })
      .expect(201);
    const withList = (await t.http().get(`/api/meal-plans/${plan.id}`).set(as(user)).expect(200))
      .body as MealPlan;

    expect((await preview(withList, { dayType: 'rest' })).listOutOfDate).toBe(true);
    // A change that leaves the meals as they are does nothing to a list.
    expect((await preview(withList, { cookTimeBudgetMinutes: 600 })).listOutOfDate).toBe(false);
  });

  it('refuses a day before today, and a change asked of a plan that changed since', async () => {
    const yesterday = dayOf(plan, day(-1));
    for (const asked of [
      () =>
        t
          .http()
          .post(`/api/meal-plans/${plan.id}/days/${yesterday.id}/settings/preview`)
          .send(settingsOf(yesterday)),
      () =>
        t
          .http()
          .put(`/api/meal-plans/${plan.id}/days/${yesterday.id}/settings`)
          .send({ ...settingsOf(yesterday), dayType: 'rest', revision: plan.revision }),
    ]) {
      const past = await asked().set(as(user)).set('X-Client-Date', day(0)).expect(409);
      expect(past.body.error).toBe('DAY_IN_THE_PAST');
    }

    const stale = await t
      .http()
      .put(`/api/meal-plans/${plan.id}/days/${dayOf(plan).id}/settings`)
      .set(as(user))
      .set('X-Client-Date', day(0))
      .send({ ...settingsOf(dayOf(plan)), dayType: 'rest', revision: plan.revision + 1 })
      .expect(409);
    expect(stale.body.error).toBe('PLAN_CHANGED');
    const after = (await t.http().get(`/api/meal-plans/${plan.id}`).set(as(user)).expect(200))
      .body as MealPlan;
    expect([dayOf(after), dayOf(after, day(-1))]).toMatchObject([
      { calorieTarget: dayOf(plan).calorieTarget, overrides: null },
      { calorieTarget: yesterday.calorieTarget, overrides: null },
    ]);
  });
});
