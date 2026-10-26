// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * What belongs to another account is answered as what is not there.
 *
 * Every route that names something by an id is asked twice by an account that
 * owns none of it: once with the ids of what another account has, once with
 * ids of nothing at all. The two answers have to be the same, status and
 * code, so that nobody learns from the API which ids exist. And nothing of
 * the other account's may have changed.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readRoutes, type Route } from '../../scripts/contract/routes.js';
import { sealKey } from '../ai/key-cipher.js';
import { seedCatalogue } from '../testing/catalogue.js';
import { resetDatabase } from '../testing/database.js';
import { aPlan, aPrivateRecipe, aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';

/** The ids a request names: of what one account has, or of nothing. */
interface Ids {
  profile: string;
  plan: string;
  day: string;
  date: string;
  meal: string;
  list: string;
  item: string;
  pantry: string;
  weight: string;
  ownRecipe: string;
  set: string;
  notification: string;
  provider: string;
  session: string;
}

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
/** One request: how it is made from a set of ids, and from what the catalogue has for everybody. */
type Ask = [
  name: string,
  method: Method,
  path: (ids: Ids) => string,
  body?: (ids: Ids, shared: { recipe: string; ingredient: string; other: string }) => object,
];

const WHOLE_PROFILE = {
  name: 'Not mine',
  age: 40,
  sex: 'female',
  heightCm: 170,
  weightKg: 70,
  targetWeightKg: null,
  activityLevel: 'moderate',
  dietType: 'balanced',
  weeklyLossTarget: null,
  manualCalorieTarget: null,
  mealCount: 3,
  weightReminderCadence: 'off',
  customMacroSplit: null,
  preferences: {
    favoriteIngredientIds: [],
    excludedIngredientIds: [],
    allergens: [],
    dislikedIngredientIds: [],
    preferredCuisines: [],
    maxConsecutiveDaysSameMeal: 2,
    maxTimesPerWeekSameMeal: 3,
    maxMealsPerDaySameKind: null,
    maxMealsPerWeekSameKind: null,
    kindLimits: [],
    inventoryBiasResetEvery: 5,
  },
};

/** The settings of a day as a window sends them. */
const DAY_SETTINGS = {
  dayType: 'rest',
  skip: false,
  mealCount: 3,
  calorieTarget: null,
  cookTimeBudgetMinutes: null,
  useUpBy: false,
};

const ASKS: Ask[] = [
  ['read a profile', 'get', (ids) => `/api/profiles/${ids.profile}`],
  ['read what a profile should eat', 'get', (ids) => `/api/profiles/${ids.profile}/calories`],
  ['rewrite a profile', 'put', (ids) => `/api/profiles/${ids.profile}`, () => WHOLE_PROFILE],
  [
    'change the preferences of a profile',
    'patch',
    (ids) => `/api/profiles/${ids.profile}/preferences`,
    () => ({ allergens: ['gluten'] }),
  ],
  ['delete a profile', 'delete', (ids) => `/api/profiles/${ids.profile}`],

  ['list the plans of a profile', 'get', (ids) => `/api/meal-plans?profileId=${ids.profile}`],
  [
    'read what the plan of a profile comes to',
    'get',
    (ids) => `/api/meal-plans/overview?profileId=${ids.profile}`,
  ],
  [
    'read the days a profile has plans for',
    'get',
    (ids) => `/api/meal-plans/calendar?profileId=${ids.profile}&from=2026-01-01&to=2026-01-31`,
  ],
  [
    'make a plan for a profile',
    'post',
    () => '/api/meal-plans/generate',
    (ids) => ({ profileId: ids.profile, startDate: '2026-02-02', durationDays: 1 }),
  ],
  ['read a plan', 'get', (ids) => `/api/meal-plans/${ids.plan}`],
  [
    'make a plan again',
    'post',
    (ids) => `/api/meal-plans/${ids.plan}/regenerate`,
    () => ({ includePast: true }),
  ],
  [
    'fill a day of a plan again',
    'post',
    (ids) => `/api/meal-plans/${ids.plan}/days/${ids.day}/regenerate`,
    () => ({ includePast: true }),
  ],
  [
    'ask for other ways to fill a day of a plan',
    'post',
    (ids) => `/api/meal-plans/${ids.plan}/days/${ids.day}/variations`,
    () => ({}),
  ],
  [
    'take a way to fill a day of a plan',
    'post',
    (ids) => `/api/meal-plans/${ids.plan}/days/${ids.day}/variations/take`,
    () => ({ offer: 'a-note' }),
  ],
  [
    'ask what a change of the settings of a day would do',
    'post',
    (ids) => `/api/meal-plans/${ids.plan}/days/${ids.day}/settings/preview`,
    () => DAY_SETTINGS,
  ],
  [
    'change the settings of a day',
    'put',
    (ids) => `/api/meal-plans/${ids.plan}/days/${ids.day}/settings`,
    () => ({ ...DAY_SETTINGS, revision: 0 }),
  ],
  ['delete a plan', 'delete', (ids) => `/api/meal-plans/${ids.plan}`],
  [
    'ask for another recipe for a meal',
    'post',
    () => '/api/meal-plans/swap-meal/preview',
    (ids) => ({ planId: ids.plan, plannedMealId: ids.meal, strategy: 'random' }),
  ],
  [
    'swap a meal',
    'post',
    () => '/api/meal-plans/swap-meal',
    (ids, shared) => ({
      planId: ids.plan,
      plannedMealId: ids.meal,
      recipeId: shared.recipe,
      revision: 0,
      strategy: 'random',
    }),
  ],
  [
    "add a meal of one's own to a day",
    'post',
    (ids) => `/api/meal-plans/${ids.plan}/days/${ids.date}/custom-meal`,
    () => ({
      name: 'Cake',
      mealType: 'snack',
      nutrition: { calories: 300, protein: 4, fat: 12, carbs: 40 },
    }),
  ],
  [
    'mark a meal as eaten',
    'patch',
    (ids) => `/api/meal-plans/${ids.plan}/meals/${ids.meal}/eaten`,
    () => ({ eaten: true }),
  ],
  ['take a meal off its day', 'delete', (ids) => `/api/meal-plans/${ids.plan}/meals/${ids.meal}`],
  [
    'rebalance the rest of a plan',
    'post',
    (ids) => `/api/meal-plans/${ids.plan}/rebalance`,
    () => ({ scope: 'plan' }),
  ],
  [
    'rebalance a day',
    'post',
    (ids) => `/api/meal-plans/${ids.plan}/rebalance`,
    (ids) => ({ scope: 'day', date: ids.date }),
  ],
  [
    'undo a rebalance',
    'post',
    (ids) => `/api/meal-plans/${ids.plan}/rebalance`,
    (ids) => ({ scope: 'day', restore: [{ mealId: ids.meal, scale: 1 }] }),
  ],
  [
    'ask a model for another recipe for a meal',
    'post',
    () => '/api/meal-plans/ai-swap-meal/preview',
    (ids) => ({ planId: ids.plan, plannedMealId: ids.meal }),
  ],
  [
    'ask what would use up the packs a plan opens',
    'post',
    (ids) => `/api/meal-plans/${ids.plan}/use-up`,
    () => ({}),
  ],
  [
    'ask what could stand in for an ingredient of a meal',
    'get',
    (ids) => `/api/meal-plans/${ids.plan}/meals/${ids.meal}/substitutes`,
  ],
  [
    'ask a model what could stand in for an ingredient',
    'post',
    () => '/api/meal-plans/swap-ingredient/ai-suggest',
    (ids, shared) => ({
      planId: ids.plan,
      plannedMealId: ids.meal,
      fromIngredientId: shared.ingredient,
    }),
  ],
  [
    'see what a swap of an ingredient would do',
    'post',
    () => '/api/meal-plans/swap-ingredient/preview',
    (ids, shared) => ({
      planId: ids.plan,
      plannedMealId: ids.meal,
      fromIngredientId: shared.ingredient,
      toIngredientId: shared.other,
    }),
  ],
  [
    'swap an ingredient of a meal',
    'post',
    () => '/api/meal-plans/swap-ingredient/apply',
    (ids, shared) => ({
      planId: ids.plan,
      plannedMealId: ids.meal,
      fromIngredientId: shared.ingredient,
      toIngredientId: shared.other,
      acceptChange: true,
    }),
  ],

  [
    'make a shopping list for a plan',
    'post',
    () => '/api/shopping-lists/generate',
    (ids) => ({ planId: ids.plan }),
  ],
  ['list the shopping lists of a plan', 'get', (ids) => `/api/shopping-lists?planId=${ids.plan}`],
  ['read a shopping list', 'get', (ids) => `/api/shopping-lists/${ids.list}`],
  [
    'tick a line of a shopping list',
    'patch',
    (ids) => `/api/shopping-lists/${ids.list}/items/${ids.item}`,
    () => ({ checked: true }),
  ],
  [
    'ask what a shopping list could do without',
    'post',
    (ids) => `/api/shopping-lists/${ids.list}/proposals`,
    () => ({}),
  ],
  ['delete a shopping list', 'delete', (ids) => `/api/shopping-lists/${ids.list}`],

  ['read a pantry', 'get', (ids) => `/api/inventory?profileId=${ids.profile}`],
  [
    'put something into a pantry',
    'post',
    () => '/api/inventory',
    (ids, shared) => ({
      profileId: ids.profile,
      ingredientId: shared.ingredient,
      quantity: 100,
      unit: 'g',
    }),
  ],
  [
    'change a row of a pantry',
    'patch',
    (ids) => `/api/inventory/${ids.pantry}`,
    () => ({ quantity: 1 }),
  ],
  ['take a row out of a pantry', 'delete', (ids) => `/api/inventory/${ids.pantry}`],

  ['read the weights of a profile', 'get', (ids) => `/api/weights?profileId=${ids.profile}`],
  [
    'log a weight for a profile',
    'post',
    () => '/api/weights',
    (ids) => ({ profileId: ids.profile, kg: 71 }),
  ],
  ['delete a weight', 'delete', (ids) => `/api/weights/${ids.weight}`],

  ['read the favourites of a profile', 'get', (ids) => `/api/favorites?profileId=${ids.profile}`],
  [
    'mark a recipe for a profile',
    'post',
    () => '/api/favorites',
    (ids, shared) => ({ profileId: ids.profile, recipeId: shared.recipe }),
  ],
  [
    'take the mark off a recipe',
    'delete',
    (ids) => `/api/favorites/${ids.profile}/${ids.ownRecipe}`,
  ],

  [
    'read the favourite sets of a profile',
    'get',
    (ids) => `/api/favorite-sets?profileId=${ids.profile}`,
  ],
  [
    'make a favourite set for a profile',
    'post',
    () => '/api/favorite-sets',
    (ids, shared) => ({
      profileId: ids.profile,
      label: 'Not mine',
      slots: { lunch: shared.recipe },
    }),
  ],
  [
    'rename a favourite set',
    'patch',
    (ids) => `/api/favorite-sets/${ids.set}`,
    () => ({ label: 'Renamed' }),
  ],
  ['delete a favourite set', 'delete', (ids) => `/api/favorite-sets/${ids.set}`],
  [
    'put a favourite set on days of a plan',
    'post',
    (ids) => `/api/favorite-sets/${ids.set}/apply`,
    (ids) => ({ planId: ids.plan, dayDates: [ids.date] }),
  ],

  ['mark a notification as read', 'post', (ids) => `/api/notifications/${ids.notification}/read`],
  ["remove a provider's key", 'delete', (ids) => `/api/ai/providers/${ids.provider}`],
  [
    'read the recipes a profile marked',
    'get',
    (ids) => `/api/recipes?profileId=${ids.profile}&marked=marked`,
  ],
  [
    'have a model write a recipe for a profile',
    'post',
    () => '/api/recipes/drafts/from-prompt',
    (ids) => ({ profileId: ids.profile }),
  ],
  ["read a recipe of somebody's own", 'get', (ids) => `/api/recipes/${ids.ownRecipe}`],
  [
    "send a recipe of somebody's own to the queue",
    'post',
    (ids) => `/api/recipes/${ids.ownRecipe}/submit`,
  ],
  [
    "edit a recipe of somebody's own",
    'put',
    (ids) => `/api/recipes/${ids.ownRecipe}`,
    (_ids, shared) => ({
      title: 'Mine now',
      description: 'Taken over.',
      steps: ['Cook.'],
      servings: 1,
      mealTypes: ['lunch'],
      prepMinutes: 5,
      cookMinutes: 5,
      difficulty: 'easy',
      cuisine: null,
      ingredients: [{ ingredientId: shared.ingredient, quantity: 80, unit: 'g', note: null }],
    }),
  ],
  ["delete a recipe of somebody's own", 'delete', (ids) => `/api/recipes/${ids.ownRecipe}`],
  ['end a session', 'delete', (ids) => `/api/users/me/sessions/${ids.session}`],
];

const nameOf = (route: Route): string => `${route.method} ${route.path}`;

/** What a request names of an account's in its body or its query; in its path, whatever it names. */
const OF_AN_ACCOUNT = ['profileId', 'planId', 'plannedMealId'];

/** Whether a route names something an account has: by a part of its path, or by one of the ids above. */
function namesWhatAnAccountHas(route: Route): boolean {
  const named = [route.body, route.query].flatMap((schema) =>
    schema ? [JSON.stringify(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }))] : [],
  );
  return (
    route.pathValues.length > 0 ||
    route.queryValues.some((value) => OF_AN_ACCOUNT.includes(value.name)) ||
    OF_AN_ACCOUNT.some((id) => named.some((schema) => schema.includes(`"${id}"`)))
  );
}

/** The route a request goes to: of those its path fits, the one with the most parts spelled out. */
function routeOf(routes: Route[], method: Method, asked: string): string {
  const parts = asked.split('?')[0]!.split('/');
  const fitting = routes
    .filter((route) => route.method === method.toUpperCase())
    .map((route) => route.path.split('/'))
    .filter(
      (route) =>
        route.length === parts.length &&
        route.every((part, index) => part.startsWith(':') || part === parts[index]),
    )
    .sort(
      (a, b) =>
        a.filter((part) => part.startsWith(':')).length -
        b.filter((part) => part.startsWith(':')).length,
    );
  if (fitting.length === 0) throw new Error(`No route answers ${method.toUpperCase()} ${asked}.`);
  return `${method.toUpperCase()} ${fitting[0]!.join('/')}`;
}

describe('what belongs to another account', () => {
  let t: TestApp;
  let owner: TestUser;
  let stranger: TestUser;
  let theirs: Ids;
  let shared: { recipe: string; ingredient: string; other: string };

  beforeAll(async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    await seedCatalogue(t.prisma);
    owner = await aUser(t);
    stranger = await aUser(t);
    await aProfile(t, stranger);

    const profile = await aProfile(t, owner);
    const plan = await aPlan(t, owner, profile, { durationDays: 2 });
    const list = (
      await t
        .http()
        .post('/api/shopping-lists/generate')
        .set(as(owner))
        .send({ planId: plan.id })
        .expect(201)
    ).body as { id: string };
    const item = await t.prisma.shoppingListItem.findFirstOrThrow({ where: { listId: list.id } });
    const rice = await t.prisma.ingredient.findFirstOrThrow({ where: { slug: 'white-rice' } });
    const oats = await t.prisma.ingredient.findFirstOrThrow({ where: { slug: 'rolled-oats' } });
    const curated = await t.prisma.recipe.findFirstOrThrow({
      where: { createdByUserId: null, mealTypes: { has: 'lunch' } },
    });
    const own = await aPrivateRecipe(t, owner);
    const pantry = await t.prisma.inventoryItem.create({
      data: { profileId: profile.id, ingredientId: rice.id, quantity: 500, unit: 'g' },
    });
    const weight = await t.prisma.weightEntry.create({ data: { profileId: profile.id, kg: 80 } });
    await t.prisma.favorite.create({ data: { profileId: profile.id, recipeId: own.id } });
    const set = await t.prisma.favoriteSet.create({
      data: { profileId: profile.id, label: 'Workday', slots: { lunch: curated.id } },
    });
    const notification = await t.prisma.notification.create({
      data: { profileId: profile.id, type: 'weight_reminder', payload: {} },
    });
    const provider = await t.prisma.aiProviderConfig.create({
      data: {
        userId: owner.id,
        provider: 'openai',
        model: 'gpt',
        encryptedKey: sealKey('sk-of-the-owner', 'a1'.repeat(32), owner.id),
      },
    });
    const session = await t.prisma.refreshToken.findFirstOrThrow({ where: { userId: owner.id } });

    shared = { recipe: curated.id, ingredient: rice.id, other: oats.id };
    theirs = {
      profile: profile.id,
      plan: plan.id,
      day: plan.days[0]!.id,
      date: plan.days[0]!.date,
      meal: plan.days[0]!.meals[0]!.id,
      list: list.id,
      item: item.id,
      pantry: pantry.id,
      weight: weight.id,
      ownRecipe: own.id,
      set: set.id,
      notification: notification.id,
      provider: provider.id,
      session: session.familyId,
    };
  });

  afterAll(async () => {
    await t.close();
  });

  /** Ids of nothing: where the request names a day, a day no plan of anybody has. */
  const nothing = (): Ids => ({
    ...(Object.fromEntries(
      Object.keys(theirs).map((key) => [key, randomUUID()]),
    ) as unknown as Ids),
    date: theirs.date,
  });

  const answered = async (
    [, method, path, body]: Ask,
    ids: Ids,
  ): Promise<[number, string | undefined]> => {
    const request = t.http()[method](path(ids)).set(as(stranger));
    const res = await (body ? request.send(body(ids, shared)) : request);
    return [res.status, (res.body as { error?: string }).error];
  };

  /** What the owner has, counted: none of it may change. */
  const held = async () => ({
    profile: JSON.stringify(
      await t.prisma.profile.findUnique({
        where: { id: theirs.profile },
        include: { preferences: true },
      }),
    ),
    plans: await t.prisma.mealPlan.count({ where: { profileId: theirs.profile } }),
    plan: (await t.prisma.mealPlan.findUniqueOrThrow({ where: { id: theirs.plan } })).revision,
    meals: JSON.stringify(
      await t.prisma.plannedMeal.findMany({
        where: { day: { planId: theirs.plan } },
        orderBy: { id: 'asc' },
      }),
    ),
    lists: JSON.stringify(
      await t.prisma.shoppingListItem.findMany({
        where: { listId: theirs.list },
        orderBy: { id: 'asc' },
      }),
    ),
    pantry: JSON.stringify(
      await t.prisma.inventoryItem.findMany({ where: { profileId: theirs.profile } }),
    ),
    weights: await t.prisma.weightEntry.count({ where: { profileId: theirs.profile } }),
    favourites: await t.prisma.favorite.count({ where: { profileId: theirs.profile } }),
    sets: JSON.stringify(
      await t.prisma.favoriteSet.findMany({ where: { profileId: theirs.profile } }),
    ),
    notification: (
      await t.prisma.notification.findUniqueOrThrow({ where: { id: theirs.notification } })
    ).readAt,
    providers: await t.prisma.aiProviderConfig.count({ where: { userId: owner.id } }),
    recipe: JSON.stringify(
      await t.prisma.recipe.findUnique({
        where: { id: theirs.ownRecipe },
        select: { deletedAt: true },
      }),
    ),
    drafts: await t.prisma.recipeDraft.count(),
    sessions: await t.prisma.refreshToken.count({ where: { userId: owner.id, revokedAt: null } }),
  });

  it.each(ASKS)('is answered as what is not there: %s', async (...ask) => {
    const before = await held();

    const forTheirs = await answered(ask, theirs);
    const forNothing = await answered(ask, nothing());

    expect(forTheirs).toEqual(forNothing);
    expect(forTheirs[0]).toBe(404);
    expect(await held()).toEqual(before);
  });

  it('is asked for on every route that names something an account has', async () => {
    const routes = (await readRoutes()).filter((route) => route.asks === 'account');
    const asked = new Set(ASKS.map(([, method, path]) => routeOf(routes, method, path(theirs))));

    expect(
      routes
        .filter(namesWhatAnAccountHas)
        .map(nameOf)
        .filter((route) => !asked.has(route)),
    ).toEqual([]);
  });

  it('is there for its owner, so that the answers above say something', async () => {
    await t.http().get(`/api/profiles/${theirs.profile}`).set(as(owner)).expect(200);
    await t.http().get(`/api/meal-plans/${theirs.plan}`).set(as(owner)).expect(200);
    await t.http().get(`/api/shopping-lists/${theirs.list}`).set(as(owner)).expect(200);
    await t.http().get(`/api/recipes/${theirs.ownRecipe}`).set(as(owner)).expect(200);
  });

  it('says of a recipe of the catalogue that nobody deletes it, since everybody can read it', async () => {
    const refused = await t
      .http()
      .delete(`/api/recipes/${shared.recipe}`)
      .set(as(stranger))
      .expect(403);

    expect(refused.body.error).toBe('FORBIDDEN');
  });
});
