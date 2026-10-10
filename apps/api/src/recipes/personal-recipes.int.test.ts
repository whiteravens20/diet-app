// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { AiDraftRecipeRequest, type MealPlan, type Profile } from '@diet-app/shared';
import { HttpException } from '@nestjs/common';
import { recipeFacts } from '../engine/recipe-facts.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MealPlansService } from '../meal-plans/meal-plans.service.js';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase, resetUserData } from '../testing/database.js';
import { aPlan, aProfile, aUser, as, race, type TestUser } from '../testing/factories.js';
import type { ModelRequest } from '../testing/fake-model.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { AiRecipeDraftService } from './ai-recipe-draft.service.js';
import { MAX_PERSONAL_RECIPES, PersonalRecipesService } from './personal-recipes.service.js';

let t: TestApp;
let plans: MealPlansService;
let drafts: AiRecipeDraftService;
let personal: PersonalRecipesService;

beforeAll(async () => {
  t = await createTestApp();
  await resetDatabase(t.prisma);
  await seedCatalogue(t.prisma);
  plans = t.app.get(MealPlansService);
  drafts = t.app.get(AiRecipeDraftService);
  personal = t.app.get(PersonalRecipesService);
});

afterAll(async () => {
  await t.close();
});

interface Account {
  user: TestUser;
  profile: Profile;
  plan: MealPlan;
}

async function anAccount(): Promise<Account> {
  const user = await aUser(t);
  await t.prisma.user.update({ where: { id: user.id }, data: { aiMode: 'admin' } });
  const profile = await aProfile(t, user);
  return { user, profile, plan: await aPlan(t, user, profile) };
}

const ingredientId = async (slug: string): Promise<string> => (await t.prisma.ingredient.findUniqueOrThrow({ where: { slug } })).id;

/** Put the tofu rice bowl into the first lunch of an account's plan and swap its tofu for chicken. */
async function tofuForChicken(account: Account): Promise<string> {
  const meal = account.plan.days[0]!.meals.find((m) => m.mealType === 'lunch')!;
  const bowl = await t.prisma.recipe.findUniqueOrThrow({ where: { slug: 'tofu-rice-bowl' } });
  await t.prisma.plannedMeal.update({ where: { id: meal.id }, data: { recipeId: bowl.id } });
  await plans.applyIngredientSwap(account.user.id, 'en', {
    planId: account.plan.id,
    plannedMealId: meal.id,
    fromIngredientId: await ingredientId('firm-tofu'),
    toIngredientId: await ingredientId('chicken-breast'),
  });
  return (await t.prisma.plannedMeal.findUniqueOrThrow({ where: { id: meal.id } })).recipeId!;
}

/** A draft a model writes the same way every time it is asked. */
const sameDraft = (request: ModelRequest): string => {
  const offered = [...request.prompt.matchAll(/^- ([a-z0-9-]+): /gm)].map((match) => match[1]!);
  return JSON.stringify({
    title: 'The usual bowl',
    description: 'What this model always writes.',
    servings: 1,
    mealTypes: ['lunch'],
    prepMinutes: 5,
    cookMinutes: 10,
    difficulty: 'easy',
    ingredients: offered.slice(0, 3).map((slug) => ({ slug, quantity: 100, unit: 'g', note: null })),
    steps: ['Prepare.', 'Cook and serve.'],
  });
};

const draftFor = (account: Account) =>
  drafts.draftFromPrompt(account.user.id, 'en', AiDraftRecipeRequest.parse({ profileId: account.profile.id }));

beforeEach(async () => {
  await resetUserData(t.prisma);
  t.model.reset();
});

describe('two users who make the same recipe', () => {
  it('each get a recipe of their own from the same ingredient swap', async () => {
    const [first, second] = [await anAccount(), await anAccount()];

    const firstVariant = await tofuForChicken(first);
    const secondVariant = await tofuForChicken(second);

    expect(secondVariant).not.toBe(firstVariant);
    const rows = await t.prisma.recipe.findMany({ where: { id: { in: [firstVariant, secondVariant] } } });
    expect(rows.map((row) => row.createdByUserId).sort()).toEqual([first.user.id, second.user.id].sort());
    expect(rows[0]!.fingerprint).toBe(rows[1]!.fingerprint);
    expect(rows[0]!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('each get a recipe of their own when a model writes them the same draft', async () => {
    t.model.reply({ text: sameDraft, times: 10 });
    const [first, second] = [await anAccount(), await anAccount()];

    const one = await draftFor(first);
    const two = await draftFor(second);

    expect(two.recipe.id).not.toBe(one.recipe.id);
    expect(two.recipe.title).toBe('The usual bowl');
    // Neither can open the other's.
    await t.http().get(`/api/recipes/${one.recipe.id}`).set(as(second.user)).expect(404);
    await t.http().get(`/api/recipes/${two.recipe.id}`).set(as(first.user)).expect(404);
  });

  it('put the recipe before the curators once, as one draft that stands for both', async () => {
    const [first, second] = [await anAccount(), await anAccount()];

    const firstVariant = await tofuForChicken(first);
    // One user alone is nobody's business but theirs.
    expect(await t.prisma.recipeDraft.count()).toBe(0);
    const secondVariant = await tofuForChicken(second);

    const queue = await t.prisma.recipeDraft.findMany();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ source: 'AI_USER', status: 'PENDING', batchId: 'personal-recipes' });
    expect([...queue[0]!.sourceRecipeIds].sort()).toEqual([firstVariant, secondVariant].sort());
    // Nothing in what a reviewer sees says who made it or when.
    const shown = JSON.stringify(queue[0]);
    for (const account of [first, second]) expect(shown).not.toContain(account.user.id.slice(0, 8));
  });

  it('are not two owners when the first has deleted theirs', async () => {
    const [first, second] = [await anAccount(), await anAccount()];
    const firstVariant = await tofuForChicken(first);
    await t.http().delete(`/api/recipes/${firstVariant}`).set(as(first.user)).expect(204);

    await tofuForChicken(second);

    expect(await t.prisma.recipeDraft.count()).toBe(0);
  });
});

describe('one user who makes the same recipe again', () => {
  it('is given the recipe they already have', async () => {
    const account = await anAccount();
    const variant = await tofuForChicken(account);

    expect(await tofuForChicken(account)).toBe(variant);
    expect(await t.prisma.recipe.count({ where: { createdByUserId: account.user.id } })).toBe(1);
  });

  it('gets it back after having deleted it', async () => {
    const account = await anAccount();
    const variant = await tofuForChicken(account);
    await t.http().delete(`/api/recipes/${variant}`).set(as(account.user)).expect(204);
    await t.http().get(`/api/recipes/${variant}`).set(as(account.user)).expect(404);

    expect(await tofuForChicken(account)).toBe(variant);

    await t.http().get(`/api/recipes/${variant}`).set(as(account.user)).expect(200);
    expect(await t.prisma.recipe.count({ where: { createdByUserId: account.user.id } })).toBe(1);
  });

  it('is given the same recipe when a model writes the same draft twice', async () => {
    t.model.reply({ text: sameDraft, times: 10 });
    const account = await anAccount();

    const one = await draftFor(account);
    const two = await draftFor(account);

    expect(two.recipe.id).toBe(one.recipe.id);
    expect(await t.prisma.recipe.count({ where: { createdByUserId: account.user.id } })).toBe(1);
  });

  it('gets one recipe from the same swap made twice at the same moment', async () => {
    const account = await anAccount();
    const second = account.plan.days[1]!.meals.find((m) => m.mealType === 'lunch')!;
    const bowl = await t.prisma.recipe.findUniqueOrThrow({ where: { slug: 'tofu-rice-bowl' } });
    const first = account.plan.days[0]!.meals.find((m) => m.mealType === 'lunch')!;
    await t.prisma.plannedMeal.updateMany({ where: { id: { in: [first.id, second.id] } }, data: { recipeId: bowl.id } });
    const swap = async (plannedMealId: string) =>
      plans.applyIngredientSwap(account.user.id, 'en', {
        planId: account.plan.id,
        plannedMealId,
        fromIngredientId: await ingredientId('firm-tofu'),
        toIngredientId: await ingredientId('chicken-breast'),
      });

    const results = await race(2, (index) => swap(index === 0 ? first.id : second.id));

    // One of the two may lose the plan to the other and be asked to retry; neither fails otherwise.
    for (const result of results) {
      if (result.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(HttpException);
        expect((result.reason as HttpException).getStatus()).toBe(409);
      }
    }
    expect(await t.prisma.recipe.count({ where: { createdByUserId: account.user.id } })).toBe(1);
  });
});

describe('a recipe the shared library already has', () => {
  let shared: string | null = null;

  // The recipe this test makes shared is no user's any more, so clearing the
  // users' data leaves it behind for every later test to trip over.
  afterEach(async () => {
    await resetUserData(t.prisma);
    if (shared) await t.prisma.recipe.delete({ where: { id: shared } });
    shared = null;
  });

  it('is used as it is: nothing is written for the user', async () => {
    const account = await anAccount();
    shared = await tofuForChicken(account);
    await t.prisma.recipe.update({ where: { id: shared }, data: { createdByUserId: null, origin: 'curated' } });
    const other = await anAccount();

    expect(await tofuForChicken(other)).toBe(shared);

    expect(await t.prisma.recipe.count({ where: { createdByUserId: other.user.id } })).toBe(0);
    expect(await t.prisma.recipeDraft.count()).toBe(0);
  });

  it('is not handed to a profile that marked it to be avoided: the user gets a recipe of their own', async () => {
    const account = await anAccount();
    shared = await tofuForChicken(account);
    await t.prisma.recipe.update({ where: { id: shared }, data: { createdByUserId: null, origin: 'curated' } });
    const other = await anAccount();
    await t.prisma.favorite.create({ data: { profileId: other.profile.id, recipeId: shared, sentiment: 'avoid' } });

    const own = await tofuForChicken(other);

    expect(own).not.toBe(shared);
    expect((await t.prisma.recipe.findUniqueOrThrow({ where: { id: own } })).createdByUserId).toBe(other.user.id);
  });

  it('is a recipe of the catalogue just as well: one made by hand that equals it is not written', async () => {
    const account = await anAccount();
    const porridge = await t.prisma.recipe.findUniqueOrThrow({
      where: { slug: 'milk-porridge' },
      include: { ingredients: { include: { ingredient: true } } },
    });

    const id = await personal.save({
      userId: account.user.id,
      origin: 'user',
      text: new Map([['en', { title: 'My porridge', description: 'The same thing.', steps: ['Cook.', 'Eat.'] }]]),
      servings: porridge.servings,
      mealTypes: porridge.mealTypes,
      prepMinutes: 5,
      cookMinutes: 5,
      difficulty: 'easy',
      // The same lines, in another order.
      ingredients: [...porridge.ingredients]
        .reverse()
        .map((line) => ({ ingredientId: line.ingredientId, quantity: line.quantity, unit: line.unit, note: null })),
      facts: recipeFacts(porridge.ingredients, porridge.servings),
    });

    expect(id).toBe(porridge.id);
    expect(await t.prisma.recipe.count({ where: { createdByUserId: account.user.id } })).toBe(0);
  });
});

describe('the number of recipes an account may hold', () => {
  it('is capped, and the cap counts only recipes that are not deleted', async () => {
    const account = await anAccount();
    const filler = (index: number, deleted: boolean) => ({
      title: `Filler ${index}`,
      description: '',
      servings: 1,
      prepMinutes: 1,
      cookMinutes: 1,
      origin: 'user' as const,
      createdByUserId: account.user.id,
      deletedAt: deleted ? new Date() : null,
    });
    await t.prisma.recipe.createMany({
      data: [
        ...Array.from({ length: MAX_PERSONAL_RECIPES - 1 }, (_, index) => filler(index, false)),
        ...Array.from({ length: 5 }, (_, index) => filler(1000 + index, true)),
      ],
    });

    // One place is left.
    await tofuForChicken(account);

    // Another swap, of another ingredient, finds the account full.
    const meal = account.plan.days[1]!.meals.find((m) => m.mealType === 'lunch')!;
    const bowl = await t.prisma.recipe.findUniqueOrThrow({ where: { slug: 'tofu-rice-bowl' } });
    await t.prisma.plannedMeal.update({ where: { id: meal.id }, data: { recipeId: bowl.id } });
    const full = plans.applyIngredientSwap(account.user.id, 'en', {
      planId: account.plan.id,
      plannedMealId: meal.id,
      fromIngredientId: await ingredientId('firm-tofu'),
      toIngredientId: await ingredientId('chickpeas'),
    });
    await expect(full).rejects.toMatchObject({ status: 403, response: { error: 'PERSONAL_RECIPE_LIMIT' } });
    expect((await t.prisma.plannedMeal.findUniqueOrThrow({ where: { id: meal.id } })).recipeId).toBe(bowl.id);
  });
});

describe("submitting a recipe of one's own", () => {
  it('puts it before the curators, once', async () => {
    const account = await anAccount();
    const variant = await tofuForChicken(account);

    await personal.submit(account.user.id, variant);
    await personal.submit(account.user.id, variant);

    const queue = await t.prisma.recipeDraft.findMany();
    expect(queue).toHaveLength(1);
    expect(queue[0]!.sourceRecipeIds).toEqual([variant]);
    expect((queue[0]!.titles as Record<string, string>).en).toBeTruthy();
  });

  it("is refused for another user's recipe as if it did not exist", async () => {
    const [owner, other] = [await anAccount(), await anAccount()];
    const variant = await tofuForChicken(owner);

    await expect(personal.submit(other.user.id, variant)).rejects.toMatchObject({ status: 404 });
    expect(await t.prisma.recipeDraft.count()).toBe(0);
  });

  it('is a request of its own, which may be repeated', async () => {
    const [owner, other] = [await anAccount(), await anAccount()];
    const variant = await tofuForChicken(owner);
    const path = `/api/recipes/${variant}/submit`;

    await t.http().post(path).set(as(owner.user)).expect(204);
    await t.http().post(path).set(as(owner.user)).expect(204);
    expect(await t.prisma.recipeDraft.count()).toBe(1);

    const refused = await t.http().post(path).set(as(other.user)).expect(404);
    expect(refused.body.error).toBe('RECIPE_NOT_FOUND');
    await t.http().post('/api/recipes/not-an-id/submit').set(as(owner.user)).expect(400);
    await t.http().post(path).expect(401);
  });

  it('is refused for a deleted recipe, and for a recipe of the library', async () => {
    const owner = await anAccount();
    const variant = await tofuForChicken(owner);
    await t.http().delete(`/api/recipes/${variant}`).set(as(owner.user)).expect(204);
    const library = await t.prisma.recipe.findUniqueOrThrow({ where: { slug: 'milk-porridge' } });

    await t.http().post(`/api/recipes/${variant}/submit`).set(as(owner.user)).expect(404);
    await t.http().post(`/api/recipes/${library.id}/submit`).set(as(owner.user)).expect(404);
    expect(await t.prisma.recipeDraft.count()).toBe(0);
  });

  it('is refused for a recipe with an ingredient the catalogue does not name', async () => {
    const owner = await anAccount();
    const unnamed = await t.prisma.recipe.create({
      data: { title: 'Mine', description: '', servings: 1, prepMinutes: 1, cookMinutes: 1, origin: 'user', createdByUserId: owner.user.id },
    });

    const refused = await t.http().post(`/api/recipes/${unnamed.id}/submit`).set(as(owner.user)).expect(409);

    expect(refused.body.error).toBe('RECIPE_NOT_SUBMITTABLE');
  });
});
