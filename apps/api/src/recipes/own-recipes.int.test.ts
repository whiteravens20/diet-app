// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Recipe } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { recipeFacts } from '../engine/recipe-facts.js';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aProfile, aPlan, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import {
  MAX_OWN_RECIPES_PER_DAY,
  MAX_PERSONAL_RECIPES,
  PersonalRecipesService,
} from './personal-recipes.service.js';

let t: TestApp;
let personal: PersonalRecipesService;

beforeAll(async () => {
  t = await createTestApp();
  await resetDatabase(t.prisma);
  await seedCatalogue(t.prisma);
  personal = t.app.get(PersonalRecipesService);
});

afterAll(async () => {
  await t.close();
});

let user: TestUser;

beforeEach(async () => {
  await resetUserData(t.prisma);
  user = await aUser(t);
});

const ingredientId = async (slug: string): Promise<string> =>
  (await t.prisma.ingredient.findUniqueOrThrow({ where: { slug } })).id;

/** A dinner written in Polish: no recipe of the library is made the same way. */
async function written(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return {
    title: 'Kurczak z ryżem i pomidorem',
    description: 'Mój obiad na co dzień.',
    steps: ['Ugotuj ryż.', 'Usmaż kurczaka z pomidorem.'],
    servings: 1,
    mealTypes: ['dinner'],
    prepMinutes: 10,
    cookMinutes: 20,
    difficulty: 'easy',
    cuisine: null,
    ingredients: [
      { ingredientId: await ingredientId('chicken-breast'), quantity: 120, unit: 'g', note: null },
      { ingredientId: await ingredientId('tomato'), quantity: 150, unit: 'g', note: 'pokrojony' },
      { ingredientId: await ingredientId('white-rice'), quantity: 60, unit: 'g', note: null },
    ],
    ...overrides,
  };
}

const write = (body: Record<string, unknown>, locale = 'pl', by: TestUser = user) =>
  t.http().post('/api/recipes').set(as(by)).set('accept-language', locale).send(body);

const edit = (id: string, body: Record<string, unknown>, locale = 'pl', by: TestUser = user) =>
  t.http().put(`/api/recipes/${id}`).set(as(by)).set('accept-language', locale).send(body);

/** What the engine works out for the lines of `body`. */
async function factsOf(body: Record<string, unknown>) {
  const lines = body.ingredients as { ingredientId: string; quantity: number; unit: 'g' }[];
  return recipeFacts(
    await Promise.all(
      lines.map(async (line) => ({
        quantity: line.quantity,
        unit: line.unit,
        ingredient: await t.prisma.ingredient.findUniqueOrThrow({
          where: { id: line.ingredientId },
        }),
      })),
    ),
    body.servings as number,
  );
}

describe('a recipe written by hand', () => {
  it("is its writer's own, in the language it was written in, with what the engine works out", async () => {
    const body = await written();

    const res = await write(body).expect(201);
    const recipe = res.body as Recipe;

    const facts = await factsOf(body);
    expect(recipe).toMatchObject({
      title: 'Kurczak z ryżem i pomidorem',
      steps: ['Ugotuj ryż.', 'Usmaż kurczaka z pomidorem.'],
      origin: 'manual',
      byModel: null,
      nutritionPerServing: facts.perServing,
      allergens: facts.allergens,
      dietTags: facts.dietTags,
    });
    expect(recipe.ingredients.map((line) => line.note)).toEqual([null, 'pokrojony', null]);
    const translations = await t.prisma.recipeTranslation.findMany({
      where: { recipeId: recipe.id },
    });
    expect(translations.map((row) => row.locale)).toEqual(['pl']);
    // Read in English, it says what it was written to say.
    const english = await t
      .http()
      .get(`/api/recipes/${recipe.id}`)
      .set(as(user))
      .set('accept-language', 'en')
      .expect(200);
    expect(english.body.title).toBe('Kurczak z ryżem i pomidorem');
    // Nobody else can open it.
    await t
      .http()
      .get(`/api/recipes/${recipe.id}`)
      .set(as(await aUser(t)))
      .expect(404);
    // Nothing of it reaches the curators while its owner keeps it.
    expect(await t.prisma.recipeDraft.count()).toBe(0);
  });

  it('keeps its lines in the order they were written in, whatever the table does with them', async () => {
    const body = await written();
    const lines = body.ingredients as { ingredientId: string }[];
    body.ingredients = [lines[2], lines[0], lines[1]];
    const recipe = (await write(body).expect(201)).body as Recipe;
    // The table is put in the order of its keys, which is the reverse of the recipe's.
    const stored = await t.prisma.recipeIngredient.findMany({
      where: { recipeId: recipe.id },
      orderBy: { position: 'asc' },
    });
    for (const [index, line] of stored.entries()) {
      await t.prisma.recipeIngredient.update({
        where: { id: line.id },
        data: { id: `00000000-0000-4000-8000-00000000000${stored.length - index}` },
      });
    }
    await t.prisma.$executeRawUnsafe('CLUSTER "RecipeIngredient" USING "RecipeIngredient_pkey"');

    const read = await t.http().get(`/api/recipes/${recipe.id}`).set(as(user)).expect(200);

    expect((read.body as Recipe).ingredients.map((line) => line.ingredientId)).toEqual(
      [lines[2], lines[0], lines[1]].map((line) => line!.ingredientId),
    );
  });

  it('is refused with every rule it breaks named by its place', async () => {
    const res = await write(
      await written({ title: 'Kurczak <b>z ryżem</b>', steps: ['   ', 'Usmaż‮kurczaka.'] }),
    ).expect(400);

    expect(res.body.error).toBe('RECIPE_INVALID');
    expect(
      (res.body.details.problems as { path: string; rule: string }[]).map((p) => [p.path, p.rule]),
    ).toEqual([
      ['titles.pl', 'markup'],
      ['steps.pl[1]', 'markup'],
    ]);
    expect(await t.prisma.recipe.count({ where: { createdByUserId: user.id } })).toBe(0);
  });

  it('is refused for more of an ingredient than a serving can hold', async () => {
    const body = await written();
    (body.ingredients as { quantity: number }[])[2]!.quantity = 5_000;

    const res = await write(body).expect(400);

    expect(res.body.error).toBe('RECIPE_INVALID');
    expect(res.body.details.problems[0]).toMatchObject({
      path: 'ingredients[2].quantity',
      rule: 'quantity-too-large',
    });
  });

  it('is refused for an ingredient the catalogue does not have, or has retired', async () => {
    const unknown = await written();
    (unknown.ingredients as { ingredientId: string }[])[0]!.ingredientId =
      '00000000-0000-4000-8000-000000000000';
    expect((await write(unknown).expect(404)).body.error).toBe('INGREDIENT_NOT_FOUND');

    const tomato = await ingredientId('tomato');
    await t.prisma.ingredient.update({ where: { id: tomato }, data: { retiredAt: new Date() } });
    try {
      expect((await write(await written()).expect(404)).body.error).toBe('INGREDIENT_NOT_FOUND');
    } finally {
      await t.prisma.ingredient.update({ where: { id: tomato }, data: { retiredAt: null } });
    }
  });

  it('is refused for an ingredient measured in a unit it cannot be converted from', async () => {
    const rice = await t.prisma.ingredient.findUniqueOrThrow({ where: { slug: 'white-rice' } });
    expect(rice.gramsPerPiece).toBeNull();
    const body = await written();
    (body.ingredients as { unit: string; quantity: number }[])[2]!.unit = 'piece';
    (body.ingredients as { unit: string; quantity: number }[])[2]!.quantity = 2;

    expect((await write(body).expect(400)).body.error).toBe('UNIT_CONVERSION_FAILED');
  });

  it("keeps its writer's text where the library has a recipe made the same way", async () => {
    const library = await t.prisma.recipe.findUniqueOrThrow({
      where: { slug: 'tofu-rice-bowl' },
      include: { ingredients: true },
    });
    const body = await written({
      title: 'Moja miska z tofu',
      servings: library.servings,
      mealTypes: library.mealTypes,
      ingredients: library.ingredients.map((line) => ({
        ingredientId: line.ingredientId,
        quantity: line.quantity,
        unit: line.unit,
        note: null,
      })),
    });

    const recipe = (await write(body).expect(201)).body as Recipe;

    expect(recipe.id).not.toBe(library.id);
    expect(recipe.title).toBe('Moja miska z tofu');
    const stored = await t.prisma.recipe.findUniqueOrThrow({ where: { id: recipe.id } });
    expect(stored.fingerprint).toBe(library.fingerprint);
  });

  it('is refused where its writer has the same recipe, which is named', async () => {
    const first = (await write(await written()).expect(201)).body as Recipe;

    const res = await write(await written({ title: 'Ten sam obiad' })).expect(409);

    expect(res.body).toMatchObject({
      error: 'RECIPE_ALREADY_YOURS',
      details: { recipeId: first.id },
    });
  });

  it('is written anew where its writer had the same recipe and deleted it', async () => {
    const first = (await write(await written()).expect(201)).body as Recipe;
    await t.http().delete(`/api/recipes/${first.id}`).set(as(user)).expect(204);

    const second = (await write(await written({ title: 'Obiad od nowa' })).expect(201))
      .body as Recipe;

    expect(second.id).not.toBe(first.id);
    expect(second.title).toBe('Obiad od nowa');
    const old = await t.prisma.recipe.findUniqueOrThrow({ where: { id: first.id } });
    expect(old.deletedAt).not.toBeNull();
  });

  it('goes before the curators when its writer submits it, in the language it was written in', async () => {
    const recipe = (await write(await written()).expect(201)).body as Recipe;

    await t.http().post(`/api/recipes/${recipe.id}/submit`).set(as(user)).expect(204);

    const [draft] = await t.prisma.recipeDraft.findMany();
    expect(draft).toMatchObject({
      locales: ['pl'],
      titles: { pl: 'Kurczak z ryżem i pomidorem' },
      steps: { pl: ['Ugotuj ryż.', 'Usmaż kurczaka z pomidorem.'] },
      source: 'AI_USER',
      status: 'PENDING',
      sourceRecipeIds: [recipe.id],
    });
  });
});

describe('the preview of a recipe being written', () => {
  it('says what a serving would hold, its allergens and its diets, and stores nothing', async () => {
    const body = await written({ servings: 2 });

    const res = await t
      .http()
      .post('/api/recipes/preview')
      .set(as(user))
      .send({ servings: body.servings, ingredients: body.ingredients })
      .expect(200);

    const facts = await factsOf(body);
    expect(res.body).toEqual({
      nutritionPerServing: facts.perServing,
      allergens: facts.allergens,
      dietTags: facts.dietTags,
    });
    expect(await t.prisma.recipe.count({ where: { createdByUserId: user.id } })).toBe(0);
  });
});

describe("an edit of a recipe of one's own", () => {
  it('writes a new version: plans keep the old one, favourites and favourite sets name the new one', async () => {
    const profile = await aProfile(t, user);
    const plan = await aPlan(t, user, profile);
    const old = (await write(await written()).expect(201)).body as Recipe;
    const meal = plan.days[0]!.meals.find((m) => m.mealType === 'dinner')!;
    await t.prisma.plannedMeal.update({ where: { id: meal.id }, data: { recipeId: old.id } });
    await t.prisma.favorite.create({
      data: { profileId: profile.id, recipeId: old.id, sentiment: 'favorite', tags: [] },
    });
    const set = await t.prisma.favoriteSet.create({
      data: { profileId: profile.id, label: 'Mój dzień', slots: { dinner: old.id } },
    });
    const body = await written({ title: 'Kurczak z większą porcją ryżu' });
    (body.ingredients as { quantity: number }[])[2]!.quantity = 90;

    const res = await edit(old.id, body).expect(200);
    const recipe = res.body as Recipe;

    expect(recipe.id).not.toBe(old.id);
    expect(recipe).toMatchObject({ title: 'Kurczak z większą porcją ryżu', origin: 'manual' });
    expect(recipe.nutritionPerServing).toEqual((await factsOf(body)).perServing);
    const before = await t.prisma.recipe.findUniqueOrThrow({ where: { id: old.id } });
    expect(before).toMatchObject({ fingerprint: null, title: 'Kurczak z ryżem i pomidorem' });
    expect(before.deletedAt).not.toBeNull();
    expect(
      (await t.prisma.plannedMeal.findUniqueOrThrow({ where: { id: meal.id } })).recipeId,
    ).toBe(old.id);
    expect(
      (await t.prisma.favorite.findMany({ where: { profileId: profile.id } })).map(
        (row) => row.recipeId,
      ),
    ).toEqual([recipe.id]);
    expect((await t.prisma.favoriteSet.findUniqueOrThrow({ where: { id: set.id } })).slots).toEqual(
      {
        dinner: recipe.id,
      },
    );
    const mine = await t.http().get('/api/recipes/mine').set(as(user)).expect(200);
    expect(mine.body.items.map((r: Recipe) => r.id)).toEqual([recipe.id]);
    await t.http().get(`/api/recipes/${old.id}`).set(as(user)).expect(404);
  });

  it('of the text alone writes a new version just the same', async () => {
    const old = (await write(await written()).expect(201)).body as Recipe;

    const recipe = (await edit(old.id, await written({ title: 'Lepsza nazwa' })).expect(200))
      .body as Recipe;

    expect(recipe.id).not.toBe(old.id);
    expect(recipe.title).toBe('Lepsza nazwa');
  });

  it('of a recipe a model wrote is written by hand and keeps the mark of the model', async () => {
    const drafted = await personal.save({
      userId: user.id,
      origin: 'ai',
      text: new Map([['en', { title: 'Chicken bowl', description: 'A bowl.', steps: ['Cook.'] }]]),
      modelWrote: new Set(['en']),
      servings: 1,
      mealTypes: ['lunch'],
      prepMinutes: 5,
      cookMinutes: 10,
      difficulty: 'easy',
      ingredients: [
        {
          ingredientId: await ingredientId('chicken-breast'),
          quantity: 100,
          unit: 'g',
          note: null,
        },
      ],
      facts: {
        perServing: { calories: 165, protein: 31, fat: 4, carbs: 0 },
        allergens: [],
        dietTags: [],
      },
    });

    const recipe = (await edit(drafted, await written()).expect(200)).body as Recipe;

    expect(recipe).toMatchObject({ origin: 'manual', byModel: 'changed' });
  });

  it('of a recipe made by swapping an ingredient stays one, and is still not to be submitted', async () => {
    const swapped = await personal.save({
      userId: user.id,
      origin: 'swap',
      text: new Map([['en', { title: 'Swapped bowl', description: 'A bowl.', steps: ['Cook.'] }]]),
      servings: 1,
      mealTypes: ['lunch'],
      prepMinutes: 5,
      cookMinutes: 10,
      difficulty: 'easy',
      ingredients: [
        {
          ingredientId: await ingredientId('chicken-breast'),
          quantity: 100,
          unit: 'g',
          note: null,
        },
      ],
      facts: {
        perServing: { calories: 165, protein: 31, fat: 4, carbs: 0 },
        allergens: [],
        dietTags: [],
      },
    });

    const recipe = (await edit(swapped, await written()).expect(200)).body as Recipe;

    expect(recipe).toMatchObject({ origin: 'swap', byModel: null });
    const submitted = await t.http().post(`/api/recipes/${recipe.id}/submit`).set(as(user));
    expect(submitted.status).toBe(409);
    expect(submitted.body.error).toBe('RECIPE_SWAP_NOT_SUBMITTABLE');
    expect(await t.prisma.recipeDraft.count()).toBe(0);
  });

  it("is refused for another user's recipe, a recipe of the library and a deleted one, as for one that is not there", async () => {
    const theirs = (await write(await written(), 'pl', await aUser(t)).expect(201)).body as Recipe;
    const library = await t.prisma.recipe.findUniqueOrThrow({ where: { slug: 'tofu-rice-bowl' } });
    const deleted = (await write(await written()).expect(201)).body as Recipe;
    await t.http().delete(`/api/recipes/${deleted.id}`).set(as(user)).expect(204);

    for (const id of [theirs.id, library.id, deleted.id]) {
      expect((await edit(id, await written({ title: 'Cudzy' })).expect(404)).body.error).toBe(
        'RECIPE_NOT_FOUND',
      );
    }
    expect(await t.prisma.recipe.count({ where: { title: 'Cudzy' } })).toBe(0);
  });

  it('that makes it another recipe of its owner is refused, naming that one, and changes nothing', async () => {
    const one = (await write(await written()).expect(201)).body as Recipe;
    const other = await written({ title: 'Drugi obiad' });
    (other.ingredients as { quantity: number }[])[0]!.quantity = 200;
    const two = (await write(other).expect(201)).body as Recipe;

    const res = await edit(two.id, await written()).expect(409);

    expect(res.body).toMatchObject({
      error: 'RECIPE_ALREADY_YOURS',
      details: { recipeId: one.id },
    });
    const kept = await t.prisma.recipe.findUniqueOrThrow({ where: { id: two.id } });
    expect(kept.deletedAt).toBeNull();
    expect(kept.fingerprint).not.toBeNull();
  });
});

describe('the recipes one account may write by hand', () => {
  /** Rows of the account's own written by hand at `at`, deleted where asked. */
  const rows = (
    count: number,
    at: Date,
    extra: { deletedAt?: Date; edited?: boolean; origin?: 'manual' | 'swap' } = {},
  ) =>
    t.prisma.recipe.createMany({
      data: Array.from({ length: count }, (_, index) => ({
        title: `Row ${index}`,
        description: '',
        servings: 1,
        prepMinutes: 0,
        cookMinutes: 0,
        origin: extra.origin ?? ('manual' as const),
        edited: extra.edited ?? false,
        createdByUserId: user.id,
        createdAt: at,
        deletedAt: extra.deletedAt ?? null,
      })),
    });

  it('are at most a number a day, written or edited, deleted ones counted', async () => {
    const now = new Date();
    await rows(MAX_OWN_RECIPES_PER_DAY - 11, now, { deletedAt: now });
    await rows(10, now, { origin: 'swap', edited: true });
    // A day and more ago does not count.
    await rows(5, new Date(Date.now() - 25 * 3_600_000));
    const last = (await write(await written()).expect(201)).body as Recipe;

    const res = await write(await written({ title: 'Jeden za dużo', mealTypes: ['lunch'] }));
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('OWN_RECIPE_DAILY_LIMIT');
    expect((await edit(last.id, await written({ title: 'Edycja za dużo' }))).status).toBe(429);
  });

  it('count an edit as the recipe it replaces among those the account holds', async () => {
    await rows(MAX_PERSONAL_RECIPES - 1, new Date(Date.now() - 25 * 3_600_000));
    const last = (await write(await written()).expect(201)).body as Recipe;

    await edit(last.id, await written({ title: 'Wciąż się mieści' })).expect(200);
    const res = await write(await written({ title: 'Już się nie mieści', mealTypes: ['lunch'] }));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('PERSONAL_RECIPE_LIMIT');
  });
});
