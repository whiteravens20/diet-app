// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * The performance budgets, measured: the application as it runs, on the
 * database of the integration tests, holding the reference catalogue
 * (`reference-catalogue.ts`) and asked what an account asks of it, over HTTP
 * on this machine. A path is run a few times that do not count and then a
 * number of times that do. Two things are held to the path's budget: the time
 * that nineteen of twenty of those runs stayed within, and how many
 * statements a run asks of the database, which is the same on every machine
 * and grows only when a path starts to ask once for each row it handles.
 * What the paths took is printed as a table when the file is through.
 *
 *   npm run bench
 *   BENCH_STATEMENTS=generate npm run bench    the statements of the paths whose name holds the word, too
 */
import { join } from 'node:path';
import { MEAL_SLOTS_BY_COUNT, type MealPlan, type ShoppingList } from '@diet-app/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { plannable } from '../../scripts/catalogue-plans.js';
import { loadCatalogue } from '../admin/seed/catalogue.js';
import { runSeed } from '../admin/seed/seeder.js';
import { macroSplitOf } from '../engine/nutrition.js';
import { optimisePlan, uniformDays } from '../engine/optimizer.js';
import { aggregateShoppingList, type PlanIngredientLine, type ShoppingIngredient } from '../engine/shopping.js';
import { resetDatabase } from './database.js';
import { aProfile, asAdmin, aUser, type TestUser } from './factories.js';
import { REFERENCE_RECIPES, referenceCatalogueDirectory } from './reference-catalogue.js';
import { createTestApp, type TestApp } from './test-app.js';

/** Runs of a path that are counted, and the runs before them that are not. */
const RUNS = 30;
const WARM_UP = 3;

/** The most a single statement may take, in milliseconds. */
const STATEMENT_BUDGET = 50;

/** What a path is held to: the milliseconds nineteen of twenty runs stay within, and the statements a run asks. */
interface Budget {
  ms: number;
  statements: number;
}

/** The plans of the measurement: four weeks of five meals, and a week of three, at 2,000 kcal a day. */
const FOUR_WEEKS = { startDate: '2026-01-05', durationDays: 28, mealCount: 5, calorieTargetOverride: 2000 };
const ONE_WEEK = { startDate: '2026-01-05', durationDays: 7, mealCount: 3, calorieTargetOverride: 2000 };

/** A page that is read: within 200 ms, and no more statements than a page of anything needs. */
const READ: Budget = { ms: 200, statements: 30 };

/** A plan may be made twenty times a minute by one account, so the runs are spread over several. */
const ACCOUNTS = 6;

const DATA = join(__dirname, '../../../../data');

/** A word of the names of the paths whose statements are listed as well. */
const LISTED = process.env.BENCH_STATEMENTS;

/** The time that `share` of the runs stayed within. */
function within(times: number[], share: number): number {
  const sorted = [...times].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(share * sorted.length) - 1)]!;
}

/** A statement without what tells two runs of it apart: its list of placeholders is one, however long. */
function shapeOf(statement: string): string {
  return statement
    .replace(/\s+/g, ' ')
    .replace(/\$\d+(\s*,\s*\$\d+)+/g, '$…')
    .replace(/\$\d+/g, '$n')
    .trim();
}

describe('the budgets of the server, at the reference catalogue', () => {
  let t: TestApp;
  let address: string;
  let accounts: { user: TestUser; profileId: string }[];
  let fourWeeks: MealPlan;
  /** The plan of four weeks each account made last. */
  const plans: MealPlan[] = [];
  let list: ShoppingList;
  /** How many ingredients the list of four weeks names. */
  let named = 0;
  const measured: { path: string; budget: Budget; median: number; nineteenOfTwenty: number; slowest: number; statements: number }[] = [];
  const statements = new Map<string, number[]>();
  let asked = 0;
  const over: string[] = [];

  /** One request as `user`; the answer is read to its end, and the time is what both took. */
  async function ask(user: TestUser, method: 'GET' | 'POST', path: string, body?: unknown, language = 'en'): Promise<{ ms: number; body: unknown }> {
    const started = performance.now();
    const response = await fetch(`${address}${path}`, {
      method,
      headers: { Authorization: `Bearer ${user.accessToken}`, 'Accept-Language': language, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    const ms = performance.now() - started;
    if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${text.slice(0, 300)}`);
    return { ms, body: JSON.parse(text) as unknown };
  }

  /**
   * Run a path, note what it took and hold it to its budget. `run` answers
   * with the milliseconds of one run, and is told which run it is.
   */
  async function measure(path: string, budget: Budget, run: (index: number) => Promise<number> | number): Promise<void> {
    for (let index = 0; index < WARM_UP; index += 1) await run(index);
    const askedBefore = asked;
    const runsBefore = new Map([...statements].map(([shape, times]) => [shape, times.length]));
    const times: number[] = [];
    for (let index = 0; index < RUNS; index += 1) times.push(await run(WARM_UP + index));
    const row = { path, budget, median: within(times, 0.5), nineteenOfTwenty: within(times, 0.95), slowest: Math.max(...times), statements: (asked - askedBefore) / RUNS };
    measured.push(row);
    if (LISTED && path.includes(LISTED)) {
      const asking = [...statements]
        .map(([shape, all]) => ({ shape, aRun: (all.length - (runsBefore.get(shape) ?? 0)) / RUNS }))
        .filter(({ aRun }) => aRun > 0)
        .sort((a, b) => b.aRun - a.aRun);
      console.log([path, ...asking.map(({ shape, aRun }) => `  ${aRun.toFixed(1)} x ${shape.slice(0, 150)}`)].join('\n'));
    }
    over.push(...(row.nineteenOfTwenty > budget.ms ? [`${path}: ${Math.round(row.nineteenOfTwenty)} ms, over ${budget.ms}`] : []));
    over.push(...(row.statements > budget.statements ? [`${path}: ${Math.round(row.statements)} statements a run, over ${budget.statements}`] : []));
  }

  /** What `measure` found over its budget since this was last asked. */
  function overBudget(): string[] {
    return over.splice(0);
  }

  /** The time of a piece of work that asks nobody. */
  function timed(work: () => unknown): number {
    const started = performance.now();
    work();
    return performance.now() - started;
  }

  beforeAll(async () => {
    const directory = referenceCatalogueDirectory(DATA);
    t = await createTestApp({ SEED_DATA_DIR: directory, SLOW_QUERY_MS: String(STATEMENT_BUDGET) });
    await resetDatabase(t.prisma);
    await runSeed(t.prisma, directory, () => undefined);
    // The planner of the database reads its statistics; a table filled a moment ago has none until it is analysed.
    await t.prisma.$executeRawUnsafe('ANALYZE');
    // The measurement asks nothing while the planner alone is timed; the connection is to outlast that.
    (t.app.getHttpServer() as { keepAliveTimeout: number }).keepAliveTimeout = 600_000;
    await t.app.listen(0, '127.0.0.1');
    address = await t.app.getUrl();

    accounts = [];
    for (let index = 0; index < ACCOUNTS; index += 1) {
      const user = await aUser(t);
      const profile = await aProfile(t, user, { mealCount: 5 });
      accounts.push({ user, profileId: profile.id });
    }
    // Filling the catalogue is not one of the paths: statements are heard from here on.
    t.prisma.onStatement((event) => {
      const shape = shapeOf(event.query);
      statements.set(shape, [...(statements.get(shape) ?? []), event.duration]);
      asked += 1;
    });
  }, 600_000);

  afterAll(async () => {
    const ms = (value: number): string => value.toFixed(value < 10 ? 1 : 0);
    const lines = [
      `${REFERENCE_RECIPES} recipes, and ${named} ingredients on the shopping list of four weeks; ${RUNS} runs of each path after ${WARM_UP} that do not count; times in milliseconds.`,
      '',
      '| Path | Budget (ms) | Median | 19 of 20 | Slowest | Statements a run | At most |',
      '|---|---|---|---|---|---|---|',
      ...measured.map((row) => `| ${row.path} | ${row.budget.ms} | ${ms(row.median)} | ${ms(row.nineteenOfTwenty)} | ${ms(row.slowest)} | ${Math.round(row.statements)} | ${row.budget.statements} |`),
      '',
      'The statements that took longest (runs, 19 of 20, slowest):',
      ...[...statements.entries()]
        .map(([shape, times]) => ({ shape, runs: times.length, nineteenOfTwenty: within(times, 0.95), slowest: Math.max(...times) }))
        .sort((a, b) => b.slowest - a.slowest)
        .slice(0, 12)
        .map((row) => `  ${row.runs} · ${ms(row.nineteenOfTwenty)} · ${ms(row.slowest)} · ${row.shape.slice(0, 160)}`),
    ];
    console.log(lines.join('\n'));
    await t.close();
  });

  it('holds the reference catalogue', async () => {
    expect(await t.prisma.recipe.count()).toBe(REFERENCE_RECIPES);
  });

  it('makes a plan of four weeks and five meals a day within 1500 ms', async () => {
    // A plan is written a day at a time, two statements each.
    await measure('POST /meal-plans/generate (28 days, 5 meals)', { ms: 1500, statements: 90 }, async (index) => {
      const { user, profileId } = accounts[index % ACCOUNTS]!;
      const made = await ask(user, 'POST', '/api/meal-plans/generate', { profileId, ...FOUR_WEEKS });
      plans[index % ACCOUNTS] = made.body as MealPlan;
      return made.ms;
    });
    fourWeeks = plans[0]!;
    expect(fourWeeks.days).toHaveLength(28);
    expect(fourWeeks.days.every((day) => day.meals.length === 5)).toBe(true);
    expect(overBudget()).toEqual([]);
  });

  it('makes a plan of a week and three meals a day within 800 ms', async () => {
    await measure('POST /meal-plans/generate (7 days, 3 meals)', { ms: 800, statements: 45 }, async (index) => {
      const { user, profileId } = accounts[index % ACCOUNTS]!;
      return (await ask(user, 'POST', '/api/meal-plans/generate', { profileId, ...ONE_WEEK })).ms;
    });
    expect(overBudget()).toEqual([]);
  });

  it('chooses the recipes of four weeks within 400 ms, and adds up what they take within 50 ms', async () => {
    const catalogue = loadCatalogue(referenceCatalogueDirectory(DATA));
    const { recipes, perishablePacks } = plannable(catalogue);
    let chosen = optimisePlan({ recipes, days: uniformDays(28, MEAL_SLOTS_BY_COUNT[5]!, 2000), macroSplit: macroSplitOf('balanced'), dietType: 'balanced', mealPrepFriendly: false, maxConsecutiveDaysSameMeal: 2, maxTimesPerWeekSameMeal: 3, maxIngredientPerWeek: 3000, perishablePacks, seed: 0 });
    await measure('optimisePlan (28 days, 5 meals)', { ms: 400, statements: 0 }, (index) =>
      timed(() => {
        chosen = optimisePlan({ recipes, days: uniformDays(28, MEAL_SLOTS_BY_COUNT[5]!, 2000), macroSplit: macroSplitOf('balanced'), dietType: 'balanced', mealPrepFriendly: false, maxConsecutiveDaysSameMeal: 2, maxTimesPerWeekSameMeal: 3, maxIngredientPerWeek: 3000, perishablePacks, seed: index + 1 });
      }),
    );
    expect(chosen.assignments).toHaveLength(28 * 5);

    const bySlug = new Map(catalogue.recipes.map((recipe) => [recipe.slug, recipe]));
    const lines: PlanIngredientLine[] = chosen.assignments.flatMap((placed) => {
      const recipe = bySlug.get(placed.recipeId)!;
      return recipe.lines.map((line) => ({ ingredientId: line.slug, quantity: line.quantity, unit: line.unit, recipeServings: recipe.seed.servings, plannedServings: placed.servings }));
    });
    const ingredients = new Map<string, ShoppingIngredient>(
      catalogue.ingredients.map((ingredient) => [
        ingredient.slug,
        { ...ingredient, id: ingredient.slug, name: ingredient.enName, gramsPerPiece: ingredient.gramsPerPiece ?? null, density: ingredient.density ?? null, displayUnit: ingredient.displayUnit ?? null, packSize: ingredient.packSize ?? null } as ShoppingIngredient,
      ]),
    );
    let groups = aggregateShoppingList(lines, ingredients);
    await measure('aggregateShoppingList (28 days, 5 meals)', { ms: 50, statements: 0 }, () =>
      timed(() => {
        groups = aggregateShoppingList(lines, ingredients);
      }),
    );
    expect(groups.flatMap((group) => group.items).length).toBeGreaterThan(50);
    expect(overBudget()).toEqual([]);
  });

  it('reads a plan of four weeks, the plans of a profile and the days of a month within 200 ms each', async () => {
    const { user, profileId } = accounts[0]!;
    await measure('GET /meal-plans/:id (28 days, 5 meals)', READ, async () => (await ask(user, 'GET', `/api/meal-plans/${fourWeeks.id}`)).ms);
    await measure('GET /meal-plans', READ, async () => (await ask(user, 'GET', `/api/meal-plans?profileId=${profileId}`)).ms);
    await measure('GET /meal-plans/calendar (a month)', READ, async () => (await ask(user, 'GET', `/api/meal-plans/calendar?profileId=${profileId}&from=2025-12-29&to=2026-02-08`)).ms);
    await measure('GET /meal-plans/overview', READ, async () => (await ask(user, 'GET', `/api/meal-plans/overview?profileId=${profileId}`)).ms);
    expect(overBudget()).toEqual([]);
  });

  it('offers another recipe for a meal within 200 ms, and fills a day again or eight ways within 800 ms', async () => {
    // An offer writes nothing, so it is asked for before the days get other meals.
    await measure('POST /meal-plans/swap-meal/preview', { ms: 200, statements: 40 }, async (index) => {
      const { user } = accounts[0]!;
      const meal = fourWeeks.days[index % 28]!.meals[index % 5]!;
      return (await ask(user, 'POST', '/api/meal-plans/swap-meal/preview', { planId: fourWeeks.id, plannedMealId: meal.id, strategy: 'random' })).ms;
    });
    // A day is made again twenty times a minute by one account, and offered other ways ten times.
    await measure('POST /meal-plans/:id/days/:dayId/variations', { ms: 800, statements: 50 }, async (index) => {
      const plan = plans[index % ACCOUNTS]!;
      return (await ask(accounts[index % ACCOUNTS]!.user, 'POST', `/api/meal-plans/${plan.id}/days/${plan.days[index % 28]!.id}/variations`, {})).ms;
    });
    await measure('POST /meal-plans/:id/days/:dayId/regenerate', { ms: 800, statements: 45 }, async (index) => {
      const plan = plans[index % ACCOUNTS]!;
      return (await ask(accounts[index % ACCOUNTS]!.user, 'POST', `/api/meal-plans/${plan.id}/days/${plan.days[index % 28]!.id}/regenerate`, {})).ms;
    });
    expect(overBudget()).toEqual([]);
  });

  it('makes the shopping list of four weeks within 250 ms, and reads it within 200 ms', async () => {
    const { user } = accounts[0]!;
    // However many ingredients the list names: the pantries are held, read and written with one statement each.
    await measure('POST /shopping-lists/generate (28 days, 5 meals)', { ms: 250, statements: 45 }, async () => {
      const made = await ask(user, 'POST', '/api/shopping-lists/generate', { planId: fourWeeks.id });
      list = made.body as ShoppingList;
      return made.ms;
    });
    named = list.groups.flatMap((group) => group.items).length;
    expect(named).toBeGreaterThan(50);

    await measure('GET /shopping-lists/:id', READ, async () => (await ask(user, 'GET', `/api/shopping-lists/${list.id}`)).ms);
    await measure('GET /shopping-lists (of a plan)', READ, async () => (await ask(user, 'GET', `/api/shopping-lists?planId=${fourWeeks.id}`)).ms);
    expect(overBudget()).toEqual([]);
  });

  it('searches the recipe library within 200 ms, however it is narrowed and in either language', async () => {
    const { user } = accounts[0]!;
    const searches: [name: string, query: string, language?: string][] = [
      ['the first page', ''],
      ['a later page', '?page=40'],
      ['a word of a title', '?search=rice'],
      ['a word of a title, in Polish', '?search=ry%C5%BC', 'pl'],
      ['a meal and an energy', '?mealType=dinner&maxCalories=500'],
      ['a diet', '?dietType=vegan'],
      ['a cuisine and a difficulty', '?cuisine=italian&difficulty=easy'],
      ['protein, fat and carbohydrate', '?minProtein=30&maxFat=20&maxCarbs=60'],
      ['without allergens', '?withoutAllergens=gluten,dairy'],
    ];
    for (const [name, query, language] of searches) {
      await measure(`GET /recipes (${name})`, READ, async () => (await ask(user, 'GET', `/api/recipes${query}`, undefined, language)).ms);
    }
    const first = (await ask(user, 'GET', '/api/recipes')).body as { items: { id: string }[]; total: number };
    expect(first.total).toBe(REFERENCE_RECIPES);
    await measure('GET /recipes/:id', READ, async () => (await ask(user, 'GET', `/api/recipes/${first.items[0]!.id}`)).ms);
    await measure('GET /ingredients (a word of a name)', READ, async () => (await ask(user, 'GET', '/api/ingredients?search=rice')).ms);
    expect(overBudget()).toEqual([]);
  });

  it('tells the administrator what the catalogue holds and what its plans reach within 200 ms', async () => {
    await measure('GET /admin/stats', READ, async () => {
      const started = performance.now();
      const response = await fetch(`${address}/api/admin/stats`, { headers: asAdmin });
      await response.text();
      if (!response.ok) throw new Error(`GET /admin/stats answered ${response.status}`);
      return performance.now() - started;
    });
    expect(overBudget()).toEqual([]);
  });

  it('asks the database nothing that takes 50 ms or longer', () => {
    const slow = [...statements.entries()].filter(([, times]) => Math.max(...times) >= STATEMENT_BUDGET).map(([shape, times]) => `${Math.round(Math.max(...times))} ms: ${shape.slice(0, 200)}`);
    expect(slow).toEqual([]);
  });
});
