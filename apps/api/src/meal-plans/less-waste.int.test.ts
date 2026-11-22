// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import {
  GeneratePlanRequest,
  RegenerateDayRequest,
  RegenerateRequest,
  type MealPlan,
  type Profile,
} from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aProfile, as, aUser, type TestUser } from '../testing/factories.js';
import { plansTodayIs } from '../testing/plans-today.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { MealPlansService } from './meal-plans.service.js';
import { PlanGenerationService } from './plan-generation.service.js';
import { menuNeeds } from './plan-menu.js';
import { packsOfPlan } from './plan-packs-store.js';

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

  it('wastes nothing only where it is asked to, wasting less with it, kept as that is', async () => {
    const strict = await generate({ noWaste: true });
    expect(strict.options).toMatchObject({ lessWaste: true, noWaste: true });
    expect((await generate({ lessWaste: true })).options).toMatchObject({ noWaste: false });

    // Made again, it stays; a part of it is made as the plan is; told it wastes less no more, it wastes nothing no more.
    expect((await again(strict)).options).toMatchObject({ lessWaste: true, noWaste: true });
    const part = await again(strict, { from: '2026-01-06', to: '2026-01-06', noWaste: false });
    expect(part.options).toMatchObject({ lessWaste: true, noWaste: true });
    const plain = await again(strict, { lessWaste: false });
    expect(plain.options).toMatchObject({ lessWaste: false, noWaste: false });
    // And a plan made again to waste nothing wastes less as well.
    expect((await again(plain, { noWaste: true })).options).toMatchObject({
      lessWaste: true,
      noWaste: true,
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

/** A freezer kept before packages, as it reads now: each entry package 0, of no day. */
const asPackage0 = (freezer: {
  from: string;
  stock: { ingredientId: string; amount: number }[];
}) => ({
  ...freezer,
  stock: freezer.stock.map((one) => ({ ...one, parcel: 0, bestBefore: null })),
});

describe('the packs of a plan that wastes less, closed after the planner', () => {
  let t: TestApp;
  let user: TestUser;
  let adam: Profile;
  let ewa: Profile;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
  });

  beforeEach(async () => {
    await resetUserData(t.prisma);
    user = await aUser(t);
    adam = await aProfile(t, user, { name: 'Adam', mealCount: 3 });
    ewa = await aProfile(t, user, { name: 'Ewa', mealCount: 3 });
  });

  afterAll(async () => {
    await t.close();
  });

  const together = (lessWaste: boolean): Promise<MealPlan> =>
    t.app.get(PlanGenerationService).generate(
      user.id,
      'en',
      GeneratePlanRequest.parse({
        profileId: adam.id,
        withProfileId: ewa.id,
        startDate: '2026-01-05',
        durationDays: 3,
        lessWaste,
      }),
    );
  const read = (planId: string): Promise<MealPlan> =>
    t.app.get(MealPlansService).get(user.id, 'en', planId);

  /** Give a day of a plan exactly these recipes, one serving each: breakfast, lunch, dinner. */
  async function menu(plan: MealPlan, day: number, slugs: [string, string, string]): Promise<void> {
    for (const [index, mealType] of (['breakfast', 'lunch', 'dinner'] as const).entries()) {
      const recipe = await t.prisma.recipe.findUniqueOrThrow({ where: { slug: slugs[index]! } });
      const meal = plan.days[day]!.meals.find((planned) => planned.mealType === mealType)!;
      await t.prisma.plannedMeal.update({
        where: { id: meal.id },
        data: {
          recipeId: recipe.id,
          servings: 1,
          quantityScale: 1,
          source: 'CATALOGUE',
          eatenAt: null,
          leftoverFromDate: null,
          leftoverFromMealType: null,
          toppingKey: null,
          toppingAmount: null,
        },
      });
    }
  }

  it('gives a meal both eat one dish in both plans, whatever closing the packs swaps', async () => {
    const adams = await together(true);
    const ewas = await read(adams.joint!.planId);

    const shared = adams.days.flatMap((day) => day.meals.filter((meal) => meal.shared !== null));
    expect(shared.length).toBeGreaterThan(0);
    for (const meal of shared) {
      const other = ewas.days
        .flatMap((day) => day.meals)
        .find((one) => one.id === meal.shared!.with.mealId)!;
      expect(other.recipe!.id).toBe(meal.recipe!.id);
    }
  });

  it('leaves in the freezer a portion the plan cannot eat whole within two days', async () => {
    const generation = t.app.get(PlanGenerationService);
    const today = generation.today;
    generation.today = () => '2026-01-05';
    try {
      const chicken = await t.prisma.ingredient.findFirstOrThrow({
        where: { slug: 'chicken-breast' },
      });
      await t.prisma.inventoryItem.create({
        data: {
          profileId: adam.id,
          ingredientId: chicken.id,
          quantity: 5000,
          unit: 'g',
          bestBefore: new Date('2026-02-04'),
          frozen: true,
        },
      });

      const plan = await generation.generate(
        user.id,
        'en',
        GeneratePlanRequest.parse({ profileId: adam.id, startDate: '2026-01-05', durationDays: 3 }),
      );

      const { report } = await t.prisma.mealPlan.findUniqueOrThrow({ where: { id: plan.id } });
      expect((report as { freezer: unknown }).freezer).toBeNull();
      expect(plan.packs.fromFreezer).toEqual([]);
    } finally {
      generation.today = today;
    }
  });

  it('takes out a package dated within a week of its end for the days that eat most of it, and says what is left', async () => {
    const generation = t.app.get(PlanGenerationService);
    const today = generation.today;
    generation.today = () => '2026-01-05';
    try {
      const chicken = await t.prisma.ingredient.findFirstOrThrow({
        where: { slug: 'chicken-breast' },
      });
      // 5 kg of chicken that goes off three days after the plan: no day and the next eat it, but no plan after it would.
      await t.prisma.inventoryItem.create({
        data: {
          profileId: adam.id,
          ingredientId: chicken.id,
          quantity: 5000,
          unit: 'g',
          bestBefore: new Date('2026-01-10'),
          frozen: true,
        },
      });

      const plan = await generation.generate(
        user.id,
        'en',
        GeneratePlanRequest.parse({ profileId: adam.id, startDate: '2026-01-05', durationDays: 3 }),
      );

      const { report } = await t.prisma.mealPlan.findUniqueOrThrow({ where: { id: plan.id } });
      expect((report as { freezer: { stock: unknown[] } | null }).freezer?.stock).toMatchObject([
        { ingredientId: chicken.id, amount: 5000, bestBefore: '2026-01-10' },
      ]);
      const [held] = plan.packs.fromFreezer;
      expect(held).toMatchObject({ ingredientId: chicken.id, amount: 5000 });
      expect(held!.eaten).toBeGreaterThan(0);
      expect(held!.eaten).toBeLessThan(5000);
    } finally {
      generation.today = today;
    }
  });

  it('keeps the packages it takes out of the freezer by their numbers, a larger one it would not eat whole left there', async () => {
    const generation = t.app.get(PlanGenerationService);
    const today = generation.today;
    generation.today = () => '2026-01-05';
    try {
      const chicken = await t.prisma.ingredient.findFirstOrThrow({
        where: { slug: 'chicken-breast' },
      });
      // A package of 5 kg goes off first but would be left over; one of 40 g is eaten whole by any meal of chicken.
      await t.prisma.inventoryItem.createMany({
        data: [
          { parcel: 7, quantity: 5000, bestBefore: new Date('2026-01-20') },
          { parcel: 9, quantity: 40, bestBefore: new Date('2026-02-01') },
        ].map((one) => ({
          ...one,
          profileId: adam.id,
          ingredientId: chicken.id,
          unit: 'g' as const,
          frozen: true,
        })),
      });

      const plan = await generation.generate(
        user.id,
        'en',
        GeneratePlanRequest.parse({ profileId: adam.id, startDate: '2026-01-05', durationDays: 3 }),
      );

      const { report } = await t.prisma.mealPlan.findUniqueOrThrow({ where: { id: plan.id } });
      expect((report as { freezer: unknown }).freezer).toEqual({
        from: '2026-01-05',
        stock: [{ ingredientId: chicken.id, amount: 40, parcel: 9, bestBefore: '2026-02-01' }],
      });
      expect(plan.packs.fromFreezer).toMatchObject([
        { ingredientId: chicken.id, amount: 40, eaten: 40 },
      ]);
    } finally {
      generation.today = today;
    }
  });

  it('takes out the packages of both freezers of a kitchen, each plan keeping those of its own profile', async () => {
    const generation = t.app.get(PlanGenerationService);
    const today = generation.today;
    generation.today = () => '2026-01-05';
    try {
      const chicken = await t.prisma.ingredient.findFirstOrThrow({
        where: { slug: 'chicken-breast' },
      });
      // 20 g each, eaten whole by any meal of chicken: Ewa's goes off first.
      await t.prisma.inventoryItem.createMany({
        data: [
          { profileId: adam.id, parcel: 3, bestBefore: new Date('2026-02-01') },
          { profileId: ewa.id, parcel: 5, bestBefore: new Date('2026-01-25') },
        ].map((one) => ({
          ...one,
          ingredientId: chicken.id,
          quantity: 20,
          unit: 'g' as const,
          frozen: true,
        })),
      });

      const adams = await together(false);

      const keptOf = async (planId: string) =>
        (
          (await t.prisma.mealPlan.findUniqueOrThrow({ where: { id: planId } })).report as {
            freezer: { stock: { parcel: number }[] } | null;
          }
        ).freezer?.stock.map((one) => one.parcel);
      expect(await keptOf(adams.id)).toEqual([3]);
      expect(await keptOf(adams.joint!.planId)).toEqual([5]);
      // The kitchen reads both, the one going off first first.
      expect(adams.packs.fromFreezer.map((one) => one.amount)).toEqual([20, 20]);
    } finally {
      generation.today = today;
    }
  });

  it('takes first the portion the freezer held as the plan keeps it, until the plan is made again as a whole', async () => {
    const generation = t.app.get(PlanGenerationService);
    const today = generation.today;
    generation.today = () => '2026-01-05';
    try {
      const chicken = await t.prisma.ingredient.findFirstOrThrow({
        where: { slug: 'chicken-breast' },
      });
      const plan = await generation.generate(
        user.id,
        'en',
        GeneratePlanRequest.parse({ profileId: adam.id, startDate: '2026-01-05', durationDays: 3 }),
      );
      // As a plan made with 286 g of chicken in the freezer, which it eats whole, keeps it.
      // As a report kept before packages has it: one entry a food, read as package 0.
      const freezer = { from: '2026-01-05', stock: [{ ingredientId: chicken.id, amount: 286 }] };
      const made = await t.prisma.mealPlan.findUniqueOrThrow({ where: { id: plan.id } });
      await t.prisma.mealPlan.update({
        where: { id: plan.id },
        data: { report: { ...(made.report as object), freezer } },
      });
      const chickenOnTuesday = async (one: MealPlan): Promise<string> => {
        for (const day of [0, 1, 2])
          await menu(one, day, [
            'scrambled-eggs-on-toast',
            day === 1 ? 'chicken-rice-broccoli' : 'tofu-rice-bowl',
            'chickpea-tomato-stew',
          ]);
        return one.days[1]!.meals.find((meal) => meal.mealType === 'lunch')!.id;
      };
      const lunch = await chickenOnTuesday(plan);
      const kept = async () =>
        (await t.prisma.mealPlan.findUniqueOrThrow({ where: { id: plan.id } })).report as {
          freezer: unknown;
        };

      // The whole portion comes out for Tuesday's lunch; changed since, the menu eats 150 g of it, and says so.
      const read1 = await read(plan.id);
      expect(read1.packs.fromFreezer).toEqual([
        {
          ingredientId: chicken.id,
          name: 'Chicken breast',
          unit: 'g',
          date: '2026-01-06',
          mealId: lunch,
          amount: 286,
          eaten: 150,
        },
      ]);
      // Nothing of it is bought.
      expect(read1.packs.open.find((pack) => pack.name === 'Chicken breast')).toBeUndefined();

      // A day of the plan made again: the plan says what it was made with.
      await generation.regenerate(
        user.id,
        'en',
        plan.id,
        RegenerateRequest.parse({ from: '2026-01-07', to: '2026-01-07' }),
      );
      expect((await kept()).freezer).toEqual(asPackage0(freezer));

      // Made again as a whole, it finds the freezer empty.
      await generation.regenerate(user.id, 'en', plan.id, RegenerateRequest.parse({}));
      expect((await kept()).freezer).toBeNull();
      await chickenOnTuesday(await read(plan.id));
      expect((await read(plan.id)).packs.fromFreezer).toEqual([]);
    } finally {
      generation.today = today;
    }
  });

  it('gives the pantry what is left of a rest it freezes, once, as frozen and dated a month on', async () => {
    const plan = await t.app.get(PlanGenerationService).generate(
      user.id,
      'en',
      GeneratePlanRequest.parse({
        profileId: adam.id,
        startDate: '2026-01-05',
        durationDays: 3,
        noWaste: true,
      }),
    );
    // Monday's lunch alone takes chicken: 150 g of a pack of 500 g, which keeps two days.
    for (const day of [0, 1, 2])
      await menu(plan, day, [
        'scrambled-eggs-on-toast',
        day === 0 ? 'chicken-rice-broccoli' : 'tofu-rice-bowl',
        'chickpea-tomato-stew',
      ]);
    const chicken = await t.prisma.ingredient.findFirstOrThrow({
      where: { slug: 'chicken-breast' },
    });
    const lunch = plan.days[0]!.meals.find((meal) => meal.mealType === 'lunch')!;
    expect((await read(plan.id)).packs.frozen).toEqual([
      {
        ingredientId: chicken.id,
        name: 'Chicken breast',
        unit: 'g',
        date: '2026-01-05',
        mealId: lunch.id,
        amount: 350,
        thawed: [],
        left: 350,
        inPantry: false,
      },
    ]);
    const keep = (date: string) =>
      t
        .http()
        .post(`/api/meal-plans/${plan.id}/frozen`)
        .set(as(user))
        .send({ ingredientId: chicken.id, date });
    const pantry = () =>
      t.prisma.inventoryItem.findMany({
        where: { profileId: adam.id },
        select: { quantity: true, unit: true, frozen: true, bestBefore: true },
      });

    // A package frozen before it: the rest goes in beside it, a package of its own.
    await t.prisma.inventoryItem.create({
      data: {
        profileId: adam.id,
        ingredientId: chicken.id,
        quantity: 100,
        unit: 'g',
        frozen: true,
        parcel: 2,
        bestBefore: new Date('2026-01-25'),
      },
    });

    // The day before the plan freezes it, nothing goes in: it is not even bought.
    plansTodayIs('2026-01-04');
    const early = await keep('2026-01-05');
    expect(early.status).toBe(409);
    expect(early.body.error).toBe('REST_NOT_FROZEN_YET');
    expect((await pantry()).filter((row) => row.quantity === 350)).toEqual([]);
    plansTodayIs('2026-01-05');

    // Asked twice at the same moment, and once more: given once.
    const answers = await Promise.all([keep('2026-01-05'), keep('2026-01-05')]);
    expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
    expect((await keep('2026-01-05')).body.packs.frozen[0]).toMatchObject({ inPantry: true });
    expect((await pantry()).sort((a, b) => a.quantity - b.quantity)).toEqual([
      { quantity: 100, unit: 'g', frozen: true, bestBefore: new Date('2026-01-25') },
      { quantity: 350, unit: 'g', frozen: true, bestBefore: new Date('2026-02-04') },
    ]);

    // A day the plan freezes nothing of it.
    const gone = await keep('2026-01-06');
    expect(gone.status).toBe(409);
    expect(gone.body.error).toBe('FROZEN_REST_GONE');
  });

  it('freezes what it does not eat fresh of meat and fish where it wastes less, and nothing in a plan made as usual', async () => {
    const chicken = await t.prisma.ingredient.findFirstOrThrow({
      where: { slug: 'chicken-breast' },
    });
    for (const [lessWaste, startDate] of [
      [true, '2026-01-05'],
      [false, '2026-01-12'],
    ] as const) {
      const plan = await t.app
        .get(PlanGenerationService)
        .generate(
          user.id,
          'en',
          GeneratePlanRequest.parse({ profileId: adam.id, startDate, durationDays: 3, lessWaste }),
        );
      // The first day's lunch alone takes chicken: 150 g of a pack of 500 g, which keeps two days.
      for (const day of [0, 1, 2])
        await menu(plan, day, [
          'scrambled-eggs-on-toast',
          day === 0 ? 'chicken-rice-broccoli' : 'tofu-rice-bowl',
          'chickpea-tomato-stew',
        ]);
      await t.prisma.plannedMeal.updateMany({
        where: { day: { planId: plan.id } },
        data: { rests: [] },
      });
      const { packs } = await read(plan.id);
      const left = packs.open.filter((pack) => pack.ingredientId === chicken.id);
      if (lessWaste) {
        expect(packs.frozen).toMatchObject([
          { ingredientId: chicken.id, date: startDate, amount: 350, left: 350 },
        ]);
        expect(left).toEqual([]);
      } else {
        expect(packs.frozen).toEqual([]);
        expect(left).toMatchObject([{ packSize: 500, left: 350, wasted: true }]);
      }
    }
  });

  it('counts the packs of the two plans of a joint plan together, in both of them', async () => {
    const adams = await together(false);
    const ewas = await read(adams.joint!.planId);
    // Chicken with rice at lunch in both, 150 g each of a pack of 500 g; the rest takes no chicken.
    for (const plan of [adams, ewas])
      for (const day of [0, 1, 2])
        await menu(
          plan,
          day,
          day === 0
            ? ['scrambled-eggs-on-toast', 'chicken-rice-broccoli', 'chickpea-tomato-stew']
            : ['scrambled-eggs-on-toast', 'tofu-rice-bowl', 'chickpea-tomato-stew'],
        );

    const [mine, theirs] = [await read(adams.id), await read(ewas.id)];
    const chicken = (plan: MealPlan) =>
      plan.packs.open.find((pack) => pack.name === 'Chicken breast');

    // One pack for both lunches: 200 g are left, not 350 g in each plan.
    expect(chicken(mine)).toMatchObject({ packs: 1, left: 200, wasted: true });
    expect(theirs.packs).toEqual(mine.packs);
  });

  /** The two plans of a joint plan with chicken at the first day's lunch alone in each: 150 g each, of a pack of 500 g. */
  async function chickenKitchen(lessWaste: boolean): Promise<[MealPlan, MealPlan]> {
    const adams = await together(lessWaste);
    const ewas = await read(adams.joint!.planId);
    for (const plan of [adams, ewas]) {
      for (const day of [0, 1, 2])
        await menu(
          plan,
          day,
          day === 0
            ? ['scrambled-eggs-on-toast', 'chicken-rice-broccoli', 'chickpea-tomato-stew']
            : ['scrambled-eggs-on-toast', 'tofu-rice-bowl', 'chickpea-tomato-stew'],
        );
      await t.prisma.plannedMeal.updateMany({
        where: { day: { planId: plan.id } },
        data: { rests: [] },
      });
    }
    return [adams, ewas];
  }
  const keepChicken = async (planId: string) => {
    const chicken = await t.prisma.ingredient.findFirstOrThrow({
      where: { slug: 'chicken-breast' },
    });
    return t
      .http()
      .post(`/api/meal-plans/${planId}/frozen`)
      .set(as(user))
      .send({ ingredientId: chicken.id, date: '2026-01-05' });
  };
  /** The frozen chicken of every pantry: whose, and how much. */
  const frozenChicken = () =>
    t.prisma.inventoryItem.findMany({
      where: { ingredient: { slug: 'chicken-breast' }, frozen: true },
      select: { profileId: true, quantity: true },
    });

  it('freezes in a joint plan that wastes less what is left of a pack both plans take from, in both of them', async () => {
    const [adams, ewas] = await chickenKitchen(true);

    const [mine, theirs] = [await read(adams.id), await read(ewas.id)];
    expect(mine.packs.open.find((pack) => pack.name === 'Chicken breast')).toBeUndefined();
    // The same rest in both, each said with the plan's own lunch that opens the pack.
    for (const plan of [mine, theirs])
      expect(plan.packs.frozen).toMatchObject([
        {
          name: 'Chicken breast',
          amount: 200,
          mealId: plan.days[0]!.meals.find((meal) => meal.mealType === 'lunch')!.id,
        },
      ]);
    const rests = (plan: MealPlan) => plan.packs.frozen.map(({ mealId: _, ...rest }) => rest);
    expect(rests(theirs)).toEqual(rests(mine));
  });

  it('gives a pantry the rest a joint plan freezes once: to the plan it is given from, marked given in both', async () => {
    const [adams, ewas] = await chickenKitchen(true);

    expect((await keepChicken(adams.id)).status).toBe(200);
    expect(await frozenChicken()).toEqual([{ profileId: adam.id, quantity: 200 }]);
    for (const plan of [adams, ewas])
      expect((await read(plan.id)).packs.frozen).toMatchObject([{ amount: 200, inPantry: true }]);

    // Given again from the other plan of the kitchen: nothing more goes into any pantry.
    const again = await keepChicken(ewas.id);
    expect(again.status).toBe(200);
    expect(again.body.packs.frozen).toMatchObject([{ amount: 200, inPantry: true }]);
    expect(await frozenChicken()).toEqual([{ profileId: adam.id, quantity: 200 }]);
  });

  it('gives a pantry the rest of a joint plan once when both plans give it at the same moment', async () => {
    const [adams, ewas] = await chickenKitchen(true);

    const answers = await Promise.all([keepChicken(adams.id), keepChicken(ewas.id)]);
    expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
    const given = await frozenChicken();
    expect(given).toHaveLength(1);
    expect(given[0]!.quantity).toBe(200);
    expect([adam.id, ewa.id]).toContain(given[0]!.profileId);
  });

  it('freezes in both plans of a kitchen where one of them was made again alone as usual', async () => {
    const [adams, ewas] = await chickenKitchen(true);
    // Ewa's plan made again alone, as a plan that does not waste less; then the same chicken lunch again.
    await t.app
      .get(PlanGenerationService)
      .regenerate(user.id, 'en', ewas.id, RegenerateRequest.parse({ lessWaste: false }));
    const remade = await read(ewas.id);
    expect(remade.options).toMatchObject({ lessWaste: false, noWaste: false });
    for (const day of [0, 1, 2])
      await menu(
        remade,
        day,
        day === 0
          ? ['scrambled-eggs-on-toast', 'chicken-rice-broccoli', 'chickpea-tomato-stew']
          : ['scrambled-eggs-on-toast', 'tofu-rice-bowl', 'chickpea-tomato-stew'],
      );
    await t.prisma.plannedMeal.updateMany({
      where: { day: { planId: ewas.id } },
      data: { rests: [] },
    });

    // Adam's plan still wastes less, and the kitchen they share freezes: as each plan reads, and as its reminder counts.
    for (const plan of [adams, ewas]) {
      const { packs } = await read(plan.id);
      expect(packs.frozen).toMatchObject([{ name: 'Chicken breast', amount: 200 }]);
      expect(packs.open.find((pack) => pack.name === 'Chicken breast')).toBeUndefined();
      expect((await packsOfPlan(t.prisma, user.id, plan.id, 'en'))!.frozen).toMatchObject([
        { name: 'Chicken breast', amount: 200 },
      ]);
    }
  });

  it('closes the days made again with what stays in the plan and with the other plan of the kitchen', async () => {
    const adams = await together(true);
    const ewas = await read(adams.joint!.planId);
    for (const plan of [adams, ewas])
      for (const day of [0, 1, 2])
        await menu(plan, day, [
          'scrambled-eggs-on-toast',
          day === 0 ? 'chicken-rice-broccoli' : 'tofu-rice-bowl',
          'chickpea-tomato-stew',
        ]);
    const generation = t.app.get(PlanGenerationService);

    // The second day of Adam's plan alone is made again.
    const prepared = await generation.prepare(
      user.id,
      adams.id,
      { from: '2026-01-06', to: '2026-01-06' },
      RegenerateDayRequest.parse({}),
      '2026-01-01',
    );
    const chicken = await t.prisma.ingredient.findFirstOrThrow({
      where: { slug: 'chicken-breast' },
    });
    const takes = (packed: Parameters<typeof menuNeeds>[0]) =>
      menuNeeds(packed, 3).needs.get(chicken.id) ?? [0, 0, 0];

    // What stays of Adam's plan: the first and the third day; the lunch of the first takes 150 g of chicken.
    expect(takes(prepared.fixed.own)).toEqual([150, 0, 0]);
    // Ewa's plan, cooked in the same kitchen: her lunch of the first day as well.
    expect(takes(prepared.fixed.partner)).toEqual([150, 0, 0]);

    // A plan that does not waste less closes nothing, and reads nothing for it.
    await t.prisma.mealPlan.update({
      where: { id: adams.id },
      data: { options: { ...adams.options, lessWaste: false } },
    });
    const plain = await generation.prepare(
      user.id,
      adams.id,
      { from: '2026-01-06', to: '2026-01-06' },
      RegenerateDayRequest.parse({}),
      '2026-01-01',
    );
    expect(plain.fixed).toEqual({ own: [], partner: [] });
  });
});
