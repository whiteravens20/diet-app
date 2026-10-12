// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../../../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../../../testing/database.js';
import { aRecipeDraft, anIngredientNameDraft, asAdmin } from '../../../testing/factories.js';
import { createTestApp, type TestApp } from '../../../testing/test-app.js';

describe('restoring what an instance added to its catalogue', () => {
  let t: TestApp;
  let dir: string;

  beforeAll(async () => {
    t = await createTestApp();
    dir = process.env.INSTANCE_DATA_DIR!;
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
  });

  afterAll(async () => {
    await t.close();
  });

  /** What only this instance added: as on a new server, the database has none of it. */
  const forget = async () => {
    await t.prisma.recipe.deleteMany({ where: { origin: 'curated' } });
    await t.prisma.ingredientTranslation.deleteMany({ where: { source: 'MANUAL' } });
  };

  beforeEach(async () => {
    await resetUserData(t.prisma);
    await forget();
    rmSync(join(dir, 'recipes'), { recursive: true, force: true });
    rmSync(join(dir, 'ingredient-overrides.json'), { force: true });
  });

  const ship = (kind: 'recipe' | 'ingredient-name') => t.http().post('/api/admin/drafts/ship').set(asAdmin).send({ kind, mode: 'local' }).expect(201);
  const restore = () => t.http().post('/api/admin/drafts/ship/restore').set(asAdmin).expect(200);
  const curated = () => t.prisma.recipe.findMany({ where: { origin: 'curated' }, include: { translations: true, ingredients: true }, orderBy: { slug: 'asc' } });
  /** A row as a ship writes one, made of ingredients no recipe of the test catalogue combines. */
  const aRow = (over: Record<string, unknown> = {}) => ({
    slug: 'tomato-rice',
    title: { en: 'Tomato rice', pl: 'Ryż z pomidorami' },
    description: { en: 'Rice with tomatoes.', pl: 'Ryż z pomidorami.' },
    servings: 2,
    mealTypes: ['lunch'],
    prepMinutes: 5,
    cookMinutes: 20,
    difficulty: 'easy',
    ingredients: [
      { slug: 'white-rice', quantity: 150, unit: 'g', note: null },
      { slug: 'tomato', quantity: 300, unit: 'g', note: 'ripe' },
    ],
    steps: { en: ['Cook the rice.', 'Stir in the tomatoes.'], pl: ['Ugotuj ryż.', 'Dodaj pomidory.'] },
    ...over,
  });
  const aBatch = (name: string, rows: unknown) => {
    mkdirSync(join(dir, 'recipes'), { recursive: true });
    writeFileSync(join(dir, 'recipes', name), typeof rows === 'string' ? rows : JSON.stringify(rows));
  };

  it('brings back into a database that has none of it what local ships wrote', async () => {
    const draft = await aRecipeDraft(t, { status: 'APPROVED' });
    await anIngredientNameDraft(t, { status: 'APPROVED', suggestions: { name: { pl: 'Filet z kurczaka' } } });
    await ship('recipe');
    await ship('ingredient-name');
    const [shipped] = await curated();
    await forget();

    const res = await restore();

    expect(res.body).toEqual({ recipes: { added: 1, rewritten: 0, skipped: [] }, names: { applied: 1, skippedSlugs: [], refused: [] }, unreadable: [] });
    const [restored] = await curated();
    expect(restored).toMatchObject({
      slug: draft.slug,
      title: 'Oat bowl',
      origin: 'curated',
      fingerprint: shipped!.fingerprint,
      caloriesPerServing: shipped!.caloriesPerServing,
      allergens: shipped!.allergens,
    });
    expect(restored!.ingredients).toHaveLength(3);
    expect(restored!.translations.map((row) => [row.locale, row.title, row.source]).sort()).toEqual([
      ['en', 'Oat bowl', 'MANUAL'],
      ['pl', 'Owsianka', 'MANUAL'],
    ]);
    expect(await t.prisma.ingredientTranslation.findMany({ where: { source: 'MANUAL' }, select: { locale: true, name: true } })).toEqual([{ locale: 'pl', name: 'Filet z kurczaka' }]);
  });

  it('brings back where a recipe is from: the address when it is one of the web, and the licence either way', async () => {
    aBatch('ship-1.json', [
      aRow({ source: { url: 'https://recipes.example/tomato-rice', license: 'CC BY 4.0' } }),
      aRow({ slug: 'tomato-rice-again', title: { en: 'Tomato rice, again' }, description: { en: 'Rice with more tomatoes.' }, steps: { en: ['Cook it.'] }, servings: 3, source: { url: 'javascript:alert(1)', license: 'CC0' } }),
    ]);

    await restore();

    expect((await curated()).map((recipe) => [recipe.slug, recipe.sourceUrl, recipe.sourceLicense])).toEqual([
      ['tomato-rice', 'https://recipes.example/tomato-rice', 'CC BY 4.0'],
      ['tomato-rice-again', null, 'CC0'],
    ]);
  });

  it('can be run again: a recipe the library has is written over from its file and keeps its id', async () => {
    await aRecipeDraft(t, { status: 'APPROVED' });
    const shipping = await ship('recipe');
    const [before] = await curated();
    // The operator corrects the file by hand.
    const path: string = shipping.body.sidecarPaths[0];
    const rows = JSON.parse(readFileSync(path, 'utf8'));
    rows[0].title.en = 'Oat bowl with banana';
    writeFileSync(path, JSON.stringify(rows));

    const res = await restore();

    expect(res.body.recipes).toEqual({ added: 0, rewritten: 1, skipped: [] });
    const [after] = await curated();
    expect(after).toMatchObject({ id: before!.id, title: 'Oat bowl with banana' });
    expect(after!.ingredients).toHaveLength(3);
    expect((await restore()).body.recipes).toEqual({ added: 0, rewritten: 1, skipped: [] });
    expect(await curated()).toHaveLength(1);
  });

  it('leaves out a recipe that breaks a rule or would take the place of one of the catalogue, and says which file it is in', async () => {
    aBatch('ship-2026-01-01.json', [
      aRow(),
      aRow({ slug: 'marked-rice', title: { en: 'Rice <script>alert(1)</script>', pl: 'Ryż' } }),
      aRow({ slug: 'milk-porridge', title: { en: 'Porridge of my own', pl: 'Moja owsianka' }, servings: 3 }),
      aRow({ slug: 'unknown-rice', title: { en: 'Rice with nothing', pl: 'Ryż z niczym' }, ingredients: [{ slug: 'no-such-ingredient', quantity: 10, unit: 'g', note: null }] }),
      'not a recipe',
    ]);
    const seeded = await t.prisma.recipe.findUniqueOrThrow({ where: { slug: 'milk-porridge' } });

    const res = await restore();

    expect(res.body.recipes).toEqual({
      added: 1,
      rewritten: 0,
      skipped: [
        { file: 'recipes/ship-2026-01-01.json', slug: 'marked-rice', reason: 'invalid-draft: titles.en: markup' },
        { file: 'recipes/ship-2026-01-01.json', slug: 'milk-porridge', reason: 'slug-taken: milk-porridge' },
        { file: 'recipes/ship-2026-01-01.json', slug: 'unknown-rice', reason: 'unknown-slug-at-ship: no-such-ingredient' },
        { file: 'recipes/ship-2026-01-01.json', slug: '[4]', reason: expect.stringMatching(/^invalid-draft: /) },
      ],
    });
    expect((await curated()).map((recipe) => recipe.slug)).toEqual(['tomato-rice']);
    expect(await t.prisma.recipe.findUniqueOrThrow({ where: { slug: 'milk-porridge' } })).toEqual(seeded);
  });

  it('takes the later of two files that hold the same slug', async () => {
    aBatch('ship-2026-01-01.json', [aRow({ servings: 2 })]);
    aBatch('ship-2026-02-01.json', [aRow({ servings: 4 })]);

    const res = await restore();

    expect(res.body.recipes).toEqual({ added: 1, rewritten: 1, skipped: [] });
    expect((await curated())[0]).toMatchObject({ slug: 'tomato-rice', servings: 4 });
  });

  it('reports a file it cannot read, and restores the rest', async () => {
    aBatch('ship-2026-01-01.json', '{ not json');
    aBatch('ship-2026-02-01.json', { slug: 'a-single-recipe' });
    aBatch('ship-2026-03-01.json', [aRow()]);
    writeFileSync(join(dir, 'ingredient-overrides.json'), JSON.stringify(['not', 'names']));

    const res = await restore();

    expect(res.body.unreadable).toEqual([
      { file: 'recipes/ship-2026-01-01.json', reason: 'not-json' },
      { file: 'recipes/ship-2026-02-01.json', reason: 'not-a-batch' },
      { file: 'ingredient-overrides.json', reason: 'not-an-override-file' },
    ]);
    expect(res.body.recipes.added).toBe(1);
  });

  it('holds the names of the file to the rules for names', async () => {
    writeFileSync(join(dir, 'ingredient-overrides.json'), JSON.stringify({ tomato: { name: { pl: 'Pomidor malinowy' } }, salmon: { name: { pl: '<b>Łosoś</b>' } }, 'no-such-ingredient': { name: { pl: 'Nic' } } }));

    const res = await restore();

    expect(res.body.names).toEqual({ applied: 1, skippedSlugs: ['no-such-ingredient'], refused: [{ slug: 'salmon', reason: 'invalid-draft: name.pl: markup' }] });
    expect(await t.prisma.ingredientTranslation.findMany({ where: { source: 'MANUAL' }, select: { name: true } })).toEqual([{ name: 'Pomidor malinowy' }]);
  });

  it('does nothing where there is nothing to restore', async () => {
    expect((await restore()).body).toEqual({ recipes: { added: 0, rewritten: 0, skipped: [] }, names: { applied: 0, skippedSlugs: [], refused: [] }, unreadable: [] });
  });

  it('tells the panel what the directory holds and whether a ship can still write there', async () => {
    const config = () => t.http().get('/api/admin/drafts/ship/config').set(asAdmin).expect(200);
    expect((await config()).body.instanceData).toEqual({ writable: true, recipeFiles: 0, recipes: 0, names: 0 });

    aBatch('ship-2026-01-01.json', [aRow(), aRow({ slug: 'another-rice' })]);
    writeFileSync(join(dir, 'ingredient-overrides.json'), JSON.stringify({ tomato: { name: { pl: 'Pomidor' } } }));

    expect((await config()).body.instanceData).toEqual({ writable: true, recipeFiles: 1, recipes: 2, names: 1 });
  });
});
