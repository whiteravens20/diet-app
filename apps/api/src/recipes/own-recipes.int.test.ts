// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { MealPlan, Recipe } from '@diet-app/shared';
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
import { roundLabel, UNKNOWN_LABEL } from '../engine/label-totals.js';

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
      // Its writer set none: those its ingredients and title suggest, for the curator to approve.
      taste: 'savoury',
      form: 'plate',
      starchBase: 'rice',
    });
  });

  it('goes before the curators with the traits its writer set', async () => {
    const recipe = (
      await write(await written({ taste: 'savoury', form: 'salad', starchBase: 'none' })).expect(
        201,
      )
    ).body as Recipe;

    await t.http().post(`/api/recipes/${recipe.id}/submit`).set(as(user)).expect(204);

    expect(await t.prisma.recipeDraft.findFirstOrThrow()).toMatchObject({
      taste: 'savoury',
      form: 'salad',
      starchBase: 'none',
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
      labelPerServing: roundLabel(facts.labelPerServing),
      allergens: facts.allergens,
      dietTags: facts.dietTags,
      // Chicken with rice, no title yet: a savoury plate on rice.
      traits: { taste: 'savoury', form: 'plate', starchBase: 'rice' },
    });
    expect(await t.prisma.recipe.count({ where: { createdByUserId: user.id } })).toBe(0);
  });

  it('proposes the form its title names', async () => {
    const body = await written();
    const res = await t
      .http()
      .post('/api/recipes/preview')
      .set(as(user))
      .send({
        servings: body.servings,
        ingredients: body.ingredients,
        title: 'Zupa z kurczaka i ryżu',
      })
      .expect(200);
    expect(res.body.traits).toEqual({ taste: 'savoury', form: 'soup', starchBase: 'rice' });
  });
});

describe("the traits of a recipe of one's own", () => {
  it('are those its writer set, or, left out, those its ingredients and title suggest', async () => {
    const set = (
      await write(await written({ taste: 'savoury', form: 'salad', starchBase: 'none' })).expect(
        201,
      )
    ).body as Recipe;
    expect(await t.prisma.recipe.findUniqueOrThrow({ where: { id: set.id } })).toMatchObject({
      taste: 'savoury',
      form: 'salad',
      starchBase: 'none',
    });
    expect(
      (await t.http().get(`/api/recipes/${set.id}`).set(as(user)).expect(200)).body.traits,
    ).toEqual({
      taste: 'savoury',
      form: 'salad',
      starchBase: 'none',
    });

    const other = await written({ title: 'Kurczak z ryżem na talerzu' });
    (other.ingredients as { quantity: number }[])[2]!.quantity = 70;
    const proposed = (await write(other).expect(201)).body as Recipe;
    expect(await t.prisma.recipe.findUniqueOrThrow({ where: { id: proposed.id } })).toMatchObject({
      taste: null,
      form: null,
      starchBase: null,
    });
    expect(
      (await t.http().get(`/api/recipes/${proposed.id}`).set(as(user)).expect(200)).body.traits,
    ).toEqual({
      taste: 'savoury',
      form: 'plate',
      starchBase: 'rice',
    });
  });

  it('changed alone, make a new version even of a recipe made by swapping an ingredient, as any change but of its words', async () => {
    const old = (await write(await written()).expect(201)).body as Recipe;
    // One made by swapping an ingredient takes new words in place; anything else makes a new version.
    await t.prisma.recipe.update({ where: { id: old.id }, data: { origin: 'swap' } });
    const changed = (await edit(old.id, await written({ form: 'salad' })).expect(200))
      .body as Recipe;
    expect(changed.id).not.toBe(old.id);
    expect(await t.prisma.recipe.findUniqueOrThrow({ where: { id: changed.id } })).toMatchObject({
      form: 'salad',
    });
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
        labelPerServing: UNKNOWN_LABEL,
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
        labelPerServing: UNKNOWN_LABEL,
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

  describe('of a recipe made by swapping an ingredient, in its words alone', () => {
    /** A dinner made by a swap, in English and in Polish, held by a dinner of a plan of the user's. */
    async function swappedInAPlan() {
      const profile = await aProfile(t, user);
      const plan = await aPlan(t, user, profile);
      const id = await personal.save({
        userId: user.id,
        origin: 'swap',
        text: new Map([
          [
            'en',
            { title: 'Bowl (with chicken)', description: 'A bowl.', steps: ['Cook chicken.'] },
          ],
          [
            'pl',
            {
              title: 'Miska (zamiennik: kurczak)',
              description: 'Miska.',
              steps: ['Usmaż kurczak.'],
            },
          ],
        ]),
        servings: 1,
        mealTypes: ['dinner'],
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
          labelPerServing: UNKNOWN_LABEL,
          allergens: [],
          dietTags: [],
        },
      });
      const meal = plan.days[0]!.meals.find((m) => m.mealType === 'dinner')!;
      await t.prisma.plannedMeal.update({ where: { id: meal.id }, data: { recipeId: id } });
      const read = async (locale: string) =>
        (await t.http().get(`/api/recipes/${id}`).set(as(user)).set('accept-language', locale))
          .body as Recipe;
      const dinnerOfThePlan = async () =>
        (
          (
            await t
              .http()
              .get(`/api/meal-plans/${plan.id}`)
              .set(as(user))
              .set('accept-language', 'pl')
              .expect(200)
          ).body as MealPlan
        ).days[0]!.meals.find((m) => m.id === meal.id)!;
      return { id, read, dinnerOfThePlan };
    }

    /** What the edit page sends for `recipe` as it stands, with `over` changed. */
    const asItStands = (recipe: Recipe, over: Record<string, unknown> = {}) => ({
      title: recipe.title,
      description: recipe.description,
      steps: recipe.steps,
      servings: recipe.servings,
      mealTypes: recipe.mealTypes,
      prepMinutes: recipe.prepMinutes,
      cookMinutes: recipe.cookMinutes,
      difficulty: recipe.difficulty,
      cuisine: recipe.cuisine,
      ingredients: recipe.ingredients.map((line) => ({
        ingredientId: line.ingredientId,
        quantity: line.quantity,
        unit: line.unit,
        note: line.note,
      })),
      ...over,
    });

    it('writes them in that recipe, which the plan that holds it reads at once', async () => {
      const swapped = await swappedInAPlan();
      const words = {
        title: 'Miska z kurczakiem',
        description: 'Miska na obiad.',
        steps: ['Usmaż kurczaka.'],
      };

      const answer = await t
        .http()
        .put(`/api/recipes/${swapped.id}/text`)
        .set(as(user))
        .set('accept-language', 'pl')
        .send(words)
        .expect(200);

      expect(answer.body).toMatchObject({ id: swapped.id, origin: 'swap', ...words });
      expect((await swapped.dinnerOfThePlan()).recipe).toMatchObject({
        id: swapped.id,
        title: 'Miska z kurczakiem',
      });
      expect(await swapped.read('en')).toMatchObject({
        title: 'Bowl (with chicken)',
        steps: ['Cook chicken.'],
      });
      expect(await t.prisma.recipe.count({ where: { createdByUserId: user.id } })).toBe(1);
    });

    it('takes an edit of the words alone in place, and an edit of an amount as a new version', async () => {
      const swapped = await swappedInAPlan();
      const before = await swapped.read('pl');

      const worded = (
        await edit(swapped.id, asItStands(before, { steps: ['Usmaż kurczaka.'] })).expect(200)
      ).body as Recipe;
      const more = asItStands(worded);
      (more.ingredients as { quantity: number }[])[0]!.quantity = 150;
      const another = (await edit(swapped.id, more).expect(200)).body as Recipe;

      expect(worded).toMatchObject({ id: swapped.id, steps: ['Usmaż kurczaka.'] });
      expect(another.id).not.toBe(swapped.id);
      expect(another.origin).toBe('swap');
      expect((await swapped.dinnerOfThePlan()).recipe).toMatchObject({
        id: swapped.id,
        steps: ['Usmaż kurczaka.'],
      });
    });

    it("are refused for any other recipe of one's own, for markup, and for a recipe of somebody else", async () => {
      const swapped = await swappedInAPlan();
      const handWritten = (await write(await written()).expect(201)).body as Recipe;
      const words = (id: string, body: Record<string, unknown>, by: TestUser = user) =>
        t.http().put(`/api/recipes/${id}/text`).set(as(by)).set('accept-language', 'pl').send(body);
      const plain = { title: 'Nowa nazwa', description: 'Opis.', steps: ['Ugotuj.'] };

      const notASwap = await words(handWritten.id, plain).expect(409);
      const markup = await words(swapped.id, { ...plain, steps: ['<b>Ugotuj</b>'] }).expect(400);
      const theirs = await words(swapped.id, plain, await aUser(t)).expect(404);

      expect(notASwap.body.error).toBe('RECIPE_WORDS_ONLY_OF_A_SWAP');
      expect(markup.body.error).toBe('RECIPE_INVALID');
      expect(theirs.body.error).toBe('RECIPE_NOT_FOUND');
      expect((await swapped.read('pl')).title).toBe('Miska (zamiennik: kurczak)');
    });
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
