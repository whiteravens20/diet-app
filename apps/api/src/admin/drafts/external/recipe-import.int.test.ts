// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RecipeImportRequest, type RecipeImportResult } from '@diet-app/shared';
import { catalogueDirectory, seedCatalogue } from '../../../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../../../testing/database.js';
import { as, asAdmin, aUser } from '../../../testing/factories.js';
import { createTestApp, type TestApp } from '../../../testing/test-app.js';
import { IMPORT_ALIASES_FILE } from './import-aliases.js';
import { RecipeImportService } from './recipe-import.service.js';

const CC_BY = 'https://creativecommons.org/licenses/by/4.0/';

/** A recipe as a page writes it for a search engine. The catalogue of the tests has all it is made of. */
const salmonBowl = {
  '@context': 'https://schema.org',
  '@type': 'Recipe',
  name: 'Salmon rice bowl',
  description: 'Salmon over rice with broccoli.',
  recipeIngredient: [
    '150 g salmon',
    '80 g white rice',
    '120 g broccoli, cut into florets',
    '1 tbsp olive oil',
  ],
  recipeInstructions: [
    { '@type': 'HowToStep', text: 'Cook the rice.' },
    { '@type': 'HowToStep', text: 'Fry the salmon and steam the broccoli.' },
    { '@type': 'HowToStep', text: 'Serve the salmon over the rice.' },
  ],
  recipeYield: '1 serving',
  prepTime: 'PT10M',
  cookTime: 'PT15M',
  recipeCategory: 'Dinner',
  url: 'https://recipes.example/salmon-rice-bowl',
  license: CC_BY,
};

describe('taking recipes in from a document', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
  });

  afterAll(async () => {
    rmSync(join(catalogueDirectory(), IMPORT_ALIASES_FILE), { force: true });
    await t.close();
  });

  beforeEach(async () => {
    await resetUserData(t.prisma);
    await t.prisma.recipe.deleteMany({ where: { origin: { in: ['ai', 'curated'] } } });
    rmSync(join(catalogueDirectory(), IMPORT_ALIASES_FILE), { force: true });
  });

  /** A document as a request carries it: its text. */
  const textOf = (document: unknown): string =>
    typeof document === 'string' ? document : JSON.stringify(document);
  /** Over HTTP, which takes ten imports a minute: the tests about the route itself go this way. */
  const send = (body: Record<string, unknown>) =>
    t
      .http()
      .post('/api/admin/drafts/recipes/import')
      .set(asAdmin)
      .send('document' in body ? { ...body, document: textOf(body.document) } : body);
  /** The import as the route runs it, once the request has passed the contract. */
  const take = (
    document: unknown,
    more: Record<string, unknown> = {},
  ): Promise<RecipeImportResult> =>
    t.app
      .get(RecipeImportService)
      .import(RecipeImportRequest.parse({ document: textOf(document), ...more }));
  const rejections = async () =>
    (await t.http().get('/api/admin/drafts/recipes/import/rejections').set(asAdmin).expect(200))
      .body;

  it("makes a draft of a recipe that resolves: its lines as ingredients of the catalogue, its figures the engine's, where it is from beside it", async () => {
    const result: RecipeImportResult = (await send({ document: salmonBowl }).expect(200)).body;

    expect(result).toMatchObject({
      found: 1,
      drafted: [{ slug: 'salmon-rice-bowl', title: 'Salmon rice bowl' }],
      rejected: [],
      dryRun: false,
    });
    expect(result.batchId).toMatch(/^imp-/);
    const draft = await t.prisma.recipeDraft.findFirstOrThrow({
      where: { slug: 'salmon-rice-bowl' },
    });
    expect(draft).toMatchObject({
      status: 'PENDING',
      source: 'EXTERNAL',
      batchId: result.batchId,
      locales: ['en'],
      titles: { en: 'Salmon rice bowl' },
      descriptions: { en: 'Salmon over rice with broccoli.' },
      steps: {
        en: [
          'Cook the rice.',
          'Fry the salmon and steam the broccoli.',
          'Serve the salmon over the rice.',
        ],
      },
      servings: 1,
      mealTypes: ['dinner'],
      prepMinutes: 10,
      cookMinutes: 15,
      allergens: ['fish'],
      provenanceUrl: 'https://recipes.example/salmon-rice-bowl',
      provenanceLicense: CC_BY,
      modelUsed: null,
    });
    expect(draft.ingredientsJson).toEqual([
      { slug: 'salmon', quantity: 150, unit: 'g', note: null },
      { slug: 'white-rice', quantity: 80, unit: 'g', note: null },
      { slug: 'broccoli', quantity: 120, unit: 'g', note: null },
      { slug: 'olive-oil', quantity: 15, unit: 'ml', note: null },
    ]);
    // 312 of salmon, 288 of rice, 41 of broccoli and 122 of oil.
    expect(draft.caloriesPerServing).toBeGreaterThan(755);
    expect(draft.caloriesPerServing).toBeLessThan(770);
    expect(await rejections()).toEqual([]);
  });

  it('says what would become of a document and writes nothing, when asked to look only', async () => {
    const result = await take(salmonBowl, { dryRun: true });

    expect(result).toMatchObject({
      batchId: null,
      found: 1,
      drafted: [{ slug: 'salmon-rice-bowl' }],
      rejected: [],
      dryRun: true,
    });
    expect(await t.prisma.recipeDraft.count()).toBe(0);
  });

  it('refuses a recipe it cannot answer for, names every reason, and keeps the refusal where no reviewer sees it', async () => {
    const vague = {
      '@type': 'Recipe',
      name: 'Garlic rice',
      recipeIngredient: [
        '80 g white rice',
        '2 cloves garlic',
        'salt to taste',
        '2-3 tomatoes',
        '100 g dragon fruit',
        '1 cup broccoli',
      ],
      recipeInstructions: 'Cook it all.',
    };

    const result = await take([vague, salmonBowl]);

    expect(result).toMatchObject({ found: 2, drafted: [{ slug: 'salmon-rice-bowl' }] });
    expect(result.rejected).toEqual([
      {
        title: 'Garlic rice',
        sourceUrl: null,
        reasons: [
          'no-servings',
          'no-times',
          'no-licence',
          'no-meal',
          'line-with-unknown-unit: 2 cloves garlic',
          'line-without-amount: salt to taste',
          'line-with-a-range: 2-3 tomatoes',
          'unknown-ingredient: dragon fruit',
        ],
      },
    ]);
    expect(await t.prisma.recipeDraft.count()).toBe(1);
    expect(await rejections()).toMatchObject([
      {
        batchId: result.batchId,
        title: 'Garlic rice',
        sourceUrl: null,
        reasons: result.rejected[0]!.reasons,
      },
    ]);

    await t.http().delete('/api/admin/drafts/recipes/import/rejections').set(asAdmin).expect(204);
    expect(await rejections()).toEqual([]);
  });

  it('takes from the request what a recipe does not say of itself: where it is from, its licence, the meals it is for', async () => {
    const bare = { ...salmonBowl, url: undefined, license: undefined, recipeCategory: 'Seafood' };

    await take(bare, {
      sourceUrl: 'https://recipes.example/',
      license: 'CC BY-SA 4.0',
      mealTypes: ['lunch', 'dinner'],
    });

    expect(await t.prisma.recipeDraft.findFirstOrThrow()).toMatchObject({
      provenanceUrl: 'https://recipes.example/',
      provenanceLicense: 'CC BY-SA 4.0',
      mealTypes: ['lunch', 'dinner'],
    });
  });

  it('lets what a recipe says of itself stand over what the request says', async () => {
    await take(salmonBowl, {
      sourceUrl: 'https://elsewhere.example/',
      license: 'CC0',
      mealTypes: ['lunch'],
    });

    expect(await t.prisma.recipeDraft.findFirstOrThrow()).toMatchObject({
      provenanceUrl: 'https://recipes.example/salmon-rice-bowl',
      provenanceLicense: CC_BY,
      mealTypes: ['dinner'],
    });
  });

  it('refuses an amount in a unit its ingredient cannot be counted in', async () => {
    const result = await take({
      ...salmonBowl,
      recipeIngredient: ['150 g salmon', '1 cup broccoli'],
    });

    expect(result.drafted).toEqual([]);
    expect(result.rejected[0]!.reasons).toEqual([expect.stringMatching(/^unit-not-convertible: /)]);
  });

  it('refuses a recipe the library has already, by its title or by what it is made of, and the second of two alike in one document', async () => {
    const porridge = {
      ...salmonBowl,
      name: 'Morning oats',
      recipeIngredient: ['60 g rolled oats', '250 ml whole milk'],
      recipeCategory: 'Breakfast',
      url: 'https://recipes.example/oats',
    };
    const named = { ...salmonBowl, name: 'Milk porridge', url: 'https://recipes.example/porridge' };

    const result = await take([
      porridge,
      named,
      salmonBowl,
      { ...salmonBowl, name: 'Salmon bowl, again' },
      { ...salmonBowl, recipeIngredient: ['200 g salmon', '80 g white rice'] },
    ]);

    expect(result.drafted).toEqual([{ slug: 'salmon-rice-bowl', title: 'Salmon rice bowl' }]);
    expect(result.rejected.map((rejection) => [rejection.title, rejection.reasons])).toEqual([
      ['Morning oats', ['same-making-as: milk-porridge']],
      ['Milk porridge', ['title-taken: Milk porridge']],
      ['Salmon bowl, again', ['same-making-as: salmon-rice-bowl']],
      ['Salmon rice bowl', ['title-taken: Salmon rice bowl']],
    ]);

    // And a draft that waits is in the way of the same recipe on the next import.
    expect((await take(salmonBowl)).rejected[0]!.reasons).toEqual([
      'title-taken: Salmon rice bowl',
    ]);
  });

  it('gives a recipe a slug of its own where its title makes one that is taken', async () => {
    const result = await take({ ...salmonBowl, name: 'Milk porridge!' });

    expect(result.drafted).toEqual([{ slug: 'milk-porridge-2', title: 'Milk porridge!' }]);
  });

  it('knows an ingredient by another name once the operator has written it down', async () => {
    const withSpuds = {
      ...salmonBowl,
      recipeIngredient: ['150 g salmon', '80 g long-grain rice', '1 scallion'],
    };
    expect((await take(withSpuds, { dryRun: true })).rejected[0]!.reasons).toEqual([
      'unknown-ingredient: long-grain rice',
      'unknown-ingredient: scallion',
    ]);

    writeFileSync(
      join(catalogueDirectory(), IMPORT_ALIASES_FILE),
      JSON.stringify({ 'long-grain rice': 'white-rice', scallion: 'spring-onion' }),
    );

    // The rice is known now; the alias for an ingredient the catalogue does not have is none.
    expect((await take(withSpuds, { dryRun: true })).rejected[0]!.reasons).toEqual([
      'unknown-ingredient: scallion',
    ]);
  });

  it("reads a list of eggs as so many pieces of the catalogue's egg", async () => {
    await take({
      ...salmonBowl,
      name: 'Eggs on rice',
      recipeIngredient: ['2 large eggs, beaten', '80 g white rice'],
    });

    const draft = await t.prisma.recipeDraft.findFirstOrThrow();
    expect(draft.ingredientsJson).toEqual([
      { slug: 'large-egg', quantity: 2, unit: 'piece', note: null },
      { slug: 'white-rice', quantity: 80, unit: 'g', note: null },
    ]);
    // Two eggs of 55 g are 157 kcal, the rice 288.
    expect(draft.caloriesPerServing).toBeGreaterThan(440);
    expect(draft.caloriesPerServing).toBeLessThan(450);
  });

  it('keeps no address that is none, and keeps the licence all the same', async () => {
    const long = `https://recipes.example/${'a'.repeat(600)}`;

    await take({ ...salmonBowl, url: long });

    expect(await t.prisma.recipeDraft.findFirstOrThrow()).toMatchObject({
      provenanceUrl: null,
      provenanceLicense: CC_BY,
    });
  });

  it('holds the text to the rules of every recipe', async () => {
    const result = await take({ ...salmonBowl, name: 'Salmon <b>bowl</b>' });

    expect(result.rejected[0]!.reasons).toEqual(['invalid-draft: titles.en: markup']);
  });

  it('says of a refused recipe no more than can be read: so many reasons, so much of each, and how many are left', async () => {
    const endless = {
      ...salmonBowl,
      name: `Bowl ${'of everything '.repeat(40)}`,
      recipeIngredient: [
        ...Array.from({ length: 40 }, (_, n) => `${n + 1} g ${'unheard-of '.repeat(30)}root`),
      ],
    };

    const [rejection] = (await take(endless, { dryRun: true })).rejected;

    expect(rejection!.title).toHaveLength(200);
    expect(rejection!.reasons).toHaveLength(26);
    expect(rejection!.reasons[0]!.length).toBeLessThanOrEqual(161);
    expect(rejection!.reasons.at(-1)).toBe('more-reasons: 15');
  });

  it('looks at the first hundred recipes of a document, says how many it held, and keeps nothing of the others', async () => {
    const many = Array.from({ length: 102 }, (_, n) => ({
      '@type': 'Recipe',
      name: `Recipe ${n}`,
    }));

    const result = await take(many, { dryRun: true });

    expect(result.found).toBe(102);
    expect(result.rejected).toHaveLength(100);
    expect(result.rejected.at(-1)).toMatchObject({
      title: 'Recipe 99',
      reasons: expect.arrayContaining(['no-ingredients']),
    });

    // As many as a document can hold: what is answered and kept is of the first hundred all the same.
    const flood = await take(Array.from({ length: 4000 }, () => ({ '@type': 'Recipe' })));

    expect(flood.found).toBe(4000);
    expect(flood.rejected).toHaveLength(100);
    expect(await t.prisma.recipeImportRejection.count()).toBe(100);
  });

  it('finds nothing in a document that holds no recipe', async () => {
    expect(await take({ '@type': 'Article', name: 'On salmon' })).toMatchObject({
      batchId: expect.stringMatching(/^imp-/),
      found: 0,
      drafted: [],
      rejected: [],
    });
  });

  it('reads the text itself: no document in what is no JSON, or is JSON that can hold no recipe', async () => {
    for (const text of ['a recipe', '{ name: Salmon }', '"a recipe"', '12', 'null', 'true']) {
      await expect(take(text), text).rejects.toMatchObject({
        response: { error: 'IMPORT_NOT_JSON' },
      });
    }

    expect(await t.prisma.recipeDraft.count()).toBe(0);
    expect(await rejections()).toEqual([]);
  });

  it('takes a text no longer than a request may be, and follows lists within lists only so far', async () => {
    expect(RecipeImportRequest.safeParse({ document: 'x'.repeat(90_001) }).success).toBe(false);
    expect(RecipeImportRequest.safeParse({ document: '' }).success).toBe(false);
    // The document is its text: the object itself is no request.
    expect(RecipeImportRequest.safeParse({ document: salmonBowl }).success).toBe(false);

    const bowl = JSON.stringify(salmonBowl);
    expect(await take(`[[[${bowl}]]]`, { dryRun: true })).toMatchObject({ found: 1 });
    expect(
      await take(`${'['.repeat(40_000)}${bowl}${']'.repeat(40_000)}`, { dryRun: true }),
    ).toMatchObject({ found: 0, drafted: [], rejected: [] });
  });

  it("is the administrator's alone, and wants a document", async () => {
    await t
      .http()
      .post('/api/admin/drafts/recipes/import')
      .send({ document: textOf(salmonBowl) })
      .expect(401);
    await t.http().get('/api/admin/drafts/recipes/import/rejections').expect(401);
    await t.http().delete('/api/admin/drafts/recipes/import/rejections').expect(401);
    await send({}).expect(400);
    expect((await send({ document: 'a recipe' }).expect(400)).body).toMatchObject({
      error: 'IMPORT_NOT_JSON',
    });
    await send({ document: salmonBowl, license: '' }).expect(400);
    await send({ document: salmonBowl, sourceUrl: 'recipes.example' }).expect(400);
    // An address is shown as a link: nothing but the web's own.
    await send({ document: salmonBowl, sourceUrl: 'javascript:alert(1)' }).expect(400);
    await send({ document: salmonBowl, mealTypes: ['brunch'] }).expect(400);
  });

  describe('once a person approved it', () => {
    const approvedAndShipped = async (mode: 'local' | 'bundle') => {
      await take(salmonBowl);
      const draft = await t.prisma.recipeDraft.findFirstOrThrow();
      await t
        .http()
        .post(`/api/admin/drafts/recipes/${draft.id}/approve?locale=en`)
        .set(asAdmin)
        .send({ reviewedByLabel: 'the administrator' })
        .expect(201);
      return (
        await t
          .http()
          .post('/api/admin/drafts/ship')
          .set(asAdmin)
          .send({ kind: 'recipe', mode })
          .expect(201)
      ).body;
    };

    it('ships into the instance with where it is from, which whoever reads the recipe is told', async () => {
      const shipped = await approvedAndShipped('local');
      expect(shipped.skipped).toEqual([]);

      const recipe = await t.prisma.recipe.findUniqueOrThrow({
        where: { slug: 'salmon-rice-bowl' },
      });
      expect(recipe).toMatchObject({
        origin: 'curated',
        sourceUrl: 'https://recipes.example/salmon-rice-bowl',
        sourceLicense: CC_BY,
      });
      const reader = await aUser(t);
      const read = (await t.http().get(`/api/recipes/${recipe.id}`).set(as(reader)).expect(200))
        .body;
      expect(read.source).toEqual({
        url: 'https://recipes.example/salmon-rice-bowl',
        license: CC_BY,
      });
      // A recipe written here is from nowhere else.
      const own = await t.prisma.recipe.findFirstOrThrow({ where: { origin: 'seed' } });
      expect(
        (await t.http().get(`/api/recipes/${own.id}`).set(as(reader)).expect(200)).body.source,
      ).toBeNull();
    });

    it('goes into a file for a repository with where it is from', async () => {
      const bundle = await approvedAndShipped('bundle');

      const rows = bundle.content as { slug: string; source?: unknown }[];
      expect(rows.find((row) => row.slug === 'salmon-rice-bowl')!.source).toEqual({
        url: 'https://recipes.example/salmon-rice-bowl',
        license: CC_BY,
      });
    });
  });
});
