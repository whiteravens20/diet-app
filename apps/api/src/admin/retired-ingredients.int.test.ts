// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase } from '../testing/database.js';
import { aProfile, aRecipeDraft, asAdmin, aUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

describe('the retired ingredients the instance still uses, in the panel', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  beforeEach(async () => {
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
  });

  afterAll(async () => {
    await t.close();
  });

  const ingredient = (slug: string) => t.prisma.ingredient.findUniqueOrThrow({ where: { slug } });

  /** A food the data no longer carries, as a catalogue update leaves one something still uses. */
  const aRetiredFood = (overrides: { slug?: string; canonicalUnit?: 'g' | 'ml' } = {}) =>
    t.prisma.ingredient.create({
      data: {
        slug: overrides.slug ?? 'fish-salmon-sockeye-raw',
        name: overrides.slug ?? 'Fish, salmon, sockeye, raw',
        category: 'fish',
        canonicalUnit: overrides.canonicalUnit ?? 'g',
        caloriesPer100: 131,
        proteinPer100: 22,
        fatPer100: 4.7,
        carbsPer100: 0,
        allergens: ['fish'],
        tags: ['usda-imported'],
        retiredAt: new Date('2026-10-16T10:37:06Z'),
      },
    });

  /** A recipe of the library, with one line. */
  const aLibraryRecipe = (title: string, line: { ingredientId: string; quantity: number }) =>
    t.prisma.recipe.create({
      data: {
        title,
        description: 'Of the library.',
        servings: 1,
        mealTypes: ['dinner'],
        dietTags: [],
        steps: ['Bake the salmon.'],
        prepMinutes: 5,
        cookMinutes: 15,
        allergens: ['fish'],
        origin: 'curated',
        caloriesPerServing: 0,
        proteinPerServing: 0,
        fatPerServing: 0,
        carbsPerServing: 0,
        ingredients: { create: [{ ...line, unit: 'g' }] },
      },
    });

  it('are the administrator’s: closed to a caller without the panel’s session', async () => {
    const food = await aRetiredFood();
    const salmon = await ingredient('salmon');

    await t.http().get('/api/admin/ingredients/retired').expect(401);
    await t.http().get('/api/admin/ingredients?search=salm').expect(401);
    await t
      .http()
      .post(`/api/admin/ingredients/${food.id}/replace`)
      .send({ by: salmon.id })
      .expect(401);
  });

  it('are listed with what uses them, the recipes of the library and the drafts by their titles', async () => {
    const food = await aRetiredFood();
    await aLibraryRecipe('Sockeye on rice', { ingredientId: food.id, quantity: 150 });
    await aRecipeDraft(t, { titles: { en: 'Sockeye bowl', pl: 'Miska z nerką' } }, [
      { slug: food.slug!, quantity: 120, unit: 'g', note: null },
    ]);
    const profile = await aProfile(t, await aUser(t));
    await t.prisma.inventoryItem.create({
      data: { profileId: profile.id, ingredientId: food.id, quantity: 200, unit: 'g' },
    });

    const res = await t.http().get('/api/admin/ingredients/retired').set(asAdmin).expect(200);

    expect(res.body).toEqual([
      {
        id: food.id,
        slug: 'fish-salmon-sockeye-raw',
        name: 'Fish, salmon, sockeye, raw',
        retiredAt: '2026-10-16T10:37:06.000Z',
        uses: {
          libraryRecipes: 1,
          ownRecipes: 0,
          drafts: 1,
          pantryRows: 1,
          profiles: 0,
          shoppingRows: 0,
        },
        usedIn: ['Sockeye on rice', 'Sockeye bowl'],
      },
    ]);
  });

  it('are replaced by an ingredient of the catalogue: what used one moves over, its figures are worked out again, and it goes', async () => {
    const food = await aRetiredFood();
    const salmon = await ingredient('salmon');
    const recipe = await aLibraryRecipe('Sockeye on rice', {
      ingredientId: food.id,
      quantity: 150,
    });
    const draft = await aRecipeDraft(t, {}, [
      { slug: food.slug!, quantity: 120, unit: 'g', note: null },
    ]);

    const res = await t
      .http()
      .post(`/api/admin/ingredients/${food.id}/replace`)
      .set(asAdmin)
      .send({ by: salmon.id })
      .expect(200);

    expect(res.body).toMatchObject({
      recipeLines: 1,
      draftLines: 1,
      pantryRows: 0,
      preferences: 0,
      shoppingRows: 0,
      deleted: true,
    });
    expect(await t.prisma.ingredient.findUnique({ where: { id: food.id } })).toBeNull();
    const after = await t.prisma.recipe.findUniqueOrThrow({
      where: { id: recipe.id },
      include: { ingredients: true },
    });
    expect(after.ingredients.map((line) => [line.ingredientId, line.quantity])).toEqual([
      [salmon.id, 150],
    ]);
    expect(after.caloriesPerServing).toBeCloseTo((150 * salmon.caloriesPer100) / 100, 0);
    expect(
      (await t.prisma.recipeDraft.findUniqueOrThrow({ where: { id: draft.id } })).ingredientsJson,
    ).toEqual([{ slug: 'salmon', quantity: 120, unit: 'g', note: null }]);
    await t.http().get('/api/admin/ingredients/retired').set(asAdmin).expect(200).expect([]);
  });

  it('keep each amount when replaced: one in a unit the new ingredient has no weight for is put in grams', async () => {
    // Fillets counted in pieces, where the curated salmon is weighed only in grams.
    const fillets = await t.prisma.ingredient.create({
      data: {
        slug: 'fish-salmon-fillet-frozen',
        name: 'Fish, salmon, fillet, frozen',
        category: 'fish',
        canonicalUnit: 'g',
        gramsPerPiece: 125,
        caloriesPer100: 180,
        proteinPer100: 20,
        fatPer100: 11,
        carbsPer100: 0,
        retiredAt: new Date('2026-10-16T10:37:06Z'),
      },
    });
    const profile = await aProfile(t, await aUser(t));
    await t.prisma.inventoryItem.create({
      data: { profileId: profile.id, ingredientId: fillets.id, quantity: 2, unit: 'piece' },
    });
    const salmon = await ingredient('salmon');

    await t
      .http()
      .post(`/api/admin/ingredients/${fillets.id}/replace`)
      .set(asAdmin)
      .send({ by: salmon.id })
      .expect(200);

    expect(
      await t.prisma.inventoryItem.findMany({
        where: { profileId: profile.id },
        select: { ingredientId: true, quantity: true, unit: true },
      }),
    ).toEqual([{ ingredientId: salmon.id, quantity: 250, unit: 'g' }]);
  });

  it('are not replaced by what is not another ingredient of the catalogue, nor where an amount cannot be held for it', async () => {
    const food = await aRetiredFood();
    const salmon = await ingredient('salmon');
    const replace = (id: string, by: string) =>
      t.http().post(`/api/admin/ingredients/${id}/replace`).set(asAdmin).send({ by });

    const notRetired = await replace(salmon.id, food.id);
    expect([notRetired.status, notRetired.body.error]).toEqual([409, 'INGREDIENT_NOT_RETIRED']);
    const itself = await replace(food.id, food.id);
    expect([itself.status, itself.body.error]).toEqual([422, 'REPLACEMENT_NOT_IN_CATALOGUE']);
    const another = await aRetiredFood({ slug: 'fish-salmon-coho-raw' });
    const retiredOne = await replace(food.id, another.id);
    expect([retiredOne.status, retiredOne.body.error]).toEqual([
      422,
      'REPLACEMENT_NOT_IN_CATALOGUE',
    ]);

    // Millilitres of a drink with no density, and a yogurt weighed in grams with none either.
    const drink = await aRetiredFood({ slug: 'yogurt-drinkable', canonicalUnit: 'ml' });
    await t.prisma.recipe.create({
      data: {
        title: 'A glass of it',
        description: 'Of the library.',
        servings: 1,
        mealTypes: ['snack'],
        dietTags: [],
        steps: ['Pour it.'],
        prepMinutes: 1,
        cookMinutes: 0,
        allergens: [],
        origin: 'curated',
        caloriesPerServing: 0,
        proteinPerServing: 0,
        fatPerServing: 0,
        carbsPerServing: 0,
        ingredients: { create: [{ ingredientId: drink.id, quantity: 200, unit: 'ml' }] },
      },
    });
    const units = await replace(drink.id, (await ingredient('greek-yogurt')).id);
    expect([units.status, units.body.error, units.body.details]).toEqual([
      409,
      'UNITS_STAND_IN_THE_WAY',
      { units: ['ml'] },
    ]);
    expect((await t.prisma.ingredient.findUniqueOrThrow({ where: { id: drink.id } })).id).toBe(
      drink.id,
    );
  });

  it('can be replaced by any ingredient of the catalogue the panel finds by name, and by none that is retired', async () => {
    await aRetiredFood({ slug: 'fish-salmon-pink-raw' });

    const res = await t.http().get('/api/admin/ingredients?search=salmon').set(asAdmin).expect(200);

    expect((res.body as { id: string }[]).map((found) => found.id)).toEqual([
      (await ingredient('salmon')).id,
    ]);
  });

  it('keep a recipe a user made from going into the library, and the page of drafts says so', async () => {
    const food = await aRetiredFood();
    const draft = await aRecipeDraft(t, { source: 'AI_USER', status: 'APPROVED' }, [
      { slug: food.slug!, quantity: 150, unit: 'g', note: null },
      { slug: 'white-rice', quantity: 80, unit: 'g', note: null },
    ]);
    const blockOf = async () =>
      (
        (await t.http().get('/api/admin/drafts/recipes').set(asAdmin).expect(200)).body as {
          items: { id: string; libraryBlock?: string | null }[];
        }
      ).items.find((item) => item.id === draft.id)?.libraryBlock;

    expect(await blockOf()).toBe('unknown-slug-at-ship: fish-salmon-sockeye-raw');

    await t
      .http()
      .post(`/api/admin/ingredients/${food.id}/replace`)
      .set(asAdmin)
      .send({ by: (await ingredient('salmon')).id })
      .expect(200);

    expect(await blockOf()).toBeNull();
  });
});
