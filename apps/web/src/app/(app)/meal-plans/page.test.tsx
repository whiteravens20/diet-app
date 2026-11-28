// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CatalogueSupply,
  DiaryEntry,
  FavoriteSet,
  MealPlan,
  MealSwapPreview,
  PlanCalendarDay,
  Profile,
  PublicConfig,
  RelaxationNeeded,
  RerollPreview,
  UnfilledMeal,
} from '@diet-app/shared';
import { api } from '@/lib/api';
import { ApiClientError, localDate } from '@/lib/http';
import { dayAfter } from '@/lib/plan-dates';
import * as files from '@/lib/save-file';
import { aPublicConfig, aSupply } from '@/testing/public-config';
import { failReadsAgain } from '@/testing/read-again';
import messages from '../../../../messages/en.json';
import MealPlansPage from './page';
import { dayAnchor } from './plan-card';
import { plain, spaced } from '@/testing/spaces';

/** What the address of the page says after its question mark: empty unless a test is about a link that leads here. */
const address = vi.hoisted(() => ({ search: '' }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(address.search) }));

/** A vegan with four meals a day. */
const profile: Profile = {
  id: '6f1c2b1e-7a52-4a3a-9d0e-0a1b2c3d4e5f',
  userId: '0b9e8d7c-6f5e-4d3c-8b2a-1f0e9d8c7b6a',
  name: 'Me',
  age: 30,
  sex: null,
  heightCm: 180,
  weightKg: 80,
  targetWeightKg: null,
  waterTargetMl: 2000,
  waterTracking: true,
  expenditureCorrectionKcal: null,
  cookingReminders: true,
  waterReminders: false,
  targetWeightReached: false,
  targetReachedLaterUntil: null,
  activityLevel: 'moderate',
  dietType: 'vegan',
  weeklyLossTarget: '0.5',
  manualCalorieTarget: null,
  mealCount: 4,
  weightReminderCadence: 'weekly',
  customMacroSplit: null,
  customProteinPerKg: null,
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
    labelLimits: {
      saltAtMost: null,
      fiberAtLeast: null,
      saturatedFatAtMost: null,
      sugarsAtMost: null,
    },
  },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

/** A plan of one day with one breakfast, made inside its limits unless `over` says otherwise. */
const aPlan = (over: Partial<MealPlan> = {}): MealPlan => ({
  id: '11111111-1111-4111-8111-111111111111',
  profileId: profile.id,
  startDate: '2026-01-05',
  durationDays: 1,
  dietType: 'vegan',
  days: [
    {
      id: '22222222-2222-4222-8222-222222222222',
      date: '2026-01-05',
      meals: [
        {
          id: '33333333-3333-4333-8333-333333333333',
          mealType: 'breakfast',
          recipe: {
            id: '44444444-4444-4444-8444-444444444444',
            title: 'Oat porridge',
            description: 'Porridge for one.',
            servings: 1,
            mealTypes: ['breakfast'],
            dietTags: ['vegan'],
            ingredients: [
              {
                ingredientId: '55555555-5555-4555-8555-555555555555',
                name: 'Rolled oats',
                quantity: 60,
                unit: 'g',
                display: { quantity: 60, unit: 'g' },
                note: null,
              },
            ],
            steps: ['Cook the oats.'],
            prepMinutes: 5,
            cookMinutes: 10,
            difficulty: 'easy',
            cuisine: null,
            allergens: [],
            nutritionPerServing: { calories: 230, protein: 8, fat: 4, carbs: 40 },
            labelPerServing: { fiber: null, sugars: null, salt: null, saturatedFat: null },
            origin: 'seed',
            byModel: null,
            source: null,
          },
          ingredients: [],
          source: 'CATALOGUE',
          customName: null,
          servings: 1,
          quantityScale: 1,
          eatenAt: null,
          dietOverride: false,
          restrictionConflicts: [],
          dislikedIngredientIds: [],
          modelPick: null,
          cookAhead: null,
          cooking: null,
          estimated: false,
          nutrition: { calories: 230, protein: 8, fat: 4, carbs: 40 },
          label: { fiber: null, sugars: null, salt: null, saturatedFat: null },
          shared: null,
          leftover: null,
          carriedTo: null,
          leftoverOffer: null,
          pot: null,
          topping: null,
        },
      ],
      dayNutrition: { calories: 230, protein: 8, fat: 4, carbs: 40 },
      dayLabel: { fiber: null, sugars: null, salt: null, saturatedFat: null },
      labelNotes: [],
      diary: null,
      calorieTarget: 2000,
      targetMacros: { protein: 100, fat: 62, carbs: 260, carbsFloor: null },
      calorieDelta: -1770,
      offTarget: null,
      resizes: false,
      macrosOff: false,
      macrosOffWhy: null,
      proteinShort: false,
      skipped: false,
      belowSafetyFloor: false,
      overrides: null,
      mealCount: 3,
      listed: false,
    },
  ],
  targetMoved: null,
  splitMoved: false,
  dietMoved: null,
  mealCountMoved: null,
  weeks: [
    {
      from: '2026-01-05',
      to: '2026-01-05',
      target: 230,
      average: 230,
      uneven: false,
      listOutOfDate: false,
    },
  ],
  averageDailyNutrition: { calories: 230, protein: 8, fat: 4, carbs: 40 },
  targetMacros: { protein: 100, fat: 62, carbs: 260, carbsFloor: null },
  averageOff: { calories: null, macros: false },
  ingredientReuseScore: 0,
  packs: { bought: 0, used: 0, open: [], frozen: [], staysFrozen: [], fromFreezer: [] },
  generationMode: 'deterministic',
  options: {
    dietType: null,
    mealCount: null,
    calorieTargetOverride: null,
    mealPrepFriendly: false,
    respectExclusions: true,
    respectFavorites: true,
    respectInventory: true,
    lessWaste: false,
    noWaste: false,
    maxRepeatsPerRecipe: null,
    allowRelaxations: [],
  },
  report: { relaxations: [], singleCandidate: [], sameAgain: [], pantry: 'empty', apart: [] },
  revision: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  joint: null,
  ...over,
});

/** The days of a plan as the calendar of the page is answered them. */
const daysOnTheCalendar = (plan: MealPlan): PlanCalendarDay[] =>
  plan.days.map((day) => ({
    date: day.date,
    planId: plan.id,
    plans: 1,
    calories: day.dayNutrition.calories,
    target: day.calorieTarget,
    offTarget: day.offTarget,
    eaten: {
      meals: day.meals.filter((meal) => meal.eatenAt !== null).length,
      of: day.meals.length,
    },
    skipped: day.skipped,
  }));

/** The favourite sets the profile has, for the tests that are about them. */
let favoriteSets: FavoriteSet[] = [];

/** The account's other profiles, for the tests of a plan made together with one. */
let otherProfiles: Profile[] = [];

/** The client of the page opened last. */
let shownWith: QueryClient;

/** The page of somebody with that one profile and `plans`, on an instance whose catalogue the API says `supply` of. AI is off for them unless `aiMode` says otherwise. */
async function renderPage(
  supply: CatalogueSupply = aSupply(),
  plans: MealPlan[] = [],
  aiMode: 'none' | 'admin' = 'none',
  operator: Partial<PublicConfig> = {},
) {
  // The list answers each plan as a summary, a page at a time; a plan that is opened is read whole.
  const listed = {
    items: plans.map(
      ({ days: _days, report: _report, targetMacros: _targetMacros, packs: _packs, ...summary }) =>
        summary,
    ),
    page: 1,
    pageSize: 20,
    total: plans.length,
    totalPages: 1,
  };
  vi.spyOn(api, 'get').mockImplementation((path: string) =>
    Promise.resolve(
      (path === '/profiles'
        ? [profile, ...otherProfiles]
        : path === '/users/me'
          ? { aiMode }
          : path.startsWith('/meal-plans?')
            ? listed
            : path.startsWith('/meal-plans/calendar?')
              ? { days: plans.flatMap(daysOnTheCalendar) }
              : // What eating a meal takes off the pantry: nothing, unless a test says otherwise.
                path.endsWith('/pantry')
                ? { offer: [], taken: [] }
                : path.endsWith('/pantry/both')
                  ? [{ offer: [], taken: [] }]
                  : path.startsWith('/meal-plans/')
                    ? plans.find((plan) => path === `/meal-plans/${plan.id}`)
                    : path.endsWith('/calories')
                      ? { dailyTarget: 2209 }
                      : path.startsWith('/favorite-sets')
                        ? favoriteSets
                        : path.startsWith('/recipes/')
                          ? plans
                              .flatMap((plan) =>
                                plan.days.flatMap((day) => day.meals.map((meal) => meal.recipe)),
                              )
                              .find((recipe) => recipe && path === `/recipes/${recipe.id}`)
                          : []) as never,
    ),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  shownWith = client;
  client.setQueryData(
    ['config'],
    aPublicConfig({ catalogue: { ...aPublicConfig().catalogue, supply }, ...operator }),
  );
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider client={client}>
        <MealPlansPage />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  // A profile without a plan has the form open by itself once the list is read; with plans, the form is its head alone.
  return screen.findByRole('button', {
    name: plans.length > 0 ? /^Make a plan for / : messages.mealPlans.generateButton,
  });
}

/** The name of a control of a meal: what it does, then the meal it does it to. */
const ofAMeal = (action: string): RegExp => new RegExp(`^${action}: `);

/** Unfold the ways the one meal on the page can be changed. */
const unfoldMeal = () =>
  userEvent.click(screen.getByRole('button', { name: ofAMeal(messages.mealPlans.changeMeal) }));

/** Unfold the ways the one day on the page that can be changed, or the one in `where`, can be. */
const unfoldDay = (where: { getByRole: typeof screen.getByRole } = screen) =>
  userEvent.click(
    where.getByRole('button', { name: new RegExp(`^${messages.mealPlans.dayChanges}: `) }),
  );

/** Make it the given day for the page, which reads the clock for what has passed. The date alone is replaced: the timers a test waits on stay real. */
const onTheDay = (day: string) =>
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(`${day}T12:00:00`) });

/** The window a plan is made again in, once it has read the plan and says what the API answered of a re-roll. */
async function rerollWindow() {
  const dialog = within(
    await screen.findByRole('dialog', { name: messages.mealPlans.reroll.title }),
  );
  await dialog.findByRole('button', { name: messages.mealPlans.reroll.confirm });
  await dialog.findByText(/^(Replaced: |Nothing would change|The days chosen have passed)/);
  return dialog;
}

/** What the API answers of a re-roll of the plan of the tests on its second day, unless a test says otherwise. */
const aPreview = (over: Partial<RerollPreview> = {}): RerollPreview => ({
  days: 2,
  replaced: 2,
  kept: { outside: 0, past: 1, skipped: 0, eaten: 0, custom: 0, leftover: 0, locked: 0 },
  couldGo: { past: true, eaten: false, custom: false },
  fromToday: null,
  cooking: null,
  ...over,
});

/**
 * The API as the window and the page ask it: what a re-roll would do, by
 * `preview` of the body it is asked with, and the re-roll itself by `reroll`.
 */
function answering(
  preview: (body: Record<string, unknown>) => RerollPreview,
  reroll: () => Promise<unknown> = () => Promise.reject(new Error('no re-roll was expected')),
) {
  return vi
    .spyOn(api, 'post')
    .mockImplementation(((path: string, body?: unknown) =>
      path.endsWith('/regenerate/preview')
        ? Promise.resolve().then(() => preview((body ?? {}) as Record<string, unknown>))
        : reroll()) as never);
}

/** The re-rolls asked for, without the questions of what they would do. */
const rerolls = (post: ReturnType<typeof answering>) =>
  post.mock.calls.filter(([path]) => !String(path).endsWith('/preview'));

/** Waits until the window has asked the API what a re-roll of `body` would do, and has the answer. */
const waitForTheAnswerTo = (post: ReturnType<typeof answering>, body: Record<string, unknown>) =>
  vi.waitFor(async () => {
    expect(
      post.mock.calls.some(
        ([path, sent]) =>
          String(path).endsWith('/preview') && JSON.stringify(sent) === JSON.stringify(body),
      ),
    ).toBe(true);
    await post.mock.results.at(-1)!.value;
    expect(screen.getByRole('button', { name: messages.mealPlans.reroll.confirm })).toBeEnabled();
  });
const recalculate = (asked: Awaited<ReturnType<typeof rerollWindow>>) =>
  userEvent.click(asked.getByRole('button', { name: messages.mealPlans.reroll.confirm }));

/** Ask for a plan and have the API refuse it for lack of a recipe. */
async function refusedWith(details: UnfilledMeal) {
  const generate = await renderPage();
  vi.spyOn(api, 'post').mockRejectedValue(
    new ApiClientError(
      400,
      'NO_ELIGIBLE_RECIPE',
      'the text of the API',
      undefined,
      undefined,
      details,
    ),
  );
  await userEvent.click(generate);
}

describe('the plan page, its parts in their order', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('lists the plan under way first, the rest in the order of the list, all of them before the calendar', async () => {
    onTheDay('2026-01-10');
    // The list answers the plan that begins last first: the one to come, the one under way, the one that is over.
    await renderPage(aSupply(), [
      aPlan({
        id: '11111111-1111-4111-8111-1111111111a1',
        startDate: '2026-01-20',
        durationDays: 5,
      }),
      aPlan({
        id: '11111111-1111-4111-8111-1111111111a2',
        startDate: '2026-01-08',
        durationDays: 7,
      }),
      aPlan({
        id: '11111111-1111-4111-8111-1111111111a3',
        startDate: '2026-01-01',
        durationDays: 3,
      }),
    ]);

    const heads = await screen.findAllByText(/^\d+-day plan · Vegan$/);
    expect(heads.map((head) => plain(head.textContent))).toEqual([
      '7-day plan · Vegan',
      '5-day plan · Vegan',
      '3-day plan · Vegan',
    ]);
    const calendar = await screen.findByRole('heading', {
      name: messages.mealPlans.calendar.title,
    });
    expect(heads.at(-1)!.compareDocumentPosition(calendar)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("keeps the engine's caution open and folds the rest of its note with the line to report a bug", async () => {
    await renderPage(aSupply(), [aPlan()]);

    expect(screen.getByText(messages.disclaimers.enginePlans)).toBeVisible();
    const how = screen.getByText(messages.disclaimers.enginePlansMore).closest('details')!;
    expect(how).not.toHaveAttribute('open');
    expect(within(how).getByText(messages.common.howItWorks)).toBeInTheDocument();
    expect(within(how).getByRole('link', { name: 'Open an issue' })).toBeInTheDocument();
  });

  it('folds the ways to change a day behind one button', async () => {
    onTheDay('2026-01-05');
    await renderPage(aSupply(), [aPlan()]);
    await userEvent.click(await screen.findByText('1-day plan · Vegan'));

    const changes = await screen.findByRole('button', {
      name: new RegExp(`^${messages.mealPlans.dayChanges}: `),
    });
    expect(changes).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: messages.mealPlans.otherWays })).toBeNull();
    await userEvent.click(changes);

    expect(changes).toHaveAttribute('aria-expanded', 'true');
    for (const way of [
      messages.mealPlans.otherWays,
      messages.mealPlans.changeDay,
      messages.mealPlans.daySettingsButton,
    ])
      expect(screen.getByRole('button', { name: way })).toBeVisible();
  });

  it("folds the day's label behind a tap, under its macros", async () => {
    const plan = aPlan();
    plan.days[0]!.dayLabel = {
      fiber: { grams: 31, atLeast: false },
      sugars: { grams: 40, atLeast: true },
      salt: null,
      saturatedFat: { grams: 12, atLeast: false },
    };
    await renderPage(aSupply(), [plan]);
    await userEvent.click(await screen.findByText('1-day plan · Vegan'));

    // The figures of the label and what "≥" and "—" stand for, both behind the tap.
    const label = (await screen.findByText(messages.mealPlans.dayLabel)).closest('details')!;
    expect(label).not.toHaveAttribute('open');
    expect(label).toHaveTextContent(new RegExp(`${messages.labelFigures.fiber}\\s*31`));
    expect(
      within(label).getByText(messages.labelFigures.legendAtLeast, { exact: false }),
    ).toBeInTheDocument();
  });

  it('keeps the note of an account with AI whole, its caution and the line to report a bug open', async () => {
    await renderPage(aSupply(), [aPlan()], 'admin');

    const note = (await screen.findByText(messages.disclaimers.aiPlans)).closest('aside')!;
    expect(note).toBeVisible();
    expect(within(note).getByRole('link', { name: 'Open an issue' })).toBeVisible();
    expect(within(note).queryByText(messages.common.howItWorks)).toBeNull();
  });
});

describe('the plan page, where the catalogue is short of recipes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns on the form when the profile's diet has no recipe for one of its meals", async () => {
    const supply = aSupply();
    supply.vegan['4'] = { level: 'none', recipes: 0, fewerMeals: 3 };
    await renderPage(supply);

    expect(screen.getByRole('status').textContent).toContain(
      'no plan can be made: choose another diet, or no more than 3 meals a day.',
    );
  });

  it('warns that plans will repeat when one of the meals has few', async () => {
    const supply = aSupply();
    supply.vegan['4'] = { level: 'thin', recipes: 2, fewerMeals: 3 };
    await renderPage(supply);

    expect(plain(screen.getByRole('status').textContent)).toContain(
      'has only 2 recipes to choose from',
    );
  });

  it('says nothing on the form when there are enough', async () => {
    await renderPage();

    expect(screen.queryByRole('status')).toBeNull();
  });

  it('names the meal and the diet a refused plan had no recipe for, and what can be changed', async () => {
    await refusedWith({ slot: 'snack', dietType: 'vegan', ruledOut: 0 });

    expect(
      await screen.findByText(
        'There is no recipe for "Snack" on the "Vegan" diet, so the plan could not be made. Choose another diet or fewer meals a day, in the form above for this plan or in the profile for every plan.',
      ),
    ).toBeInTheDocument();
  });

  it('does not advise fewer meals for a meal that every day has', async () => {
    await refusedWith({ slot: 'breakfast', dietType: 'vegan', ruledOut: 0 });

    expect(
      await screen.findByText(
        'There is no recipe for "Breakfast" on the "Vegan" diet, so the plan could not be made. Choose another diet, in the form above for this plan or in the profile for every plan.',
      ),
    ).toBeInTheDocument();
  });

  it('says so when the recipes exist and the profile rules every one of them out', async () => {
    await refusedWith({ slot: 'lunch', dietType: 'vegan', ruledOut: 3 });

    expect(
      await screen.findByText(
        'The profile\'s allergens, skipped ingredients and avoided recipes rule out all 3 recipes for "Lunch" on the "Vegan" diet, so the plan could not be made.',
      ),
    ).toBeInTheDocument();
  });

  it('falls back on the general text for a refusal without details', async () => {
    const generate = await renderPage();
    vi.spyOn(api, 'post').mockRejectedValue(
      new ApiClientError(400, 'NO_ELIGIBLE_RECIPE', 'the text of the API'),
    );
    await userEvent.click(generate);

    expect(await screen.findByText(messages.errors.NO_ELIGIBLE_RECIPE)).toBeInTheDocument();
  });
});

describe('the plan page, on removing a plan', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('says before a plan is removed that what was eaten from it stays in the diary', async () => {
    await renderPage(aSupply(), [aPlan()]);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const removed = vi.spyOn(api, 'delete');

    await userEvent.click(await screen.findByRole('button', { name: messages.common.delete }));

    expect(confirm).toHaveBeenCalledWith(messages.mealPlans.deleteConfirm);
    expect(messages.mealPlans.deleteConfirm).toContain(
      'What was eaten from it stays in the diary.',
    );
    expect(removed).not.toHaveBeenCalled();
  });

  it('names the day whose diary has no room for what was eaten from the plan', async () => {
    await renderPage(aSupply(), [aPlan()]);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(api, 'delete').mockRejectedValue(
      new ApiClientError(409, 'PLAN_DIARY_FULL', 'the text of the API', undefined, undefined, {
        date: '2026-01-05',
      }),
    );

    await userEvent.click(await screen.findByRole('button', { name: messages.common.delete }));

    expect(
      await screen.findByText(
        spaced(
          'The diary of Jan 5, 2026 is full and has no room for what was eaten from the plan that day. Remove an entry of that day first, then the plan.',
        ),
      ),
    ).toBeVisible();
  });
});

describe('the plan page, where a plan does not fit inside its limits', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const refusal = (details?: RelaxationNeeded) =>
    new ApiClientError(
      422,
      'PLAN_NEEDS_RELAXATION',
      'the text of the API',
      undefined,
      undefined,
      details,
    );
  const oneBreakfast: RelaxationNeeded = {
    needs: ['weekly_cap'],
    meals: [{ date: '2026-01-10', slot: 'breakfast', gaveWay: ['weekly_cap'] }],
  };
  const aRushedDay: RelaxationNeeded = {
    needs: ['cook_time'],
    meals: [
      { date: '2026-01-06', slot: 'breakfast', gaveWay: ['cook_time'] },
      { date: '2026-01-06', slot: 'dinner', gaveWay: ['cook_time'] },
    ],
  };
  const lettingGiveWay = (count: 1 | 2) =>
    screen.findByRole('button', {
      name:
        count === 1
          ? 'Make the plan and let this limit give way'
          : 'Make the plan and let these limits give way',
    });

  it('says which limits stand in the way and for which meals, and asks again with them once the user lets them give way', async () => {
    const generate = await renderPage();
    const post = vi
      .spyOn(api, 'post')
      .mockRejectedValueOnce(refusal(oneBreakfast))
      .mockRejectedValueOnce(refusal(aRushedDay))
      .mockResolvedValue(aPlan() as never);
    await userEvent.click(generate);

    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toContain(
      'This plan cannot be filled inside its limits. One meal would go outside: times a week for one recipe.',
    );
    expect(plain(notice.textContent)).toContain(
      'Sat, Jan 10 · Breakfast: times a week for one recipe',
    );
    expect(
      (post.mock.calls[0]![1] as { allowRelaxations?: string[] }).allowRelaxations,
    ).toBeUndefined();

    await userEvent.click(await lettingGiveWay(1));
    // The second attempt needs another limit: what was let before stays let.
    expect(plain((await screen.findByRole('alert')).textContent)).toContain(
      '2 meals would go outside: cooking time of the day.',
    );
    expect(post.mock.calls[1]![1]).toMatchObject({ allowRelaxations: ['weekly_cap'] });

    await userEvent.click(await lettingGiveWay(1));
    await vi.waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(post.mock.calls[2]![1]).toMatchObject({ allowRelaxations: ['cook_time', 'weekly_cap'] });
  });

  it('lets the user drop the request instead', async () => {
    const generate = await renderPage();
    const post = vi.spyOn(api, 'post').mockRejectedValue(refusal(oneBreakfast));
    await userEvent.click(generate);

    await userEvent.click(await screen.findByRole('button', { name: messages.common.cancel }));

    expect(screen.queryByRole('alert')).toBeNull();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('asks the same of a plan that is made again, on top of what the plan may let give way already', async () => {
    onTheDay('2026-01-05');
    const plan = aPlan({ options: { ...aPlan().options, allowRelaxations: ['variety_floor'] } });
    await renderPage(aSupply(), [plan]);
    let refused = false;
    const post = answering(
      () => aPreview({ kept: { ...aPreview().kept, past: 0 }, days: 1, replaced: 1 }),
      () => {
        if (refused) return Promise.resolve(plan);
        refused = true;
        return Promise.reject(refusal(oneBreakfast));
      },
    );

    await userEvent.click(
      await screen.findByRole('button', { name: messages.mealPlans.recalculate }),
    );
    await recalculate(await rerollWindow());
    await userEvent.click(await lettingGiveWay(1));

    expect(rerolls(post)).toEqual([
      [`/meal-plans/${plan.id}/regenerate`, undefined],
      [`/meal-plans/${plan.id}/regenerate`, { allowRelaxations: ['variety_floor', 'weekly_cap'] }],
    ]);
  });

  it('falls back on the general text for a refusal without details', async () => {
    const generate = await renderPage();
    vi.spyOn(api, 'post').mockRejectedValue(refusal());
    await userEvent.click(generate);

    expect(await screen.findByText(messages.errors.PLAN_NEEDS_RELAXATION)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: messages.common.cancel })).toBeNull();
  });
});

describe('the plan page, on a plan and how it was made', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const open = async (plan: MealPlan) => {
    await renderPage(aSupply(), [plan]);
    await userEvent.click(await screen.findByText('1-day plan · Vegan'));
  };

  it('says, once the week is evened out, the shopping list it made stop matching, under the name of the change', async () => {
    const plan = aPlan({ weeks: [{ ...aPlan().weeks[0]!, average: 260, uneven: true }] });
    await open(plan);
    const list = {
      id: '77777777-7777-4777-8777-777777777777',
      planId: plan.id,
      profileId: plan.profileId,
      fromDate: '2026-01-05',
      toDate: '2026-01-05',
      householdId: null,
    };
    const post = vi
      .spyOn(api, 'post')
      .mockResolvedValue({ ...plan, effects: { lists: [list], thaw: [], freeze: [] } } as never);

    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.evenWeek }));

    expect(post).toHaveBeenCalledWith(`/meal-plans/${plan.id}/weeks/even`, {
      date: '2026-01-05',
      revision: plan.revision,
    });
    expect(await screen.findByText(messages.dayHistory.cause['week-evened'])).toBeInTheDocument();
    expect(screen.getByText(/no longer matches the plan\./)).toBeInTheDocument();
  });

  it('marks a meal that is outside a limit, and one that was the only recipe to choose from', async () => {
    await open(
      aPlan({
        report: {
          relaxations: [
            { date: '2026-01-05', slot: 'breakfast', gaveWay: ['consecutive_days', 'weekly_cap'] },
          ],
          singleCandidate: [{ date: '2026-01-05', slot: 'breakfast' }],
          sameAgain: [],
          pantry: 'counted',
          apart: [],
        },
      }),
    );

    // Each chip with what it means in words under the meal: a text that shows on hover says nothing to a finger.
    expect(screen.getByText('Outside a limit')).toBeInTheDocument();
    expect(
      screen.getByText(
        'No recipe was left for this meal inside: days in a row with one recipe, times a week for one recipe.',
      ),
    ).toBeVisible();
    expect(screen.getByText('Only recipe')).toBeInTheDocument();
    expect(screen.getByText(messages.mealPlans.onlyRecipeHint)).toBeVisible();
    expect(screen.getByText(messages.mealPlans.pantryCounted)).toBeInTheDocument();
  });

  it('says why a meal its day made again gave the recipe it held has it still', async () => {
    const sameAgain = [{ date: '2026-01-05', slot: 'breakfast' as const }];
    await open(
      aPlan({
        report: { relaxations: [], singleCandidate: [], sameAgain, pantry: 'empty', apart: [] },
      }),
    );

    expect(screen.getByText(messages.mealPlans.sameAgainHint)).toBeVisible();
  });

  it('leaves that to the single recipe, where the diet left the meal one alone', async () => {
    const one = [{ date: '2026-01-05', slot: 'breakfast' as const }];
    await open(
      aPlan({
        report: {
          relaxations: [],
          singleCandidate: one,
          sameAgain: one,
          pantry: 'empty',
          apart: [],
        },
      }),
    );

    expect(screen.getByText(messages.mealPlans.onlyRecipeHint)).toBeVisible();
    expect(screen.queryByText(messages.mealPlans.sameAgainHint)).toBeNull();
  });

  it('says nothing of a meal the report does not speak of, nor of a pantry that is empty, nor of wasting less', async () => {
    await open(aPlan());

    expect(screen.queryByText('Outside a limit')).toBeNull();
    expect(screen.queryByText('Only recipe')).toBeNull();
    for (const line of [
      messages.mealPlans.pantryCounted,
      messages.mealPlans.pantryLeftOut,
      messages.mealPlans.pantryUnused,
      messages.mealPlans.planLessWaste,
      messages.mealPlans.planNoWaste,
    ])
      expect(screen.queryByText(plain(line))).toBeNull();
  });

  it('says of a plan that wastes less that it does', async () => {
    await open(aPlan({ options: { ...aPlan().options, lessWaste: true } }));

    expect(screen.getByText(messages.mealPlans.planLessWaste)).toBeInTheDocument();
    expect(screen.queryByText(spaced(messages.mealPlans.planNoWaste))).toBeNull();
  });

  it('says of a plan that wastes nothing that it does, and nothing else of its level', async () => {
    await open(aPlan({ options: { ...aPlan().options, lessWaste: true, noWaste: true } }));

    expect(screen.getByText(spaced(messages.mealPlans.planNoWaste))).toBeInTheDocument();
    expect(screen.queryByText(messages.mealPlans.planLessWaste)).toBeNull();
  });

  it.each([
    ['left_out', messages.mealPlans.pantryLeftOut],
    ['unused', messages.mealPlans.pantryUnused],
  ] as const)('says why the pantry did not count when the reason is %s', async (pantry, line) => {
    await open(
      aPlan({ report: { relaxations: [], singleCandidate: [], sameAgain: [], pantry, apart: [] } }),
    );

    expect(screen.getByText(line)).toBeInTheDocument();
  });

  it('names the limits a plan may go outside, and makes it again inside every limit when asked', async () => {
    onTheDay('2026-01-05');
    const plan = aPlan({
      options: { ...aPlan().options, allowRelaxations: ['cook_time', 'weekly_cap'] },
    });
    await open(plan);
    const post = answering(
      () => aPreview({ kept: { ...aPreview().kept, past: 0 }, days: 1, replaced: 1 }),
      () => Promise.resolve(plan),
    );

    expect(
      screen.getByText(
        'This plan may go outside: cooking time of the day, times a week for one recipe.',
      ),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.holdLimits }));
    // The window opens with every limit held: that is what was asked for.
    const asked = await rerollWindow();
    expect(
      asked.getByLabelText(
        'Stay inside every limit this time. The plan may now go outside: cooking time of the day, times a week for one recipe.',
      ),
    ).toBeChecked();
    await recalculate(asked);

    expect(rerolls(post)).toEqual([
      [`/meal-plans/${plan.id}/regenerate`, { allowRelaxations: [] }],
    ]);
  });

  it('leaves the limits as the plan has them when the window is asked for nothing about them', async () => {
    onTheDay('2026-01-05');
    const plan = aPlan({ options: { ...aPlan().options, allowRelaxations: ['cook_time'] } });
    await open(plan);
    const post = answering(
      () => aPreview({ kept: { ...aPreview().kept, past: 0 }, days: 1, replaced: 1 }),
      () => Promise.resolve(plan),
    );

    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.recalculate }));
    const asked = await rerollWindow();
    expect(asked.getByLabelText(/^Stay inside every limit this time/)).not.toBeChecked();
    await recalculate(asked);

    expect(rerolls(post)).toEqual([[`/meal-plans/${plan.id}/regenerate`, undefined]]);
  });

  it('says, once the days are made again, the shopping list they made stop matching, and only then', async () => {
    onTheDay('2026-01-05');
    const plan = aPlan();
    await open(plan);
    const list = {
      id: '77777777-7777-4777-8777-777777777777',
      planId: plan.id,
      profileId: plan.profileId,
      fromDate: '2026-01-05',
      toDate: '2026-01-07',
      householdId: null,
    };
    let effects: unknown = { lists: [list], thaw: [], freeze: [] };
    answering(
      () => aPreview({ kept: { ...aPreview().kept, past: 0 }, days: 1, replaced: 1 }),
      () => Promise.resolve({ ...plan, effects }),
    );

    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.recalculate }));
    await recalculate(await rerollWindow());

    expect(await screen.findByText(messages.dayHistory.cause.reroll)).toBeInTheDocument();
    expect(
      screen.getByText(/The shopping list of Jan 5 – 7, 2026 no longer matches the plan\./),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: messages.mealPlans.rebalanceUndo })).toBeNull();
    await userEvent.click(
      screen.getByRole('button', { name: messages.mealPlans.rebalanceDismiss }),
    );

    // Made again with nothing to say of a list, the days bring no card.
    effects = null;
    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.recalculate }));
    await recalculate(await rerollWindow());
    await vi.waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: messages.mealPlans.reroll.title }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.queryByText(messages.dayHistory.cause.reroll)).toBeNull();
  });

  it('says nothing of how a plan was made when the plan is from before that was kept', async () => {
    await open(aPlan({ report: null }));

    expect(screen.queryByText(messages.mealPlans.pantryCounted)).toBeNull();
  });
});

describe('the plan page, when a plan is made again', () => {
  // The second of the plan's three days.
  beforeEach(() => {
    onTheDay('2026-01-06');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** A plan of three days, each with the breakfast of the plan above. */
  const threeDays = (): MealPlan => {
    const one = aPlan();
    return {
      ...one,
      durationDays: 3,
      days: ['2026-01-05', '2026-01-06', '2026-01-07'].map((date, i) => ({
        ...one.days[0]!,
        id: `2222222${i}-2222-4222-8222-222222222222`,
        date,
        meals: one.days[0]!.meals.map((meal) => ({
          ...meal,
          id: `3333333${i}-3333-4333-8333-333333333333`,
        })),
      })),
    };
  };
  const open = async (plan: MealPlan) => {
    await renderPage(aSupply(), [plan]);
    await userEvent.click(await screen.findByText('3-day plan · Vegan'));
  };
  /** The window for the whole of the plan, opened from the plan's own button, once it says what the API answered. */
  const forThePlan = async (plan: MealPlan) => {
    await open(plan);
    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.recalculate }));
    return rerollWindow();
  };
  const refusal = (status: number, code: string) =>
    new ApiClientError(status, code, 'the text of the API');
  const texts = messages.mealPlans.reroll;

  it('says in the window what the API answers a re-roll would replace and keep, asked again as the choice changes', async () => {
    const plan = threeDays();
    const post = answering((body) =>
      body.includePast
        ? aPreview({ days: 3, replaced: 3, kept: { ...aPreview().kept, past: 0 } })
        : aPreview(),
    );
    const asked = await forThePlan(plan);

    expect(await asked.findByText('Replaced: 2 meals on 2 days.')).toBeInTheDocument();
    expect(asked.getByText('1 day that has passed')).toBeInTheDocument();
    // Nothing on these days is eaten or the user's own, the API says: there is nothing to ask about either.
    expect(asked.queryByLabelText(texts.replaceEaten)).toBeNull();
    expect(asked.queryByLabelText(texts.replaceCustom)).toBeNull();

    await userEvent.click(asked.getByLabelText(texts.includePast));

    expect(await asked.findByText('Replaced: 3 meals on 3 days.')).toBeInTheDocument();
    expect(asked.getByText(texts.keptNothing)).toBeInTheDocument();
    expect(post.mock.calls).toEqual([
      [`/meal-plans/${plan.id}/regenerate/preview`, {}],
      [`/meal-plans/${plan.id}/regenerate/preview`, { includePast: true }],
    ]);
  });

  it('says that what the diary holds for the days chosen counts as eaten, and only for a day that would be filled again', async () => {
    const plan = threeDays();
    plan.days[1] = {
      ...plan.days[1]!,
      diary: {
        entries: 1,
        nutrition: { calories: 400, protein: 10, fat: 10, carbs: 60 },
        items: [],
        otherPlans: [],
      },
    };
    answering(() => aPreview());
    const asked = await forThePlan(plan);

    // The whole plan holds that day.
    expect(asked.getByText(texts.diaryCounts)).toBeVisible();

    // One day, which holds nothing in the diary.
    await userEvent.click(asked.getByLabelText(texts.day));
    await userEvent.selectOptions(asked.getByLabelText(texts.dayWhich), '2026-01-07');
    expect(asked.queryByText(texts.diaryCounts)).toBeNull();

    // The day that holds it.
    await userEvent.selectOptions(asked.getByLabelText(texts.dayWhich), '2026-01-06');
    expect(asked.getByText(texts.diaryCounts)).toBeVisible();
  });

  it('says when the API could not say what would change, asks again on request, and makes nothing again meanwhile', async () => {
    let fails = true;
    answering(() => {
      if (fails) throw refusal(429, 'RATE_LIMITED');
      return aPreview();
    });
    await open(threeDays());
    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.recalculate }));
    const asked = within(await screen.findByRole('dialog', { name: texts.title }));

    expect(await asked.findByRole('alert')).toBeInTheDocument();
    expect(asked.getByRole('button', { name: texts.confirm })).toBeDisabled();
    fails = false;
    await userEvent.click(asked.getByRole('button', { name: messages.common.retry }));

    expect(await asked.findByText('Replaced: 2 meals on 2 days.')).toBeInTheDocument();
    expect(asked.getByRole('button', { name: texts.confirm })).toBeEnabled();
  });

  it('asks for the whole plan with nothing of its own', async () => {
    const plan = threeDays();
    const post = answering(
      () => aPreview(),
      () => Promise.resolve(plan),
    );
    const asked = await forThePlan(plan);

    await recalculate(asked);

    expect(rerolls(post)).toEqual([[`/meal-plans/${plan.id}/regenerate`, undefined]]);
    // The window closes on the request: what comes of it is said on the page.
    expect(screen.queryByRole('dialog', { name: texts.title })).toBeNull();
  });

  it('opens on the whole plan from the note of a profile whose diet moved, and makes the whole plan again', async () => {
    const plan: MealPlan = {
      ...threeDays(),
      dietMoved: { profileDiet: 'vegetarian', planDiet: 'vegan' },
    };
    const post = answering(
      () => aPreview(),
      () => Promise.resolve(plan),
    );
    await open(plan);

    await userEvent.click(
      await screen.findByRole('button', { name: messages.mealPlans.rerollFromToday }),
    );
    const asked = await rerollWindow();
    expect(asked.getByRole('radio', { name: texts.whole })).toBeChecked();
    await recalculate(asked);

    expect(rerolls(post)).toEqual([[`/meal-plans/${plan.id}/regenerate`, undefined]]);
  });

  it("lets the whole plan made again waste less, with what it costs on the profile's diet where the plan names none", async () => {
    const plan = threeDays();
    const post = answering(
      () => aPreview(),
      () => Promise.resolve(plan),
    );
    const asked = await forThePlan(plan);
    const lessWaste = asked.getByRole('radio', { name: messages.mealPlans.lessWaste });

    expect(asked.getByRole('radio', { name: messages.mealPlans.wasteUsual })).toBeChecked();
    await userEvent.click(lessWaste);
    // What the level chosen costs, under its line.
    expect(asked.getByText(messages.common.howItWorks).closest('details')).toHaveTextContent(
      /uses about 64% of the pantry instead of 34%/,
    );
    await recalculate(asked);

    expect(rerolls(post)).toEqual([
      [`/meal-plans/${plan.id}/regenerate`, { lessWaste: true, noWaste: false }],
    ]);
  });

  it("lets the whole plan made again waste nothing, saying what it loosens of the profile's limits", async () => {
    const plan = threeDays();
    const post = answering(
      () => aPreview(),
      () => Promise.resolve(plan),
    );
    const asked = await forThePlan(plan);
    const noWaste = asked.getByRole('radio', { name: messages.mealPlans.noWaste });

    expect(noWaste).not.toBeChecked();
    await userEvent.click(noWaste);
    expect(asked.getByText(messages.common.howItWorks).closest('details')).toHaveTextContent(
      spaced(
        'The same recipe may come up to 3 days in a row (your profile: 2) and up to 5 times a week (your profile: 3), even twice in one day.',
        { anywhere: true },
      ),
    );
    await recalculate(asked);

    expect(rerolls(post)).toEqual([
      [`/meal-plans/${plan.id}/regenerate`, { lessWaste: true, noWaste: true }],
    ]);
  });

  it("begins as the plan has it, on the plan's own diet, and asks for a change only", async () => {
    const plan = threeDays();
    plan.options = { ...plan.options, lessWaste: true, dietType: 'keto' };
    const post = answering(
      () => aPreview(),
      () => Promise.resolve(plan),
    );
    let asked = await forThePlan(plan);
    const radio = (name: string) => asked.getByRole('radio', { name });

    expect(radio(messages.mealPlans.lessWaste)).toBeChecked();
    expect(asked.getByText(messages.common.howItWorks).closest('details')).toHaveTextContent(
      /uses about 65% of the pantry instead of 35%/,
    );
    await recalculate(asked);
    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.recalculate }));
    asked = await rerollWindow();
    await userEvent.click(radio(messages.mealPlans.wasteUsual));
    await recalculate(asked);

    expect(rerolls(post)).toEqual([
      [`/meal-plans/${plan.id}/regenerate`, undefined],
      [`/meal-plans/${plan.id}/regenerate`, { lessWaste: false, noWaste: false }],
    ]);
  });

  it('begins at wasting nothing for a plan made so, and asks to waste less only when that is chosen', async () => {
    const plan = threeDays();
    plan.options = { ...plan.options, lessWaste: true, noWaste: true };
    const post = answering(
      () => aPreview(),
      () => Promise.resolve(plan),
    );
    const asked = await forThePlan(plan);

    expect(asked.getByRole('radio', { name: messages.mealPlans.noWaste })).toBeChecked();
    await userEvent.click(asked.getByRole('radio', { name: messages.mealPlans.lessWaste }));
    await recalculate(asked);

    expect(rerolls(post)).toEqual([
      [`/meal-plans/${plan.id}/regenerate`, { lessWaste: true, noWaste: false }],
    ]);
  });

  it('offers no choice of wasting less for a part of the plan, which is made as the plan is', async () => {
    const plan = threeDays();
    plan.options = { ...plan.options, lessWaste: true };
    const post = answering(
      () => aPreview(),
      () => Promise.resolve(plan),
    );
    const asked = await forThePlan(plan);

    await userEvent.click(asked.getByLabelText(texts.day));
    expect(asked.queryByRole('group', { name: messages.mealPlans.wasteLevel })).toBeNull();
    expect(asked.queryByRole('radio', { name: messages.mealPlans.lessWaste })).toBeNull();
    await waitForTheAnswerTo(post, {});
    await recalculate(asked);

    expect(rerolls(post)).toEqual([
      [`/meal-plans/${plan.id}/days/${plan.days[1]!.id}/regenerate`, undefined],
    ]);
  });

  it('asks for what is left of the plan from today', async () => {
    const plan = threeDays();
    const post = answering(
      (body) =>
        body.from ? aPreview({ kept: { ...aPreview().kept, past: 0, outside: 1 } }) : aPreview(),
      () => Promise.resolve(plan),
    );
    const asked = await forThePlan(plan);

    await userEvent.click(asked.getByLabelText(texts.fromToday));
    expect(await asked.findByText('1 day outside the days chosen')).toBeInTheDocument();
    await recalculate(asked);

    expect(rerolls(post)).toEqual([[`/meal-plans/${plan.id}/regenerate`, { from: '2026-01-06' }]]);
  });

  it('asks for the days from one day to another, and offers no last day before the first', async () => {
    const plan = threeDays();
    const post = answering(
      () => aPreview(),
      () => Promise.resolve(plan),
    );
    const asked = await forThePlan(plan);

    await userEvent.click(asked.getByLabelText(texts.range));
    const last = asked.getByLabelText(texts.rangeTo);
    await userEvent.selectOptions(asked.getByLabelText(texts.rangeFrom), '2026-01-07');
    expect(
      within(last)
        .getAllByRole('option')
        .map((option) => (option as HTMLOptionElement).value),
    ).toEqual(['2026-01-07']);

    await userEvent.selectOptions(asked.getByLabelText(texts.rangeFrom), '2026-01-06');
    await userEvent.selectOptions(last, '2026-01-06');
    await waitForTheAnswerTo(post, { from: '2026-01-06', to: '2026-01-06' });
    await recalculate(asked);

    expect(rerolls(post)).toEqual([
      [`/meal-plans/${plan.id}/regenerate`, { from: '2026-01-06', to: '2026-01-06' }],
    ]);
  });

  it('asks for one day, the one whose own button opened the window, of the day itself', async () => {
    const plan = threeDays();
    const post = answering(
      () => aPreview({ days: 1, replaced: 1, kept: { ...aPreview().kept, past: 0, outside: 2 } }),
      () => Promise.resolve(plan),
    );
    await open(plan);

    const third = within(document.getElementById(dayAnchor(plan.id, '2026-01-07'))!);
    await userEvent.click(third.getByRole('button', { expanded: false }));
    await unfoldDay(third);
    await userEvent.click(third.getByRole('button', { name: messages.mealPlans.changeDay }));
    const asked = await rerollWindow();

    expect(asked.getByLabelText(texts.day)).toBeChecked();
    expect(asked.getByLabelText(texts.dayWhich)).toHaveValue('2026-01-07');
    expect(asked.getByText('Replaced: 1 meal on 1 day.')).toBeInTheDocument();
    expect(post.mock.calls[0]).toEqual([
      `/meal-plans/${plan.id}/days/${plan.days[2]!.id}/regenerate/preview`,
      {},
    ]);
    await recalculate(asked);

    expect(rerolls(post)).toEqual([
      [`/meal-plans/${plan.id}/days/${plan.days[2]!.id}/regenerate`, undefined],
    ]);
  });

  it('says, once a day is made again, which of its meals got their recipe again for want of another, though no list changed', async () => {
    const plan = threeDays();
    answering(
      () => aPreview({ days: 1, replaced: 1, kept: { ...aPreview().kept, past: 0, outside: 2 } }),
      () =>
        Promise.resolve({
          ...plan,
          effects: null,
          report: {
            ...plan.report!,
            sameAgain: [
              { date: '2026-01-07', slot: 'breakfast' },
              { date: '2026-01-06', slot: 'breakfast' },
            ],
          },
        }),
    );
    await open(plan);

    const third = within(document.getElementById(dayAnchor(plan.id, '2026-01-07'))!);
    await userEvent.click(third.getByRole('button', { expanded: false }));
    await unfoldDay(third);
    await userEvent.click(third.getByRole('button', { name: messages.mealPlans.changeDay }));
    await recalculate(await rerollWindow());

    // The card names the meals of the day made again alone, not of another day the report speaks of.
    expect(await screen.findByText(messages.dayHistory.cause.reroll)).toBeInTheDocument();
    expect(
      screen.getByText(
        "The same recipe as before: breakfast. No other fits the profile and the plan's limits.",
      ),
    ).toBeInTheDocument();
  });

  it("asks about the meals that were eaten and the user's own where the API says the days hold them, and replaces them when told to", async () => {
    const plan = threeDays();
    const holding = { past: false, eaten: true, custom: true };
    const post = answering(
      (body) =>
        body.replaceEaten && body.replaceCustom
          ? aPreview({ days: 2, replaced: 3, couldGo: holding })
          : aPreview({
              days: 1,
              replaced: 1,
              kept: { ...aPreview().kept, past: 0, eaten: 1, custom: 1 },
              couldGo: holding,
            }),
      () => Promise.resolve(plan),
    );
    const asked = await forThePlan(plan);

    expect(asked.getByText('Replaced: 1 meal on 1 day.')).toBeInTheDocument();
    expect(asked.getByText('1 meal marked as eaten')).toBeInTheDocument();
    expect(asked.getByText('1 meal of your own')).toBeInTheDocument();
    expect(asked.queryByLabelText(texts.includePast)).toBeNull();

    await userEvent.click(asked.getByLabelText(texts.replaceEaten));
    await userEvent.click(asked.getByLabelText(texts.replaceCustom));
    expect(await asked.findByText('Replaced: 3 meals on 2 days.')).toBeInTheDocument();
    await recalculate(asked);

    expect(rerolls(post)).toEqual([
      [`/meal-plans/${plan.id}/regenerate`, { replaceEaten: true, replaceCustom: true }],
    ]);
  });

  it('asks for nothing while the API says every day chosen has passed, says why, and asks for those days once it is told to', async () => {
    vi.setSystemTime(new Date('2026-02-01T12:00:00'));
    const plan = threeDays();
    const post = answering(
      (body) =>
        body.includePast
          ? aPreview({
              days: 3,
              replaced: 3,
              kept: { ...aPreview().kept, past: 0 },
              fromToday: 'over',
            })
          : aPreview({
              days: 0,
              replaced: 0,
              kept: { ...aPreview().kept, past: 3 },
              fromToday: 'over',
            }),
      () => Promise.resolve(plan),
    );
    const asked = await forThePlan(plan);

    expect(asked.getByText(texts.nothingPast)).toBeInTheDocument();
    expect(asked.getByRole('button', { name: texts.confirm })).toBeDisabled();
    // What is left of a plan that is over is nothing: the choice is there, and says why it cannot be made.
    expect(asked.getByLabelText(texts.fromToday)).toBeDisabled();
    expect(asked.getByLabelText(texts.fromToday)).toHaveAccessibleDescription(texts.fromTodayOver);

    await userEvent.click(asked.getByLabelText(texts.includePast));
    await waitForTheAnswerTo(post, { includePast: true });
    await recalculate(asked);

    expect(rerolls(post)).toEqual([[`/meal-plans/${plan.id}/regenerate`, { includePast: true }]]);
  });

  it('says of a plan the API says has not begun that what is left of it is the whole of it', async () => {
    vi.setSystemTime(new Date('2026-01-02T12:00:00'));
    answering(() =>
      aPreview({
        days: 3,
        replaced: 3,
        kept: { ...aPreview().kept, past: 0 },
        couldGo: { past: false, eaten: false, custom: false },
        fromToday: 'not_begun',
      }),
    );
    const asked = await forThePlan(threeDays());

    expect(asked.getByLabelText(texts.fromToday)).toBeDisabled();
    expect(asked.getByLabelText(texts.fromToday)).toHaveAccessibleDescription(
      texts.fromTodayNotBegun,
    );
    expect(asked.queryByLabelText(texts.includePast)).toBeNull();
  });

  it.each([
    {
      code: 'NOTHING_TO_REGENERATE',
      status: 409,
      button: messages.mealPlans.includePastAndRetry,
      allowed: { includePast: true },
    },
    {
      code: 'LOCKED_RECIPE_INELIGIBLE',
      status: 400,
      button: messages.mealPlans.dropLockAndRetry,
      allowed: { dropIneligibleLocks: true },
    },
  ])(
    'offers to send a request refused with $code again with what would let it through',
    async ({ code, status, button, allowed }) => {
      const plan = threeDays();
      let refused = false;
      const post = answering(
        () => aPreview(),
        () => {
          if (refused) return Promise.resolve(plan);
          refused = true;
          return Promise.reject(refusal(status, code));
        },
      );
      const asked = await forThePlan(plan);

      await userEvent.click(asked.getByLabelText(texts.range));
      await waitForTheAnswerTo(post, { from: '2026-01-06', to: '2026-01-07' });
      await recalculate(asked);
      expect(
        await screen.findByText(messages.errors[code as 'NOTHING_TO_REGENERATE']),
      ).toBeInTheDocument();
      await userEvent.click(await screen.findByRole('button', { name: button }));

      // The same days, with that allowed.
      expect(rerolls(post)[1]).toEqual([
        `/meal-plans/${plan.id}/regenerate`,
        { from: '2026-01-06', to: '2026-01-07', ...allowed },
      ]);
      await vi.waitFor(() => expect(screen.queryByRole('button', { name: button })).toBeNull());
    },
  );
});

describe('the plan page, when another recipe is asked for in the place of a meal', () => {
  beforeEach(() => {
    onTheDay('2026-01-05');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const plan = aPlan();
  const breakfast = plan.days[0]!.meals[0]!;
  /** An offer of `title` for the breakfast of the plan: a little more energy than the porridge. */
  const anOffer = (id: string, title: string): MealSwapPreview => ({
    recipe: { ...breakfast.recipe!, id, title },
    servings: 1.5,
    before: breakfast.nutrition,
    after: { calories: 240, protein: 14, fat: 9, carbs: 26 },
    dayBefore: plan.days[0]!.dayNutrition,
    dayAfter: { calories: 240, protein: 14, fat: 9, carbs: 26 },
    calorieTarget: 2000,
    targetMacros: plan.days[0]!.targetMacros,
    cooking: null,
    outsideLimits: [],
    revision: 0,
  });
  const scramble = anOffer('66666666-6666-4666-8666-666666666666', 'Tofu scramble');
  const toast = anOffer('77777777-7777-4777-8777-777777777777', 'Tomato toast');
  const open = async () => {
    await renderPage(aSupply(), [plan]);
    await userEvent.click(await screen.findByText('1-day plan · Vegan'));
  };
  const theOffer = () => screen.findByRole('group', { name: messages.mealPlans.offerTitle });

  it('shows the recipe that is offered with what the swap would do, and makes the swap when the user takes it', async () => {
    await open();
    const post = vi
      .spyOn(api, 'post')
      .mockResolvedValueOnce(scramble as never)
      .mockResolvedValue({ plan, rebalance: null } as never);

    await unfoldMeal();
    await userEvent.click(screen.getByRole('button', { name: ofAMeal(messages.mealPlans.swap) }));

    const offered = await theOffer();
    expect(plain(offered.textContent)).toContain(
      'Instead: Tofu scramble, 1.5 servings: 240 kcal in place of 230.',
    );
    expect(plain(offered.textContent)).toContain('Protein 14 g · fat 9 g · carbohydrate 26 g');
    expect(plain(offered.textContent)).toContain(
      'The day would hold 240 of 2000 kcal before its other meals are balanced around this one.',
    );
    expect(post.mock.calls[0]).toEqual([
      '/meal-plans/swap-meal/preview',
      {
        planId: plan.id,
        plannedMealId: breakfast.id,
        strategy: 'random',
        respectInventory: true,
        allowOffDiet: false,
        skip: [],
      },
    ]);

    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.offerTake }));

    expect(post.mock.calls[1]).toEqual([
      '/meal-plans/swap-meal',
      {
        planId: plan.id,
        plannedMealId: breakfast.id,
        recipeId: scramble.recipe.id,
        revision: 0,
        strategy: 'random',
        allowOffDiet: false,
      },
    ]);
    await vi.waitFor(() =>
      expect(screen.queryByRole('group', { name: messages.mealPlans.offerTitle })).toBeNull(),
    );
  });

  it('asks for another recipe, naming the ones it was offered already', async () => {
    await open();
    const post = vi
      .spyOn(api, 'post')
      .mockResolvedValueOnce(scramble as never)
      .mockResolvedValueOnce(toast as never)
      .mockResolvedValue(scramble as never);

    await unfoldMeal();
    await userEvent.click(screen.getByRole('button', { name: ofAMeal(messages.mealPlans.swap) }));
    await theOffer();
    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.offerAnother }));

    await vi.waitFor(async () => expect((await theOffer()).textContent).toContain('Tomato toast'));
    expect(post.mock.calls[1]![1]).toMatchObject({ skip: [scramble.recipe.id] });

    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.offerAnother }));
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(3));
    expect(post.mock.calls[2]![1]).toMatchObject({ skip: [scramble.recipe.id, toast.recipe.id] });
  });

  it('writes nothing when the user turns the offer down', async () => {
    await open();
    const post = vi.spyOn(api, 'post').mockResolvedValue(scramble as never);

    await unfoldMeal();
    await userEvent.click(screen.getByRole('button', { name: ofAMeal(messages.mealPlans.swap) }));
    await theOffer();
    await userEvent.click(screen.getByRole('button', { name: messages.common.cancel }));

    expect(screen.queryByRole('group', { name: messages.mealPlans.offerTitle })).toBeNull();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('drops the offer and says so when the plan changed before it was taken', async () => {
    await open();
    vi.spyOn(api, 'post')
      .mockResolvedValueOnce(scramble as never)
      .mockRejectedValue(new ApiClientError(409, 'PLAN_CHANGED', 'the text of the API'));

    await unfoldMeal();
    await userEvent.click(screen.getByRole('button', { name: ofAMeal(messages.mealPlans.swap) }));
    await theOffer();
    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.offerTake }));

    expect(await screen.findByText(messages.errors.PLAN_CHANGED)).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: messages.mealPlans.offerTitle })).toBeNull();
  });
});

describe('the list of plans on the plan page', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads the plans as summaries, and a plan whole only when it is opened', async () => {
    const plan = aPlan();
    await renderPage(aSupply(), [plan]);
    const get = vi.mocked(api.get);

    await screen.findByText('1-day plan · Vegan');
    // The calendar asks for the days of its month, in a request of its own.
    expect(
      get.mock.calls
        .map(([path]) => path)
        .filter(
          (path) => path.startsWith('/meal-plans') && !path.startsWith('/meal-plans/calendar?'),
        ),
    ).toEqual([`/meal-plans?profileId=${profile.id}&page=1`]);
    expect(screen.queryByText(plan.days[0]!.date)).toBeNull();

    await userEvent.click(screen.getByText('1-day plan · Vegan'));

    // The day as the language of the application writes it, not as the API spells it.
    expect(await screen.findByText('Mon, Jan 5')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith(`/meal-plans/${plan.id}`);
  });

  it('pages through a list that is longer than a page, and begins at the first again when the list is narrowed', async () => {
    const summary = (({ days: _days, report: _report, targetMacros: _targetMacros, ...rest }) =>
      rest)(aPlan());
    const get = vi
      .spyOn(api, 'get')
      .mockImplementation((path: string) =>
        Promise.resolve(
          (path === '/profiles'
            ? [profile]
            : path === '/users/me'
              ? { aiMode: 'none' }
              : path.startsWith('/meal-plans?')
                ? { items: [summary], page: 1, pageSize: 20, total: 45, totalPages: 3 }
                : []) as never,
        ),
      );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(
      ['config'],
      aPublicConfig({ catalogue: { ...aPublicConfig().catalogue, supply: aSupply() } }),
    );
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <QueryClientProvider client={client}>
          <MealPlansPage />
        </QueryClientProvider>
      </NextIntlClientProvider>,
    );
    const asked = (): string[] =>
      get.mock.calls.map(([path]) => path).filter((path) => path.startsWith('/meal-plans?'));

    expect(await screen.findByText('Page 1 of 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: messages.mealPlans.pageNewer })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    const older = screen.getByRole('button', { name: messages.mealPlans.pageOlder });
    await userEvent.click(older);

    expect(await screen.findByText('Page 2 of 3')).toBeInTheDocument();
    expect(asked().at(-1)).toBe(`/meal-plans?profileId=${profile.id}&page=2`);
    // The list stays while the next page comes, so the button pressed keeps the focus.
    expect(older).toBeInTheDocument();
    expect(older).toHaveFocus();

    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.statusPast }));
    expect(await screen.findByText('Page 1 of 3')).toBeInTheDocument();
    expect(asked().at(-1)).toBe(`/meal-plans?profileId=${profile.id}&page=1&status=past`);
  });
});

describe('the plan page, on what a model had to do with a plan', () => {
  beforeEach(() => {
    onTheDay('2026-01-05');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** The plan with its one meal changed by `meal`, and its one day by `day`. */
  const aPlanWith = (
    meal: Partial<MealPlan['days'][number]['meals'][number]>,
    day: Partial<MealPlan['days'][number]> = {},
    plan: Partial<MealPlan> = {},
  ): MealPlan => {
    const base = aPlan(plan);
    return {
      ...base,
      days: [{ ...base.days[0]!, ...day, meals: [{ ...base.days[0]!.meals[0]!, ...meal }] }],
    };
  };
  const opened = async (plan: MealPlan, aiMode: 'none' | 'admin' = 'none') => {
    await renderPage(aSupply(), [plan], aiMode);
    await userEvent.click(await screen.findByText('1-day plan · Vegan'));
    return screen.findByRole('button', { name: 'Oat porridge' });
  };
  const marks = (): string[] =>
    screen
      .queryAllByText(messages.aiMark.label)
      .map((mark) => mark.parentElement?.textContent ?? mark.textContent ?? '');

  it('marks no meal of a plan the engine made alone', async () => {
    await opened(aPlan());

    expect(marks()).toEqual([]);
  });

  it("keeps the model's swap in its place on an account with AI off, disabled, and says once over the plans why", async () => {
    await opened(aPlan());
    await unfoldMeal();

    const swap = screen.getByRole('button', { name: ofAMeal(messages.mealPlans.aiSwap) });
    const notes = screen.getAllByText(/^AI is off\./);
    expect(swap).toBeDisabled();
    expect(notes).toHaveLength(1);
    expect(swap).toHaveAccessibleDescription(notes[0]!.textContent!);
    expect(screen.getByRole('link', { name: 'Turn it on in Settings' })).toHaveAttribute(
      'href',
      '/settings?tab=ai',
    );
  });

  it('says nothing of the kind on an account that has a model to ask', async () => {
    await opened(aPlan(), 'admin');
    await unfoldMeal();

    expect(screen.getByRole('button', { name: ofAMeal(messages.mealPlans.aiSwap) })).toBeEnabled();
    expect(screen.queryByText(/^AI is off\./)).toBeNull();
  });

  it('marks a meal whose recipe a model chose, says why, and says it again where the recipe is opened', async () => {
    const recipe = await opened(aPlanWith({ modelPick: { reason: 'Lighter than the porridge.' } }));

    expect(marks()).toHaveLength(1);
    expect(marks()[0]).toContain(
      'A model chose this recipe for the meal: “Lighter than the porridge.”',
    );

    await userEvent.click(recipe);

    // The window is fetched when a recipe is opened, and reads the recipe after it shows.
    const window = await screen.findByRole('dialog', { name: messages.recipeModal.title });
    await vi.waitFor(() =>
      expect(window.textContent).toContain(
        'A model chose this recipe for the meal: “Lighter than the porridge.”',
      ),
    );
  });

  it('names the cuisine of a recipe where the recipe is opened, and none for a recipe that belongs to none', async () => {
    const plain = aPlan();
    const meal = plain.days[0]!.meals[0]!;
    const recipe = await opened({
      ...plain,
      days: [
        { ...plain.days[0]!, meals: [{ ...meal, recipe: { ...meal.recipe!, cuisine: 'asian' } }] },
      ],
    });

    await userEvent.click(recipe);

    const shown = within(await screen.findByRole('dialog', { name: messages.recipeModal.title }));
    expect(await shown.findByText('Asian cuisine')).toBeInTheDocument();
  });

  it('marks a meal a model chose without a reason, in words of its own', async () => {
    await opened(aPlanWith({ modelPick: { reason: null } }));

    expect(marks()[0]).toContain(messages.aiMark.picked);
  });

  it.each([
    ['written', messages.aiMark.written],
    ['changed', messages.aiMark.changed],
  ] as const)('marks a meal whose recipe a model had %s', async (byModel, said) => {
    const base = aPlan().days[0]!.meals[0]!;
    await opened(aPlanWith({ recipe: { ...base.recipe!, byModel } }));

    expect(marks()).toHaveLength(1);
    expect(marks()[0]).toContain(said);
  });

  it('marks a plan that was made with the help of a model on its row in the list', async () => {
    await renderPage(aSupply(), [aPlan({ generationMode: 'ai_assisted' })]);

    const row = await screen.findByText('1-day plan · Vegan');
    expect(row.textContent).toContain(messages.aiMark.label);
    expect(row.textContent).toContain(messages.aiMark.plan);
  });

  describe('when a model is asked for another recipe', () => {
    const plan = aPlan();
    const breakfast = plan.days[0]!.meals[0]!;
    const offered = (by: 'model' | 'engine') => ({
      recipe: {
        ...breakfast.recipe!,
        id: '66666666-6666-4666-8666-666666666666',
        title: 'Tofu scramble',
      },
      servings: 1.5,
      before: breakfast.nutrition,
      after: { calories: 240, protein: 14, fat: 9, carbs: 26 },
      dayBefore: plan.days[0]!.dayNutrition,
      dayAfter: { calories: 240, protein: 14, fat: 9, carbs: 26 },
      calorieTarget: 2000,
      targetMacros: { protein: 100, fat: 60, carbs: 250 },
      cooking: null,
      outsideLimits: [],
      revision: 0,
      aiMeta:
        by === 'model'
          ? {
              provider: 'ollama',
              model: 'a-model',
              failoverChain: [],
              usedDeterministicFallback: false,
              fallbackReason: null,
              reason: 'More protein to start the day.',
            }
          : {
              provider: null,
              model: null,
              failoverChain: [],
              usedDeterministicFallback: true,
              fallbackReason: 'all_providers_failed',
              reason: null,
            },
      pick: by === 'model' ? 'the-note-the-api-signed' : null,
    });
    const ask = async (by: 'model' | 'engine') => {
      await opened(plan, 'admin');
      const post = vi
        .spyOn(api, 'post')
        .mockResolvedValueOnce(offered(by) as never)
        .mockResolvedValue({ plan, rebalance: null } as never);
      await unfoldMeal();
      await userEvent.click(
        screen.getByRole('button', { name: new RegExp(messages.mealPlans.aiSwap) }),
      );
      return {
        post,
        offer: await screen.findByRole('group', { name: messages.mealPlans.offerTitle }),
      };
    };

    it("says that the offer is the model's own pick, with its reason, and hands the note back when the offer is taken", async () => {
      const { post, offer } = await ask('model');

      expect(offer.textContent).toContain(messages.aiMark.label);
      expect(offer.textContent).toContain(
        'A model chose this recipe for the meal: “More protein to start the day.”',
      );

      await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.offerTake }));

      expect(post.mock.calls[1]).toEqual([
        '/meal-plans/swap-meal',
        {
          planId: plan.id,
          plannedMealId: breakfast.id,
          recipeId: '66666666-6666-4666-8666-666666666666',
          revision: 0,
          strategy: 'random',
          allowOffDiet: false,
          pick: 'the-note-the-api-signed',
        },
      ]);
    });

    it("does not say so of an offer the engine made in the model's place, and hands no note back", async () => {
      const { post, offer } = await ask('engine');

      expect(offer.textContent).not.toContain(messages.aiMark.label);
      expect(screen.getByRole('status').textContent).toBe(messages.aiFallback.all_providers_failed);

      await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.offerTake }));

      expect(post.mock.calls[1]![1]).not.toHaveProperty('pick');
    });
  });
});

describe('the plan page, on how a day stands against its target', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const aDay = (day: Partial<MealPlan['days'][number]>): MealPlan => {
    const plan = aPlan();
    return { ...plan, days: [{ ...plan.days[0]!, ...day }] };
  };
  const opened = async (plan: MealPlan) => {
    await renderPage(aSupply(), [plan]);
    await userEvent.click(await screen.findByText('1-day plan · Vegan'));
    await screen.findByRole('button', { name: 'Oat porridge' });
  };

  describe('of the packs that do not keep once opened', () => {
    const chicken = {
      ingredientId: '66666666-6666-4666-8666-666666666666',
      name: 'Chicken breast',
      unit: 'g',
      packSize: 500,
      packs: 2,
      left: 20,
      date: '2026-01-05',
      until: '2026-01-07',
      forThePantry: true,
      inPantry: false,
      wasted: false,
    } as const;
    const milk = {
      ingredientId: '77777777-7777-4777-8777-777777777777',
      name: 'Whole milk',
      unit: 'ml',
      packSize: 1000,
      packs: 1,
      left: 500,
      date: '2026-01-05',
      until: '2026-01-07',
      forThePantry: true,
      inPantry: false,
      wasted: true,
    } as const;
    const feta = {
      ingredientId: '88888888-8888-4888-8888-888888888888',
      name: 'Feta cheese',
      unit: 'g',
      packSize: 200,
      packs: 1,
      left: 160,
      date: '2026-01-05',
      until: '2026-01-07',
      forThePantry: true,
      inPantry: false,
      wasted: true,
    } as const;

    it('says how much of what the menu buys it uses, and how many packs it leaves more than a fifth of', async () => {
      await opened(
        aPlan({
          packs: {
            bought: 2200,
            used: 1520,
            open: [feta, milk, chicken],
            frozen: [],
            staysFrozen: [],
            fromFreezer: [],
          },
        }),
      );

      const line = screen.getByText(
        'Packs that do not keep once opened: the menu uses 69% of what it buys, and leaves more than a fifth of 2 packs.',
      );
      expect(line).toBeVisible();
      // Unfolded, it names every pack that is not finished: the ones with much left as such.
      await userEvent.click(line);
      const packs = within(line.closest('details')!)
        .getAllByRole('listitem')
        .map((pack) => plain(pack.firstElementChild?.textContent));
      expect(packs).toEqual([
        'Feta cheese: 160 g left of a pack of 200 g, more than a fifth of it',
        'Whole milk: 500 ml left of a pack of 1000 ml, more than a fifth of it',
        'Chicken breast: 20 g left of a pack of 500 g',
      ]);
      expect(screen.getByText(messages.mealPlans.packs.explain)).toBeInTheDocument();
      // A plan that takes nothing out of the freezer does not say that what it held goes first.
      expect(screen.queryByText(messages.mealPlans.packs.explainFreezer)).toBeNull();
    });

    it('gives the pantry what a pack leaves, each of its packs once, and says when it has', async () => {
      const plan = aPlan({
        packs: {
          bought: 2200,
          used: 1520,
          open: [feta, milk, chicken],
          frozen: [],
          staysFrozen: [],
          fromFreezer: [],
        },
      });
      await opened(plan);
      const post = vi.spyOn(api, 'post').mockResolvedValue(plan as never);
      await userEvent.click(screen.getByText(/^Packs that do not keep once opened/));

      await userEvent.click(
        screen.getByRole('button', { name: 'Add to the pantry: Whole milk, 500\u00a0ml' }),
      );
      expect(post).toHaveBeenCalledWith(`/meal-plans/${plan.id}/left`, {
        ingredientId: milk.ingredientId,
        date: milk.date,
      });
    });

    it('reads the plan again when the pack no longer leaves anything, and says so', async () => {
      const plan = aPlan({
        packs: {
          bought: 1000,
          used: 500,
          open: [milk],
          frozen: [],
          staysFrozen: [],
          fromFreezer: [],
        },
      });
      await opened(plan);
      vi.spyOn(api, 'post').mockRejectedValue(
        new ApiClientError(409, 'PACK_LEFT_GONE', 'the text of the API'),
      );
      const reads = () =>
        vi.mocked(api.get).mock.calls.filter(([path]) => path === `/meal-plans/${plan.id}`).length;
      const before = reads();
      await userEvent.click(screen.getByText(/^Packs that do not keep once opened/));

      await userEvent.click(
        screen.getByRole('button', { name: 'Add to the pantry: Whole milk, 500\u00a0ml' }),
      );

      expect(await screen.findByText(messages.errors.PACK_LEFT_GONE)).toBeInTheDocument();
      await waitFor(() => expect(reads()).toBeGreaterThan(before));
    });

    it('offers the pantry nothing of a pack it was given', async () => {
      await opened(
        aPlan({
          packs: {
            bought: 1000,
            used: 500,
            open: [{ ...milk, inPantry: true }],
            frozen: [],
            staysFrozen: [],
            fromFreezer: [],
          },
        }),
      );
      await userEvent.click(screen.getByText(/^Packs that do not keep once opened/));

      expect(screen.getByText(messages.mealPlans.packs.inPantry)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Add to the pantry: Whole milk/ })).toBeNull();
    });

    it('offers the pantry nothing of a pack that leaves less than a spoonful of it', async () => {
      await opened(
        aPlan({
          packs: {
            bought: 1000,
            used: 970,
            open: [{ ...milk, left: 30, wasted: false, forThePantry: false }],
            frozen: [],
            staysFrozen: [],
            fromFreezer: [],
          },
        }),
      );
      await userEvent.click(screen.getByText(/^Packs that do not keep once opened/));

      expect(screen.getByText(/^Whole milk:/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Add to the pantry: Whole milk/ })).toBeNull();
      expect(screen.queryByText(messages.mealPlans.packs.inPantry)).toBeNull();
    });

    it('offers the pantry nothing of a pack the plan opens on a later day', async () => {
      await opened(
        aPlan({
          packs: {
            bought: 1000,
            used: 500,
            open: [{ ...milk, date: '2100-01-04', until: '2100-01-10' }],
            frozen: [],
            staysFrozen: [],
            fromFreezer: [],
          },
        }),
      );
      await userEvent.click(screen.getByText(/^Packs that do not keep once opened/));

      expect(screen.getByText(/^Whole milk:/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Add to the pantry: Whole milk/ })).toBeNull();
      expect(screen.queryByText(messages.mealPlans.packs.inPantry)).toBeNull();
    });

    it('names a food left of in several packs once, its rests added up, and says of how many much is left', async () => {
      const pack = (ingredientId: string, name: string, packSize: number, left: number) => ({
        ingredientId,
        name,
        unit: 'g' as const,
        packSize,
        packs: 3,
        left,
        wasted: left > packSize / 5,
        date: '2026-01-05',
        until: '2026-01-07',
        forThePantry: true,
        inPantry: false,
      });
      const chicken = (left: number) => pack('c', 'Chicken breast', 500, left);
      const spinach = (left: number) => pack('s', 'Spinach', 200, left);
      const turkey = (left: number) => pack('t', 'Turkey breast', 500, left);
      const tofu = (left: number) => pack('f', 'Firm tofu', 400, left);
      await opened(
        aPlan({
          packs: {
            bought: 4000,
            used: 2800,
            // As the server gives them: every pack left, the one with the most left first.
            open: [
              chicken(291),
              turkey(230),
              turkey(230),
              spinach(51),
              chicken(126),
              chicken(126),
              tofu(40),
              tofu(30),
              spinach(10),
            ],
            frozen: [],
            staysFrozen: [],
            fromFreezer: [],
          },
        }),
      );

      await userEvent.click(screen.getByText(/^Packs that do not keep once opened/));
      const details = screen.getByText(/^Packs that do not keep once opened/).closest('details')!;
      expect(
        within(details)
          .getAllByRole('listitem')
          .map((line) => plain(line.firstElementChild?.textContent)),
      ).toEqual([
        'Chicken breast: 543 g left in total of 3 packs of 500 g, more than a fifth of each',
        'Turkey breast: 460 g left in total of 2 packs of 500 g, more than a fifth of each',
        'Spinach: 61 g left in total of 2 packs of 200 g, more than a fifth of one of them',
        'Firm tofu: 70 g left in total of 2 packs of 400 g',
      ]);
    });

    it('says so when one pack is left much of, and when none is', async () => {
      await opened(
        aPlan({
          packs: {
            bought: 1500,
            used: 980,
            open: [milk, chicken],
            frozen: [],
            staysFrozen: [],
            fromFreezer: [],
          },
        }),
      );

      expect(
        screen.getByText(
          'Packs that do not keep once opened: the menu uses 65% of what it buys, and leaves more than a fifth of 1 pack.',
        ),
      ).toBeVisible();
    });

    it('says that every pack is used up when the menu finishes them all', async () => {
      await opened(
        aPlan({
          packs: { bought: 500, used: 500, open: [], frozen: [], staysFrozen: [], fromFreezer: [] },
        }),
      );

      await userEvent.click(
        screen.getByText('Packs that do not keep once opened: the menu uses 100% of what it buys.'),
      );
      expect(screen.getByText(messages.mealPlans.packs.allFinished)).toBeInTheDocument();
    });

    it('says what goes into the freezer and what comes out of it, and that what the freezer held goes first', async () => {
      await opened(
        aPlan({
          packs: {
            bought: 500,
            used: 500,
            open: [],
            // As the server gives them: by the day each goes in. Chicken goes in twice, on Monday and on Thursday.
            frozen: [
              {
                ingredientId: chicken.ingredientId,
                name: 'Chicken breast',
                unit: 'g',
                date: '2026-01-05',
                mealId: null,
                amount: 120,
                thawed: [],
                left: 120,
                portion: null,
                loose: false,
                inPantry: false,
              },
              {
                ingredientId: '55555555-5555-4555-8555-555555555555',
                name: 'Turkey breast',
                unit: 'g',
                date: '2026-01-07',
                mealId: null,
                amount: 230,
                thawed: [],
                left: 230,
                portion: null,
                loose: false,
                inPantry: false,
              },
              {
                ingredientId: chicken.ingredientId,
                name: 'Chicken breast',
                unit: 'g',
                date: '2026-01-08',
                mealId: null,
                amount: 300,
                thawed: [],
                left: 300,
                portion: null,
                loose: false,
                inPantry: false,
              },
            ],
            staysFrozen: [],
            fromFreezer: [
              {
                ingredientId: chicken.ingredientId,
                name: 'Chicken breast',
                unit: 'g',
                date: '2026-01-05',
                mealId: null,
                amount: 286,
                eaten: 150,
              },
            ],
          },
        }),
      );

      await userEvent.click(
        screen.getByText('Packs that do not keep once opened: the menu uses 100% of what it buys.'),
      );
      // One item a food, each of its rests with the day it goes in.
      expect(
        screen.getByText(
          'Into the freezer: Chicken breast, 120 g (Mon) and 300 g (Thu); Turkey breast, 230 g (Wed).',
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          'From the freezer, of what it held when the plan was made: Chicken breast, a portion of 286 g, of which the plan eats 150 g.',
        ),
      ).toBeInTheDocument();
      expect(screen.getByText(messages.mealPlans.packs.explainFreezer)).toBeInTheDocument();
      expect(screen.queryByText(messages.mealPlans.packs.explain)).toBeNull();
    });

    it('says what of the foods of the menu the plan leaves in the freezer, and why', async () => {
      await opened(
        aPlan({
          packs: {
            bought: 300,
            used: 285,
            open: [],
            frozen: [],
            fromFreezer: [],
            // As the server gives them: by the food's name, frozen after the plan was made first.
            staysFrozen: [
              {
                ingredientId: chicken.ingredientId,
                name: 'Bacon',
                unit: 'g',
                amount: 300,
                packages: 1,
                why: 'later',
                mostInTwoDays: 130,
              },
              {
                ingredientId: chicken.ingredientId,
                name: 'Bacon',
                unit: 'g',
                amount: 440,
                packages: 2,
                why: 'whole',
                mostInTwoDays: 130,
              },
            ],
          },
        }),
      );

      await userEvent.click(
        screen.getByText('Packs that do not keep once opened: the menu uses 95% of what it buys.'),
      );
      expect(screen.getByText(messages.mealPlans.freezer.staysFrozenTitle)).toBeInTheDocument();
      expect(
        screen.getByText(
          spaced(
            'Bacon, 440 g, 2 packages: the plan eats at most 130 g of it in 2 days, and thawed it has to be eaten within 2 days. Freeze it in portions of up to 130 g.',
          ),
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          'Bacon, 300 g: frozen after the plan was made, and a plan counts the freezer as it was on the day it was made. Make the plan again to use it.',
        ),
      ).toBeInTheDocument();
    });

    it('says of a plan made together with another that it counts the packs of both menus', async () => {
      await opened(
        aPlan({
          packs: {
            bought: 1500,
            used: 980,
            open: [milk, chicken],
            frozen: [],
            staysFrozen: [],
            fromFreezer: [],
          },
          joint: {
            planId: '99999999-9999-4999-8999-999999999999',
            profileId: '99999999-9999-4999-8999-999999999998',
            profileName: 'Ewa',
            cookApart: false,
          },
        }),
      );

      expect(
        screen.getByText(
          'Packs that do not keep once opened, counted together with the other plan (Ewa): the two menus use 65% of what they buy, and leave more than a fifth of 1 pack.',
        ),
      ).toBeVisible();
    });

    it('says nothing of packs of a plan whose menu opens none', async () => {
      await opened(aPlan());

      expect(screen.queryByText(/^Packs that do not keep/)).toBeNull();
    });
  });

  it('says what the day holds of protein, fat and carbohydrate against what it aims at', async () => {
    await opened(aPlan());

    expect(
      screen.getByText('Protein 8 of 100 g · fat 4 of 62 g · carbs 40 of 260 g'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'A day of this plan holds on average: protein 8 of 100 g · fat 4 of 62 g · carbs 40 of 260 g.',
      ),
    ).toBeInTheDocument();
    // A meal's own line keeps each name with its figure and unit, and breaks only after a dot.
    const meal = screen.getByText('Protein 8 g · Fat 4 g · Carbs 40 g · 230 kcal');
    expect(meal.textContent!.split(' ').map(plain)).toEqual([
      'Protein 8 g ·',
      'Fat 4 g ·',
      'Carbs 40 g ·',
      '230 kcal',
    ]);
  });

  it.each([
    ['over', messages.mealPlans.dayOver, messages.mealPlans.dayOverHint],
    ['under', messages.mealPlans.dayUnder, messages.mealPlans.dayUnderHint],
  ] as const)(
    'says on the day, for as long as it is so, that it stands %s its target, and what can be done',
    async (offTarget, label, hint) => {
      await opened(aDay({ offTarget }));

      expect(screen.getByText(label)).toBeVisible();
      expect(screen.getByText(hint)).toBeVisible();
    },
  );

  it('says of a day the diary put off its target what its entries do to it, and offers to resize its meals with them counted', async () => {
    const today = localDate();
    const posted = vi
      .spyOn(api, 'post')
      .mockResolvedValue({ plan: aPlan(), rebalance: null } as never);
    await opened(
      aDay({
        date: today,
        offTarget: 'over',
        resizes: true,
        diary: {
          entries: 2,
          nutrition: { calories: 700, protein: 20, fat: 30, carbs: 80 },
          items: [],
          otherPlans: [],
        },
      }),
    );

    // The day keeps what the diary adds to it and the mark; what to do is asked in a window the mark opens.
    expect(
      screen.getByText('The diary adds 700 kcal to this day (2 entries).', { exact: false }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: messages.mealPlans.openDiary })).toHaveAttribute(
      'href',
      `/diary?profile=${aPlan().profileId}&date=${today}`,
    );
    expect(screen.queryByText(messages.mealPlans.dayOverDiaryHint)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.dayOver }));
    const asked = within(
      await screen.findByRole('dialog', {
        name: /^This day is \d+\skcal over its target/,
      }),
    );
    expect(asked.getByText(messages.mealPlans.dayOverDiaryHint)).toBeVisible();
    // Nothing says that resizing the day could not close the gap: it was not resized with the entries.
    expect(asked.queryByText(messages.mealPlans.dayOverHint)).toBeNull();
    const resize = asked.getByRole('button', { name: messages.mealPlans.resizeDay });
    expect(resize).toHaveAccessibleDescription(messages.mealPlans.resizeDayNote);
    await userEvent.click(resize);

    expect(posted).toHaveBeenCalledWith(`/meal-plans/${aPlan().id}/rebalance`, {
      scope: 'day',
      date: today,
    });
  });

  it('lists each entry of the diary under the meal it was written for, and one of a meal the day has none of where that meal stands in the day', async () => {
    const today = localDate();
    const entry = (over: Partial<DiaryEntry>): DiaryEntry => ({
      id: '77777777-7777-4777-8777-777777777777',
      profileId: profile.id,
      date: today,
      mealType: 'breakfast',
      kind: 'product',
      name: 'Natural yoghurt',
      recipeId: null,
      ingredientId: null,
      productId: '88888888-8888-4888-8888-888888888888',
      productCode: '5900512320359',
      productSource: 'open_food_facts',
      servings: null,
      amount: { quantity: 150, unit: 'g', shown: { quantity: 150, unit: 'g' } },
      nutrition: { calories: 95, protein: 6, fat: 4, carbs: 8 },
      label: null,
      labelAtLeast: [],
      estimated: false,
      estimatedMacros: [],
      takenFromPantry: false,
      createdAt: `${today}T09:00:00.000Z`,
      ...over,
    });
    const cake = entry({
      id: '99999999-9999-4999-8999-999999999999',
      mealType: 'snack',
      kind: 'meal',
      name: 'Cake at work',
      productId: null,
      productCode: null,
      productSource: null,
      servings: 1,
      amount: null,
      estimated: true,
    });
    const supper = entry({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      mealType: 'dinner',
      kind: 'meal',
      name: 'Soup',
      productId: null,
      productCode: null,
      productSource: null,
      servings: 1,
      amount: null,
    });
    const apple = entry({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      mealType: 'second_breakfast',
      name: 'Apple',
    });
    const breakfast = aPlan().days[0]!.meals[0]!;
    await opened(
      aDay({
        date: today,
        meals: [
          breakfast,
          {
            ...breakfast,
            id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            mealType: 'dinner',
            recipe: {
              ...breakfast.recipe!,
              id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
              title: 'Lentil stew',
            },
          },
        ],
        diary: {
          entries: 4,
          nutrition: { calories: 890, protein: 27, fat: 34, carbs: 110 },
          items: [cake, supper, apple, entry({})],
          otherPlans: [],
        },
      }),
    );

    const rows = screen
      .getByRole('button', { name: 'Oat porridge' })
      .closest('ul')!
      .querySelectorAll(':scope > li');
    const named = [...rows].map((row) =>
      within(row as HTMLElement).queryByText(messages.mealPlans.fromDiaryChip)
        ? within(row as HTMLElement).getAllByRole('link')[0]!.textContent
        : (within(row as HTMLElement).queryByRole('button', {
            name: /^(Oat porridge|Lentil stew)$/,
          })?.textContent ?? 'meal'),
    );
    // The breakfast and what the diary adds to it; a second breakfast and a snack the day has no meal of, where
    // they stand in the day, before the dinner; the dinner and its own entry.
    expect(named).toEqual([
      'Oat porridge',
      'Natural yoghurt',
      'Apple',
      'Cake at work',
      'Lentil stew',
      'Soup',
    ]);
    const yoghurt = within(rows[1] as HTMLElement);
    expect(
      yoghurt.getByRole('link', { name: 'Open in the diary: Natural yoghurt' }),
    ).toHaveAttribute('href', `/diary?profile=${aPlan().profileId}&date=${today}`);
    expect(yoghurt.getByText(messages.mealPlans.fromDiaryChip)).toBeVisible();
    expect(yoghurt.getByText('150 g')).toBeVisible();
    expect(
      within(rows[3] as HTMLElement).getByText(messages.mealPlans.estimatedChip),
    ).toBeVisible();
    expect(within(rows[3] as HTMLElement).getByText('1 serving')).toBeVisible();
  });

  it("shows what another plan of the profile had eaten on the day where its meal stands, linked to that plan, and counts it in the day's line", async () => {
    const today = localDate();
    const OLDER = '22222222-2222-4222-8222-222222222222';
    const EGGS = '33333333-3333-4333-8333-333333333333';
    const plan = aDay({
      date: today,
      diary: {
        entries: 0,
        nutrition: { calories: 413, protein: 22, fat: 25, carbs: 20 },
        items: [],
        otherPlans: [
          {
            id: EGGS,
            planId: OLDER,
            mealType: 'breakfast',
            name: 'Scrambled eggs',
            recipeId: null,
            eaten: true,
            nutrition: { calories: 413, protein: 22, fat: 25, carbs: 20 },
            label: { fiber: null, sugars: null, salt: null, saturatedFat: null },
            fromPot: false,
            topping: null,
          },
        ],
      },
    });
    await opened(plan);

    const eggs = screen.getByRole('link', { name: 'Open in its plan: Scrambled eggs' });
    expect(eggs).toHaveAttribute(
      'href',
      `/meal-plans?profile=${plan.profileId}&plan=${OLDER}&day=${today}&meal=${EGGS}`,
    );
    expect(
      within(eggs.closest('li')!).getByText(messages.mealPlans.fromOtherPlanChip),
    ).toBeVisible();
    expect(
      screen.getByText(spaced('What was eaten from another plan adds 413 kcal to this day.')),
    ).toBeVisible();
  });

  it('offers no resizing of a day off its target where the server says sizing it again would move nothing', async () => {
    const today = localDate();
    // Meals of a recipe not eaten yet, at the bounds of their portions: the server's word decides.
    await opened(
      aDay({
        date: today,
        offTarget: 'over',
        resizes: false,
        diary: {
          entries: 1,
          nutrition: { calories: 700, protein: 20, fat: 30, carbs: 80 },
          items: [],
          otherPlans: [],
        },
      }),
    );

    expect(screen.getByText(messages.mealPlans.dayOverDiaryHint)).toBeVisible();
    expect(screen.queryByRole('button', { name: messages.mealPlans.resizeDay })).toBeNull();
    // With no way to close the gap, the mark opens no window.
    expect(screen.queryByRole('button', { name: messages.mealPlans.dayOver })).toBeNull();
  });

  it('says of a press that changes nothing that the portions cannot come any closer', async () => {
    const today = localDate();
    const figures = { calories: 0, protein: 0, fat: 0, carbs: 0 };
    vi.spyOn(api, 'post').mockResolvedValue({
      plan: aPlan(),
      rebalance: {
        scope: 'day',
        feasibility: 'best-effort',
        changes: [],
        unabsorbedKcal: 0,
        macrosBefore: figures,
        macrosAfter: figures,
      },
    } as never);
    await opened(
      aDay({
        date: today,
        offTarget: 'over',
        resizes: true,
        diary: {
          entries: 2,
          nutrition: { calories: 700, protein: 20, fat: 30, carbs: 80 },
          items: [],
          otherPlans: [],
        },
      }),
    );

    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.dayOver }));
    await userEvent.click(
      await screen.findByRole('button', { name: messages.mealPlans.resizeDay }),
    );

    expect(await screen.findByText(messages.mealPlans.resizeNothing)).toBeVisible();
  });

  it('asks how far a day is off its target and offers to spread it over the days ahead, saying first what that does', async () => {
    const today = localDate();
    const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);
    const posted = vi
      .spyOn(api, 'post')
      .mockResolvedValue({ plan: aPlan(), rebalance: null } as never);
    const plan = aPlan();
    await opened({
      ...plan,
      days: [
        { ...plan.days[0]!, date: today, offTarget: 'over', calorieDelta: 412.4, resizes: false },
        { ...plan.days[0]!, id: '66666666-6666-4666-8666-666666666666', date: tomorrow },
      ],
    });

    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.dayOver }));
    const asked = within(
      await screen.findByRole('dialog', {
        name: 'This day is 412\u00a0kcal over its target: what is to be done?',
      }),
    );
    expect(asked.getByText(messages.mealPlans.dayOverHint)).toBeVisible();
    expect(asked.queryByRole('button', { name: messages.mealPlans.resizeDay })).toBeNull();
    const spread = asked.getByRole('button', { name: messages.mealPlans.spread });
    expect(spread).toHaveAccessibleDescription(messages.mealPlans.spreadNoteOver);
    await userEvent.click(spread);

    expect(posted).toHaveBeenCalledWith(`/meal-plans/${plan.id}/rebalance`, {
      scope: 'plan',
      date: today,
    });
  });

  it('says nothing of the kind of a day inside its window, nor of a day that is skipped', async () => {
    await opened(aDay({ offTarget: null }));
    expect(screen.queryByText(messages.mealPlans.dayOver)).toBeNull();
    expect(screen.queryByText(messages.mealPlans.dayUnder)).toBeNull();
  });
});

describe('the plan page, on a meal the profile or the diet no longer allows', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  type Meal = MealPlan['days'][number]['meals'][number];
  /** The plan with its one breakfast changed by `first`, and a lunch like it changed by `second` when there is one. */
  const aPlanOf = (first: Partial<Meal>, second?: Partial<Meal>): MealPlan => {
    const plan = aPlan();
    const breakfast = plan.days[0]!.meals[0]!;
    const meals = [
      { ...breakfast, ...first },
      ...(second
        ? [
            {
              ...breakfast,
              id: '33333338-3333-4333-8333-333333333333',
              mealType: 'lunch' as const,
              ...second,
            },
          ]
        : []),
    ];
    return { ...plan, days: [{ ...plan.days[0]!, meals }] };
  };
  const opened = async (plan: MealPlan) => {
    await renderPage(aSupply(), [plan]);
    await userEvent.click(await screen.findByText('1-day plan · Vegan'));
    await screen.findAllByRole('button', { name: 'Oat porridge' });
  };

  it('marks, in a plan made for cooking ahead, the meal a dish is cooked at and the one it is eaten from, by name', async () => {
    const first = '33333333-3333-4333-8333-333333333333';
    const second = '33333338-3333-4333-8333-333333333333';
    await opened(
      aPlanOf(
        {
          cookAhead: 'cook',
          cooking: {
            with: [{ mealId: second, date: '2026-01-05', mealType: 'lunch', eaten: false }],
            ingredients: [],
          },
        },
        {
          cookAhead: 'cooked',
          cooking: {
            with: [{ mealId: first, date: '2026-01-05', mealType: 'breakfast', eaten: false }],
            ingredients: [],
          },
        },
      ),
    );

    for (const text of [
      'Cook for 2 meals',
      'You cook once, for breakfast and lunch.',
      'From breakfast',
      'No cooking: this is the rest of the dish from breakfast.',
    ])
      expect(screen.getByText(text)).toBeVisible();
  });

  it('says nothing of cooking ahead of a meal that is cooked for itself', async () => {
    await opened(aPlanOf({}, {}));

    expect(screen.queryByText(/Cook for 2/)).toBeNull();
    expect(screen.queryByText(/No cooking/)).toBeNull();
    expect(screen.queryByRole('button', { name: messages.split.open })).toBeNull();
  });

  it('leads to splitting any cooked dish on a page of its own', async () => {
    await opened(aPlanOf({}, {}));

    expect(screen.getByRole('link', { name: 'Splitting a dish' })).toHaveAttribute(
      'href',
      '/split',
    );
  });

  it('splits a dish cooked ahead, from the meal it is cooked at, into its meals by the energy the plan gives each', async () => {
    const first = '33333333-3333-4333-8333-333333333333';
    const second = '33333338-3333-4333-8333-333333333333';
    const plan = aPlanOf(
      {
        cookAhead: 'cook',
        cooking: {
          with: [{ mealId: second, date: '2026-01-05', mealType: 'lunch', eaten: false }],
          ingredients: [],
        },
      },
      {
        cookAhead: 'cooked',
        cooking: {
          with: [{ mealId: first, date: '2026-01-05', mealType: 'breakfast', eaten: false }],
          ingredients: [],
        },
      },
    );
    const [breakfast, lunch] = plan.days[0]!.meals;
    breakfast!.nutrition = { ...breakfast!.nutrition, calories: 640 };
    lunch!.nutrition = { ...lunch!.nutrition, calories: 560 };
    await opened(plan);

    // The meal eaten from the dish has nothing to split.
    const splits = screen.getAllByRole('button', { name: messages.split.open });
    expect(splits).toHaveLength(1);
    await userEvent.click(splits[0]!);

    const splitting = await screen.findByRole('dialog', { name: messages.split.title });
    expect(within(splitting).getByText(messages.split.planIntro)).toBeVisible();
    expect(within(splitting).getByText('Monday, breakfast')).toBeVisible();
    expect(within(splitting).getByText('Monday, lunch')).toBeVisible();
    await userEvent.type(within(splitting).getByLabelText(messages.split.onScale), '1250');
    expect(within(splitting).getByText('667 g')).toBeVisible();
    expect(within(splitting).getByText('583 g')).toBeVisible();
  });

  it('says over the days how many meals hold what the profile has ruled out since, and under each of them what and what to do', async () => {
    await opened(
      aPlanOf(
        { restrictionConflicts: ['allergen'] },
        { restrictionConflicts: ['excluded_ingredient', 'avoided'] },
      ),
    );

    expect(plain(screen.getByRole('alert').textContent)).toBe(
      '2 meals of this plan hold something the profile has ruled out since the plan was made. Each is marked below: swap it, or make the plan again.',
    );
    for (const conflict of ['allergen', 'excluded_ingredient', 'avoided'] as const) {
      expect(screen.getByText(messages.mealPlans.conflictChip[conflict])).toBeVisible();
      expect(screen.getByText(messages.mealPlans.conflictHint[conflict])).toBeVisible();
    }
  });

  it('counts one such meal as one', async () => {
    await opened(aPlanOf({ restrictionConflicts: ['allergen', 'avoided'] }, {}));

    expect(screen.getByRole('alert').textContent).toContain(
      'One meal of this plan holds something the profile has ruled out',
    );
  });

  it('marks a dish outside a diet the profile took since, which the note of the profile says, not the notice of what was ruled out', async () => {
    await opened(
      aPlanOf({ restrictionConflicts: ['diet'] }, { restrictionConflicts: ['allergen'] }),
    );

    expect(screen.getByText(messages.mealPlans.conflictChip.diet)).toBeVisible();
    expect(screen.getByText(messages.mealPlans.conflictHint.diet)).toBeVisible();
    expect(screen.getByRole('alert').textContent).toContain(
      'One meal of this plan holds something the profile has ruled out',
    );
  });

  it('says of a meal outside the diet of the plan that it is, and that it stays until it is swapped', async () => {
    await opened(aPlanOf({ dietOverride: true }));

    expect(screen.getByText(messages.mealPlans.dietOverrideChip)).toBeVisible();
    expect(
      screen.getByText(
        'This recipe does not fit the diet of the plan (Vegan). It stays until you swap it.',
      ),
    ).toBeVisible();
    // Outside the diet is the user's to decide: nothing has been ruled out.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('names what a meal holds that the profile would rather not eat, and why it may be there', async () => {
    const oats = {
      ingredientId: '55555555-5555-4555-8555-555555555555',
      name: 'Rolled oats',
      quantity: 60,
      unit: 'g' as const,
      display: { quantity: 60, unit: 'g' as const },
      note: null,
    };
    const milk = {
      ...oats,
      ingredientId: '66666666-6666-4666-8666-666666666666',
      name: 'Whole milk',
    };
    await opened(
      aPlanOf(
        {
          ingredients: [oats, milk],
          dislikedIngredientIds: [oats.ingredientId, milk.ingredientId],
        },
        { ingredients: [oats, milk] },
      ),
    );

    expect(screen.getAllByText(messages.mealPlans.dislikedChip)).toHaveLength(1);
    expect(
      screen.getByText(
        /^Holds Rolled oats and Whole milk, which this profile would rather not eat/,
      ),
    ).toBeVisible();
    // Something a profile would rather not eat is not something it has ruled out.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says nothing of the kind of a plan whose meals are as the profile and the diet have them', async () => {
    await opened(aPlanOf({}));

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(messages.mealPlans.dietOverrideChip)).toBeNull();
    for (const conflict of ['allergen', 'excluded_ingredient', 'avoided'] as const)
      expect(screen.queryByText(messages.mealPlans.conflictChip[conflict])).toBeNull();
  });
});

describe('the plan page, on what a plan is made for', () => {
  const preferences = profile.preferences;
  afterEach(() => {
    vi.restoreAllMocks();
    favoriteSets = [];
    profile.customMacroSplit = null;
    profile.customProteinPerKg = null;
    profile.preferences = preferences;
  });

  /** Ask for a plan and say what was sent. */
  const sent = async (): Promise<Record<string, unknown>> => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(aPlan() as never);
    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.generateButton }));
    await vi.waitFor(() => expect(post).toHaveBeenCalled());
    return post.mock.calls[0]![1] as Record<string, unknown>;
  };

  it("offers the profile's diet, meals and target as what a plan is made for unless the form says otherwise", async () => {
    await renderPage();

    expect(screen.getByRole('option', { name: 'As in the profile (Vegan)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'As in the profile (4)' })).toBeInTheDocument();
    expect(
      await screen.findByText(/Empty: the profile’s target, 2209 kcal a day\./),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(messages.mealPlans.calorieTarget)).toHaveAttribute(
      'placeholder',
      '2209',
    );
  });

  it('leaves all three to the profile when the form says nothing, so that the plan follows the profile when it is made again', async () => {
    await renderPage();

    const body = await sent();

    expect(body).toMatchObject({ profileId: profile.id, durationDays: 7 });
    for (const key of ['dietType', 'mealCount', 'calorieTargetOverride'])
      expect(body).not.toHaveProperty(key);
  });

  it('asks for the diet, the meals a day and the target the form names, for this plan', async () => {
    await renderPage();
    await userEvent.selectOptions(screen.getByLabelText(messages.mealPlans.diet), 'high_protein');
    await userEvent.selectOptions(screen.getByLabelText(messages.mealPlans.mealsPerDay), '5');
    await userEvent.type(screen.getByLabelText(messages.mealPlans.calorieTarget), '1800');

    expect(await sent()).toMatchObject({
      dietType: 'high_protein',
      mealCount: 5,
      calorieTargetOverride: 1800,
    });
  });

  it('asks for a plan for cooking ahead when the box for it is ticked, and says beside the box what that is', async () => {
    await renderPage();
    const cookAhead = screen.getByRole('checkbox', { name: messages.mealPlans.mealPrepFriendly });

    expect(cookAhead).toHaveAccessibleDescription(messages.mealPlans.mealPrepFriendlyHint);
    expect(cookAhead).not.toBeChecked();
    await userEvent.click(cookAhead);

    expect(await sent()).toMatchObject({ mealPrepFriendly: true });
  });

  it('asks for no cooking ahead while the box is left as it is', async () => {
    await renderPage();

    expect(await sent()).toMatchObject({ mealPrepFriendly: false });
  });

  const level = (name: string) => screen.getByRole('radio', { name });
  /** The rest of what the chosen level of waste does, under "How it works" beneath its line: the only one there is. */
  const folded = () => {
    const levels = within(screen.getByRole('group', { name: messages.mealPlans.wasteLevel }));
    const [how, ...more] = levels.getAllByText(messages.common.howItWorks);
    expect(more).toEqual([]);
    return how!.closest('details')!;
  };
  const pantryBox = () =>
    screen.getByRole('checkbox', { name: messages.mealPlans.preferInventory });

  it("asks for a plan that wastes less when it is chosen, and says beside it what that costs on the profile's diet, in the instance's figures", async () => {
    await renderPage();
    const lessWaste = level(messages.mealPlans.lessWaste);

    expect(screen.getByRole('group', { name: messages.mealPlans.wasteLevel })).toBeInTheDocument();
    expect(level(messages.mealPlans.wasteUsual)).toBeChecked();
    // Each level says in a line what it does.
    expect(level(messages.mealPlans.wasteUsual)).toHaveAccessibleDescription(
      spaced(messages.mealPlans.wasteUsualLine),
    );
    expect(lessWaste).toHaveAccessibleDescription(spaced(messages.mealPlans.lessWasteLine));
    expect(level(messages.mealPlans.noWaste)).toHaveAccessibleDescription(
      spaced(messages.mealPlans.noWasteLine),
    );
    expect(folded()).toHaveTextContent(
      spaced(messages.mealPlans.wasteUsualHint, { anywhere: true }),
    );
    await userEvent.click(lessWaste);

    // The rest of the level chosen stands folded under its line. Vegan, as the instance measured it.
    const rest = folded();
    expect(rest).not.toHaveAttribute('open');
    expect(rest).toHaveTextContent(
      /uses about 64% of the pantry instead of 34%, and about 84% of such packs instead of 74%\. In return a week has about 14% fewer different recipes/,
    );
    // How much the rest of a pack may add to a day, before the plan is made.
    expect(rest).toHaveTextContent(/a day may get up to 3% of its calorie target extra\./);
    expect(rest).toHaveTextContent(spaced(messages.mealPlans.lessWasteLimits, { anywhere: true }));

    expect(await sent()).toMatchObject({ lessWaste: true, noWaste: false });
  });

  it('asks for a plan that wastes nothing when it is chosen, and says what it gives, what it loosens of the profile and what it keeps', async () => {
    await renderPage();
    const noWaste = level(messages.mealPlans.noWaste);
    await userEvent.click(noWaste);
    const says = (text: string) =>
      expect(folded()).toHaveTextContent(spaced(text, { anywhere: true }));

    says('meat or fish within 3 days at most, anything else within 5.');
    // Vegan, as the instance measured it for this level.
    says(
      'uses about 94% of such packs instead of 74% and about 44% of the pantry instead of 34%. In return a week has about 54% fewer different recipes.',
    );
    says(
      'The same recipe may come up to 3 days in a row (your profile: 2) and up to 5 times a week (your profile: 3), even twice in one day.',
    );
    says('allergens, the avoid list and the diet work as always.');
    says('a day may get up to 5% of its calorie target extra');

    expect(await sent()).toMatchObject({ lessWaste: true, noWaste: true, respectInventory: true });
  });

  it("says the profile's own limits on repeats where they are looser than the level's, and loosens nothing", async () => {
    profile.preferences = {
      ...profile.preferences!,
      maxConsecutiveDaysSameMeal: 4,
      maxTimesPerWeekSameMeal: 6,
    };
    await renderPage();
    await userEvent.click(level(messages.mealPlans.noWaste));

    expect(folded()).toHaveTextContent(
      spaced('The same recipe may come up to 4 days in a row and up to 6 times a week, even', {
        anywhere: true,
      }),
    );
    expect(folded()).not.toHaveTextContent(/your profile/);
  });

  it('asks for a usual plan while its choice is left as it is', async () => {
    await renderPage();

    expect(await sent()).toMatchObject({
      lessWaste: false,
      noWaste: false,
      respectInventory: true,
    });
  });

  it.each([
    ['less', messages.mealPlans.lessWaste],
    ['nothing', messages.mealPlans.noWaste],
  ])(
    "holds the pantry's box ticked while the plan is to waste %s, and gives it back as it was",
    async (_, name) => {
      await renderPage();
      await userEvent.click(pantryBox());
      expect(pantryBox()).not.toBeChecked();

      await userEvent.click(level(name));
      expect(pantryBox()).toBeChecked();
      expect(pantryBox()).toBeDisabled();
      await userEvent.click(level(messages.mealPlans.wasteUsual));
      expect(pantryBox()).toBeEnabled();
      expect(pantryBox()).not.toBeChecked();
      expect(await sent()).toMatchObject({
        lessWaste: false,
        noWaste: false,
        respectInventory: false,
      });
    },
  );

  it('counts the pantry in a plan that wastes less, its box unticked before', async () => {
    await renderPage();
    await userEvent.click(pantryBox());
    await userEvent.click(level(messages.mealPlans.lessWaste));

    expect(await sent()).toMatchObject({ lessWaste: true, respectInventory: true });
  });

  it('says the figures of the diet the form names, and words alone for the custom diet, which has none', async () => {
    profile.customMacroSplit = { protein: 30, fat: 40, carbs: 30 };
    await renderPage();
    const lessWaste = () => level(messages.mealPlans.lessWaste);
    const noWaste = () => level(messages.mealPlans.noWaste);

    await userEvent.selectOptions(screen.getByLabelText(messages.mealPlans.diet), 'high_protein');
    // Both levels freeze the meat and fish they do not eat fresh, and say so.
    const freezes =
      /Meat and fish it does not eat fresh it has you freeze on the day the pack is opened: none of it goes in the bin\./;
    await userEvent.click(lessWaste());
    expect(folded()).toHaveTextContent(
      /uses about 61% of the pantry instead of 31%, and about 81% of such packs instead of 71%\. In return a week has about 11% fewer/,
    );
    expect(folded()).toHaveTextContent(freezes);
    await userEvent.click(noWaste());
    expect(folded()).toHaveTextContent(
      /uses about 91% of such packs instead of 71% and about 41% of the pantry instead of 31%\. In return a week has about 51% fewer/,
    );
    expect(folded()).toHaveTextContent(freezes);
    await userEvent.selectOptions(screen.getByLabelText(messages.mealPlans.diet), 'custom');
    expect(folded()).toHaveTextContent(
      spaced(
        plain(
          createTranslator({ locale: 'en', messages })('mealPlans.noWasteHintCustom', {
            meatDays: 3,
            otherDays: 5,
          }),
        ),
        { anywhere: true },
      ),
    );
    expect(folded()).not.toHaveTextContent(/instead of/);
    await userEvent.click(lessWaste());
    expect(folded()).toHaveTextContent(
      spaced(messages.mealPlans.lessWasteHintCustom, { anywhere: true }),
    );
    expect(folded()).not.toHaveTextContent(/instead of/);
  });

  /** The API keeps the custom diet's targets a change names in the profile, as it answers them from here on. */
  const keptTargets = () =>
    vi
      .spyOn(api, 'patch')
      .mockImplementation((_path: string, body: unknown) =>
        Promise.resolve(Object.assign(profile, body) as never),
      );
  const typeIn = async (label: string, value: string) => {
    const field = screen.getByLabelText(label);
    await userEvent.clear(field);
    await userEvent.type(field, value);
  };

  it('offers the custom diet to a profile without targets of its own, asks for them, and keeps them in the profile before the plan is made to them', async () => {
    await renderPage();
    const patch = keptTargets();
    expect(screen.getByRole('option', { name: 'Custom' })).toBeInTheDocument();
    expect(screen.queryByLabelText(messages.profile.split.protein)).toBeNull();

    await userEvent.selectOptions(screen.getByLabelText(messages.mealPlans.diet), 'custom');
    // The choices hold for the plan alone; the targets, which the profile keeps, say so beside them.
    expect(
      screen.getByText(spaced(messages.mealPlans.planChoicesHintOwnTargets, { start: true })),
    ).toBeInTheDocument();
    expect(screen.getByText(spaced(messages.mealPlans.ownTargetsSaved))).toBeInTheDocument();
    expect(
      screen.queryByText(spaced(messages.mealPlans.planChoicesHint, { start: true })),
    ).toBeNull();
    await typeIn(messages.profile.split.protein, '30');
    await typeIn(messages.profile.split.carbs, '40');
    const post = vi.spyOn(api, 'post').mockResolvedValue(aPlan() as never);
    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.generateButton }));

    await vi.waitFor(() => expect(post).toHaveBeenCalled());
    expect(patch).toHaveBeenCalledWith(`/profiles/${profile.id}`, {
      customMacroSplit: { protein: 30, fat: 30, carbs: 40 },
      customProteinPerKg: null,
    });
    expect(patch.mock.invocationCallOrder[0]).toBeLessThan(post.mock.invocationCallOrder[0]!);
    expect(post.mock.calls[0]![1]).toMatchObject({ dietType: 'custom' });
    // The profile has its targets now: the diet is named by them, and the form, folded once the plan is made, does not ask again.
    expect(
      await screen.findByRole('option', {
        name: spaced('Custom (30% protein, 30% fat, 40% carbohydrate)'),
        hidden: true,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(messages.profile.split.protein)).toBeNull();
  });

  it("keeps protein per kilogram where the form sets protein so, worked out at the profile's own target", async () => {
    await renderPage();
    const patch = keptTargets();
    await userEvent.selectOptions(screen.getByLabelText(messages.mealPlans.diet), 'custom');
    await userEvent.click(screen.getByRole('radio', { name: messages.profile.customWayPerKg }));

    // 1.6 g a kilogram of 80 kg is 128 g, 512 kcal: 23% of the profile's 2209 kcal, fat 30% and carbohydrate the rest.
    expect(
      await screen.findByText(
        spaced(
          'At your weight that is 128 g of protein, 23% of a target of 2209 kcal. Carbohydrates are the rest: 47%.',
        ),
      ),
    ).toBeInTheDocument();
    const post = vi.spyOn(api, 'post').mockResolvedValue(aPlan() as never);
    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.generateButton }));

    await vi.waitFor(() => expect(post).toHaveBeenCalled());
    expect(patch).toHaveBeenCalledWith(`/profiles/${profile.id}`, {
      customMacroSplit: { protein: 23, fat: 30, carbs: 47 },
      customProteinPerKg: 1.6,
    });
  });

  it.each([
    [
      'a split that does not add up',
      async () => typeIn(messages.profile.split.protein, '40'),
      messages.profile.splitSumRefused,
    ],
    [
      'protein per kilogram that goes past a limit at the target and the weight',
      async () => {
        await userEvent.click(screen.getByRole('radio', { name: messages.profile.customWayPerKg }));
        // 3 g a kilogram of 80 kg is 960 kcal: 43% of 2209, and with fat at 60% carbohydrate would be under its 5%.
        await typeIn(messages.profile.perKgProtein, '3');
        await typeIn(messages.profile.perKgFat, '60');
      },
      messages.profile.perKgRefused,
    ],
  ])('neither keeps nor plans to %s, and says why', async (_why, typed, refusal) => {
    await renderPage();
    const patch = vi.spyOn(api, 'patch');
    const post = vi.spyOn(api, 'post');
    await userEvent.selectOptions(screen.getByLabelText(messages.mealPlans.diet), 'custom');
    await typed();

    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.generateButton }));

    expect(await screen.findByRole('alert')).toHaveTextContent(refusal);
    expect(patch).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('makes no plan when the targets could not be kept, and says so', async () => {
    await renderPage();
    vi.spyOn(api, 'patch').mockRejectedValue(new Error('down'));
    const post = vi.spyOn(api, 'post');
    await userEvent.selectOptions(screen.getByLabelText(messages.mealPlans.diet), 'custom');

    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.generateButton }));

    expect(await screen.findByRole('alert')).toHaveTextContent(messages.mealPlans.errSaveTargets);
    expect(post).not.toHaveBeenCalled();
  });

  it("says where the plan's own target holds the profile's protein per kilogram at a limit", async () => {
    profile.customMacroSplit = { protein: 35, fat: 30, carbs: 35 };
    profile.customProteinPerKg = 3;
    await renderPage();
    await userEvent.selectOptions(screen.getByLabelText(messages.mealPlans.diet), 'custom');
    const target = screen.getByLabelText(messages.mealPlans.calorieTarget);
    const held = spaced(
      "At this plan's target of 1500 kcal, 3 g of protein per kg goes past the limits of a split: the plan holds protein at the limit, 169 g a day.",
    );

    // 3 g a kilogram of 80 kg is 960 kcal: 32 % of 3000, and 64 % of 1500, held at 45 %, 169 g.
    await userEvent.type(target, '3000');
    expect(screen.queryByText(held)).toBeNull();
    await userEvent.clear(target);
    await userEvent.type(target, '1500');
    expect(screen.getByText(held)).toBeInTheDocument();
  });

  it('says the same of protein per kilogram the form asks for, which fits the profile’s target but not the plan’s', async () => {
    await renderPage();
    await userEvent.selectOptions(screen.getByLabelText(messages.mealPlans.diet), 'custom');
    await userEvent.click(screen.getByRole('radio', { name: messages.profile.customWayPerKg }));
    await typeIn(messages.profile.perKgProtein, '3');

    // 960 kcal is 43 % of the profile's 2209: it fits there, and the profile keeps it; at 1500 the plan holds it.
    expect(screen.queryByText(/goes past the limits of a split: the plan holds/)).toBeNull();
    await userEvent.type(screen.getByLabelText(messages.mealPlans.calorieTarget), '1500');
    expect(
      screen.getByText(/the plan holds protein at the limit, 169[ \u00a0]g a day\./),
    ).toBeInTheDocument();
  });

  it('names the custom diet of a profile that sets protein per kilogram by its grams and its share of fat', async () => {
    profile.customMacroSplit = { protein: 23, fat: 30, carbs: 47 };
    profile.customProteinPerKg = 1.6;
    await renderPage();

    expect(
      screen.getByRole('option', { name: spaced('Custom (1.6 g of protein per kg, 30% fat)') }),
    ).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText(messages.mealPlans.diet), 'custom');
    expect(screen.queryByLabelText(messages.profile.perKgProtein)).toBeNull();
  });

  it('offers the custom diet to a profile that has said its split, names the split, and asks for the diet', async () => {
    profile.customMacroSplit = { protein: 30, fat: 40, carbs: 30 };
    await renderPage();

    expect(
      screen.getByRole('option', {
        name: spaced('Custom (30% protein, 40% fat, 30% carbohydrate)'),
      }),
    ).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText(messages.mealPlans.diet), 'custom');

    expect(await sent()).toMatchObject({ dietType: 'custom' });
  });

  it("warns about the diet and the meals the form names, not the profile's, and says of each diet what the catalogue has for it", async () => {
    const supply = aSupply();
    supply.keto['4'] = { level: 'none', recipes: 0, fewerMeals: 3 };
    supply.low_carb['4'] = { level: 'thin', recipes: 2, fewerMeals: 3 };
    await renderPage(supply);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('option', { name: 'Keto (no recipes yet)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Low carb (few recipes)' })).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText(messages.mealPlans.diet), 'keto');
    expect(screen.getByRole('status').textContent).toContain(
      'no plan can be made: choose another diet, or no more than 3 meals a day.',
    );

    // Three meals a day, and the same diet has enough.
    await userEvent.selectOptions(screen.getByLabelText(messages.mealPlans.mealsPerDay), '3');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('fills a day from a favourite set: its recipes for the meals the day has are locked before the plan is made', async () => {
    favoriteSets = [
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        profileId: profile.id,
        label: 'Workday',
        slots: { breakfast: 'r-breakfast', dinner: 'r-dinner', second_breakfast: 'r-second' },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    await renderPage();
    await userEvent.click(screen.getByText(messages.mealPlans.advanced.toggle));
    const firstDay = (await screen.findAllByLabelText(messages.mealPlans.advanced.favoriteSet))[0]!;

    await userEvent.selectOptions(firstDay, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

    const { dayOverrides } = (await sent()) as {
      dayOverrides: { date: string; lockedSlots: { mealType: string; recipeId: string }[] }[];
    };
    expect(dayOverrides).toHaveLength(1);
    // The profile eats four meals a day: no second breakfast, so the set's recipe for one is left out.
    expect(dayOverrides[0]!.lockedSlots).toEqual([
      { mealType: 'breakfast', recipeId: 'r-breakfast' },
      { mealType: 'dinner', recipeId: 'r-dinner' },
    ]);
  });

  it('does not offer a set to a profile that has none', async () => {
    await renderPage();
    await userEvent.click(screen.getByText(messages.mealPlans.advanced.toggle));

    expect(screen.queryByLabelText(messages.mealPlans.advanced.favoriteSet)).toBeNull();
  });

  it('says that an empty field for the repeats of a recipe adds no limit, where the operator set no number', async () => {
    await renderPage();
    await userEvent.click(screen.getByText(messages.mealPlans.advanced.toggle));

    const field = screen.getByLabelText(messages.mealPlans.advanced.varietyFloor);
    expect(field).not.toHaveAttribute('placeholder');
    expect(screen.getByText(/Leave blank for no extra limit\.$/)).toBeInTheDocument();
    expect(screen.getByText(/Blank = no extra limit\.$/)).toBeInTheDocument();
  });

  it('says the number the operator set for the repeats of a recipe, and sends none of its own: the server applies it', async () => {
    await renderPage(aSupply(), [], 'none', {
      plans: { ...aPublicConfig().plans, maxRepeatsPerRecipe: 3 },
    });
    await userEvent.click(screen.getByText(messages.mealPlans.advanced.toggle));

    const field = screen.getByLabelText(messages.mealPlans.advanced.varietyFloor);
    expect(field).toHaveAttribute('placeholder', '3');
    expect(field).toHaveValue(null);
    expect(
      screen.getByText(/Left blank, the number set for this instance applies: 3\.$/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Blank = 3, the number set for this instance\.$/)).toBeInTheDocument();
    expect((await sent()).maxRepeatsPerRecipe).toBeUndefined();
  });
});

describe('the calendar on the plan page', () => {
  beforeEach(() => {
    onTheDay('2026-01-05');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const texts = messages.mealPlans;
  /** The requests for the list of plans, in order. */
  const listsAsked = (): string[] =>
    vi
      .mocked(api.get)
      .mock.calls.map(([path]) => path)
      .filter((path) => path.startsWith('/meal-plans?'));

  it('asks for the month it is for the profile whose plans the page shows', async () => {
    await renderPage(aSupply(), [aPlan()]);

    expect(await screen.findByRole('grid', { name: 'January 2026' })).toBeInTheDocument();
    expect(vi.mocked(api.get)).toHaveBeenCalledWith(
      `/meal-plans/calendar?profileId=${profile.id}&from=2025-12-29&to=2026-02-01`,
    );
  });

  it('opens the plan of a day that is chosen, with the list narrowed to the plans of that day, and goes to the day', async () => {
    const plan = aPlan();
    await renderPage(aSupply(), [plan]);

    await userEvent.click(
      await screen.findByRole('button', { name: /^Mon, Jan 5: 230\sof 2000\skcal/ }),
    );

    await vi.waitFor(() =>
      expect(listsAsked().at(-1)).toBe(
        `/meal-plans?profileId=${profile.id}&page=1&from=2026-01-05&to=2026-01-05`,
      ),
    );
    expect(vi.mocked(api.get)).toHaveBeenCalledWith(`/meal-plans/${plan.id}`);
    // The plan is open, and the reader is at the day that was chosen.
    await vi.waitFor(() =>
      expect(document.getElementById(`plan-${plan.id}-2026-01-05`)).toHaveFocus(),
    );
    expect(screen.getByLabelText(texts.from)).toHaveValue('2026-01-05');
    expect(screen.getByLabelText(texts.to)).toHaveValue('2026-01-05');
  });

  it('takes a day without a plan as the day the next plan begins on, and puts the reader at the form', async () => {
    await renderPage(aSupply(), [aPlan()]);
    const startDate = screen.getByLabelText(texts.startDate);
    expect(startDate).toHaveValue('2026-01-05');
    expect(startDate).not.toBeVisible();

    await userEvent.click(await screen.findByRole('button', { name: /^Fri, Jan 9: no plan/ }));

    expect(startDate).toHaveValue('2026-01-09');
    expect(startDate).toBeVisible();
    expect(startDate).toHaveFocus();
    expect(listsAsked()).toEqual([
      `/meal-plans?profileId=${profile.id}&page=1`,
      `/meal-plans?profileId=${profile.id}&from=2026-01-09&to=2026-01-15`,
    ]);
  });
});

describe('the plan page, on a plan taken out of the application', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const texts = messages.mealPlans.export;
  /** The page with the one plan open. */
  async function anOpenPlan() {
    await renderPage(aSupply(), [aPlan()]);
    await userEvent.click(await screen.findByText('1-day plan · Vegan'));
    await screen.findByText('Mon, Jan 5');
  }

  it('saves the plan as a table of its meals, under the days it is for', async () => {
    const saved = vi.spyOn(files, 'saveText').mockImplementation(() => undefined);
    await anOpenPlan();

    await userEvent.click(screen.getByRole('button', { name: texts.csv }));

    const [file, name, type] = saved.mock.calls[0]!;
    expect(name).toBe('meal-plan-2026-01-05_2026-01-05.csv');
    expect(type).toBe('text/csv');
    expect(file.slice(1).split('\r\n')).toEqual([
      'Date,Meal,Dish,Servings,kcal,Protein (g),Fat (g),Carbohydrate (g),Eaten',
      '2026-01-05,Breakfast,Oat porridge,1,230,8,4,40,No',
      '',
    ]);
  });

  it('hands the printer a sheet of the plan alone, and takes it away when the browser is done', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    await anOpenPlan();
    expect(document.querySelector('.print-sheet')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: texts.print }));

    const sheet = await vi.waitFor(() => {
      const shown = document.querySelector('.print-sheet');
      expect(shown).not.toBeNull();
      return shown as HTMLElement;
    });
    // Beside the application, not inside it: the styles for the printer hide everything else of the page.
    expect(sheet.parentElement).toBe(document.body);
    expect(within(sheet).getByRole('heading', { level: 1 })).toHaveTextContent(
      /^Meal plan, Jan 5.*2026 · Vegan$/,
    );
    expect(within(sheet).getByRole('heading', { level: 2 })).toHaveTextContent(
      'Mon, Jan 5230 of 2000 kcal',
    );
    expect(
      within(sheet)
        .getAllByRole('row')
        .map((row) => row.textContent),
    ).toEqual([
      'MealDishServingskcalProtein (g)Fat (g)Carbohydrate (g)',
      'BreakfastOat porridge12308440',
    ]);
    expect(print).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event('afterprint'));

    await vi.waitFor(() => expect(document.querySelector('.print-sheet')).toBeNull());
  });
});

describe('the plan page, on what the planner proposes for a plan', () => {
  beforeEach(() => {
    onTheDay('2026-01-05');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    address.search = '';
  });

  const chicken = {
    ingredientId: '66666666-6666-4666-8666-666666666666',
    name: 'Chicken breast',
    unit: 'g',
    packSize: 500,
    packs: 1,
    left: 350,
    date: '2026-01-05',
    until: '2026-01-07',
    forThePantry: true,
    inPantry: false,
    wasted: true,
  } as const;
  const opened = async (plan: MealPlan, aiMode: 'none' | 'admin' = 'none') => {
    await renderPage(aSupply(), [plan], aiMode);
    await userEvent.click(await screen.findByText('1-day plan · Vegan'));
    await screen.findByRole('button', { name: 'Oat porridge' });
  };

  it('offers other ways to fill a day in a window of its own, asked of the API for that day of that plan', async () => {
    const plan = aPlan();
    await opened(plan);
    const post = vi.spyOn(api, 'post').mockResolvedValue({
      date: '2026-01-05',
      calorieTarget: 2000,
      diary: null,
      cooking: null,
      current: {
        dayNutrition: plan.days[0]!.dayNutrition,
        packs: { bought: 0, used: 0, wasted: 0 },
      },
      variations: [],
      aiMeta: null,
    } as never);

    await unfoldDay();
    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.otherWays }));

    const dialog = within(
      await screen.findByRole('dialog', { name: 'Other ways to fill Mon, Jan 5' }),
    );
    expect(post).toHaveBeenCalledWith(
      `/meal-plans/${plan.id}/days/${plan.days[0]!.id}/variations`,
      { weigh: false },
    );
    expect(await dialog.findByText(messages.mealPlans.variations.none)).toBeInTheDocument();
  });

  it('offers no other ways for a day the user skips, and its settings still', async () => {
    // The day is today: a day gone by has no changes at all.
    onTheDay('2026-01-05');
    const plan = aPlan();
    await renderPage(aSupply(), [
      { ...plan, days: [{ ...plan.days[0]!, skipped: true, meals: [] }] },
    ]);
    await userEvent.click(await screen.findByText('1-day plan · Vegan'));
    await screen.findByText(messages.mealPlans.daySkipped);
    await unfoldDay();

    expect(screen.queryByRole('button', { name: messages.mealPlans.otherWays })).toBeNull();
    expect(
      screen.getByRole('button', { name: messages.mealPlans.daySettingsButton }),
    ).toBeVisible();
  });

  it('offers, with the packs a plan leaves more than a fifth of, to look for what would use them up', async () => {
    const plan = aPlan({
      packs: {
        bought: 500,
        used: 150,
        open: [chicken],
        frozen: [],
        staysFrozen: [],
        fromFreezer: [],
      },
    });
    await opened(plan);
    const post = vi
      .spyOn(api, 'post')
      .mockResolvedValue({ revision: 0, suggestions: [], aiMeta: null } as never);

    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.useUp.ask }));

    expect(post).toHaveBeenCalledWith(`/meal-plans/${plan.id}/use-up`, { weigh: false });
    expect(await screen.findByText(messages.mealPlans.useUp.none)).toBeInTheDocument();
  });

  it('does not offer that for a plan whose packs are used well enough', async () => {
    await opened(
      aPlan({
        packs: {
          bought: 500,
          used: 480,
          open: [{ ...chicken, left: 20, wasted: false }],
          frozen: [],
          staysFrozen: [],
          fromFreezer: [],
        },
      }),
    );

    expect(screen.queryByRole('button', { name: messages.mealPlans.useUp.ask })).toBeNull();
  });

  it('opens on the plan a link names, with the list narrowed to the day the link names', async () => {
    const plan = aPlan();
    address.search = `plan=${plan.id}&day=2026-01-05`;
    const get = vi.spyOn(api, 'get');

    await renderPage(aSupply(), [plan]);

    // The plan is open without a click, and was read whole.
    expect(await screen.findByRole('button', { name: 'Oat porridge' })).toBeInTheDocument();
    expect(
      get.mock.calls.some(
        ([path]) =>
          String(path).startsWith('/meal-plans?') &&
          String(path).includes('from=2026-01-05') &&
          String(path).includes('to=2026-01-05'),
      ),
    ).toBe(true);
  });

  it.each([
    ['the diary', '&from=diary', 1],
    ['elsewhere', '', 0],
  ])(
    'opens the window of the meal a link from %s names, and goes back on closing it only to the diary',
    async (_from, from, backs) => {
      const plan = aPlan();
      const meal = plan.days[0]!.meals[0]!;
      address.search = `plan=${plan.id}&day=2026-01-05&meal=${meal.id}${from}`;
      const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});

      await renderPage(aSupply(), [plan]);

      const opened = await screen.findByRole('dialog', { name: messages.recipeModal.title });
      await userEvent.click(
        within(opened).getByRole('button', { name: messages.recipeModal.close }),
      );

      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: messages.recipeModal.title })).toBeNull(),
      );
      expect(back).toHaveBeenCalledTimes(backs);
    },
  );

  it.each([
    ['a plan that is no id', 'plan=..%2Fusers%2Fme&day=2026-01-05'],
    ['a day that is no day', 'plan=11111111-1111-4111-8111-111111111111&day=tomorrow'],
    ['a plan without a day', 'plan=11111111-1111-4111-8111-111111111111'],
  ])('takes no notice of a link that names %s', async (_what, search) => {
    address.search = search;
    const get = vi.spyOn(api, 'get');

    await renderPage(aSupply(), [aPlan()]);

    await screen.findByText('1-day plan · Vegan');
    expect(screen.queryByRole('button', { name: 'Oat porridge' })).toBeNull();
    expect(
      get.mock.calls.some(
        ([path]) => String(path).includes('users') && String(path).includes('meal-plans'),
      ),
    ).toBe(false);
  });
});

describe('the plan page, on the day it is today', () => {
  const scrollIntoView = vi.fn();
  beforeEach(() => {
    // The browser of the tests draws nothing, so it has nothing to scroll.
    Element.prototype.scrollIntoView = scrollIntoView;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    scrollIntoView.mockClear();
    delete (Element.prototype as Partial<Element>).scrollIntoView;
  });

  /** The plan of the fixture over three days from 2026-01-04, its one day on each of them. */
  const threeDays = (): MealPlan => {
    const plan = aPlan();
    const day = plan.days[0]!;
    const dates = ['2026-01-04', '2026-01-05', '2026-01-06'];
    return {
      ...plan,
      startDate: dates[0]!,
      durationDays: dates.length,
      days: dates.map((date, n) => ({
        ...day,
        id: `22222222-2222-4222-8222-22222222222${n}`,
        date,
        meals: day.meals.map((meal) => ({
          ...meal,
          id: `33333333-3333-4333-8333-33333333333${n}`,
        })),
      })),
    };
  };

  const open = async (plan: MealPlan) => {
    await renderPage(aSupply(), [plan]);
    await userEvent.click(await screen.findByText('3-day plan · Vegan'));
  };

  it('marks the day that is today, and takes the reader there with one press', async () => {
    onTheDay('2026-01-05');
    const plan = threeDays();
    await open(plan);

    const today = document.getElementById(dayAnchor(plan.id, '2026-01-05'))!;
    expect(today).toHaveAttribute('aria-current', 'date');
    expect(within(today).getByText(messages.mealPlans.today)).toBeInTheDocument();
    expect(screen.getAllByText(messages.mealPlans.today)).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.goToToday }));

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(today);
    expect(today).toHaveFocus();
  });

  it('offers no way to today on a plan that does not hold it', async () => {
    onTheDay('2026-02-01');
    await open(threeDays());

    expect(screen.queryByRole('button', { name: messages.mealPlans.goToToday })).toBeNull();
    expect(screen.queryByText(messages.mealPlans.today)).toBeNull();
  });
});

describe('the plan page, on how a plan reads', () => {
  const scrollIntoView = vi.fn();
  beforeEach(() => {
    // The browser of the tests draws nothing, so it has nothing to scroll.
    Element.prototype.scrollIntoView = scrollIntoView;
    address.search = '';
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    scrollIntoView.mockClear();
    address.search = '';
    delete (Element.prototype as Partial<Element>).scrollIntoView;
  });

  /** The plan of the fixture over `count` days from 2026-01-05, its one meal on each of them. */
  const daysLong = (count: number): MealPlan => {
    const plan = aPlan();
    const day = plan.days[0]!;
    const numbered = (n: number): string => String(n).padStart(2, '0');
    return {
      ...plan,
      durationDays: count,
      days: Array.from({ length: count }, (_, n) => ({
        ...day,
        id: `22222222-2222-4222-8222-2222222222${numbered(n)}`,
        date: `2026-01-${numbered(5 + n)}`,
        meals: day.meals.map((meal) => ({
          ...meal,
          id: `33333333-3333-4333-8333-3333333333${numbered(n)}`,
        })),
      })),
    };
  };
  const open = async (plan: MealPlan) => {
    await renderPage(aSupply(), [plan]);
    await userEvent.click(await screen.findByText(`${plan.durationDays}-day plan · Vegan`));
    await screen.findAllByRole('button', { name: messages.mealPlans.addCustomMeal });
  };
  const dayOf = (plan: MealPlan, date: string): HTMLElement =>
    document.getElementById(dayAnchor(plan.id, date))!;
  const headOf = (plan: MealPlan, date: string): HTMLElement =>
    within(dayOf(plan, date)).getByRole('button', { name: /kcal/ });
  const weekTab = (week: number): HTMLElement => screen.getByRole('tab', { name: `Week ${week}` });
  /** What the API offers in the place of a meal. */
  const anOffer = {
    recipe: { id: 'a-recipe', title: 'Tofu scramble' },
    servings: 1,
    revision: 0,
    before: { calories: 230, protein: 8, fat: 4, carbs: 40 },
    after: { calories: 240, protein: 18, fat: 12, carbs: 16 },
    dayAfter: { calories: 240, protein: 18, fat: 12, carbs: 16 },
    targetMacros: { protein: 100, fat: 60, carbs: 250 },
    cooking: null,
    outsideLimits: [],
    calorieTarget: 2000,
  };

  it("shows each day by its head, with today's alone unfolded, and any number of days may be", async () => {
    onTheDay('2026-01-06');
    const plan = daysLong(3);
    await open(plan);

    expect(headOf(plan, '2026-01-05')).toHaveAttribute('aria-expanded', 'false');
    expect(headOf(plan, '2026-01-05')).toHaveTextContent('Mon, Jan 5');
    expect(headOf(plan, '2026-01-05')).toHaveTextContent('230 / 2000 kcal');
    expect(headOf(plan, '2026-01-06')).toHaveAttribute('aria-expanded', 'true');
    expect(within(dayOf(plan, '2026-01-05')).queryByRole('list')).toBeNull();
    expect(within(dayOf(plan, '2026-01-06')).getByRole('list')).toBeInTheDocument();

    await userEvent.click(headOf(plan, '2026-01-05'));

    expect(within(dayOf(plan, '2026-01-05')).getByRole('list')).toBeInTheDocument();
    expect(within(dayOf(plan, '2026-01-06')).getByRole('list')).toBeInTheDocument();

    await userEvent.click(headOf(plan, '2026-01-06'));

    expect(headOf(plan, '2026-01-06')).toHaveAttribute('aria-expanded', 'false');
    expect(within(dayOf(plan, '2026-01-06')).queryByRole('list')).toBeNull();
  });

  it('unfolds the first day of a plan that does not hold today', async () => {
    onTheDay('2026-03-01');
    const plan = daysLong(3);
    await open(plan);

    expect(headOf(plan, '2026-01-05')).toHaveAttribute('aria-expanded', 'true');
    expect(headOf(plan, '2026-01-06')).toHaveAttribute('aria-expanded', 'false');
  });

  it('says on the head of a folded day that it holds what the profile has ruled out', async () => {
    onTheDay('2026-03-01');
    const plan = daysLong(2);
    const day = plan.days[1]!;
    plan.days[1] = {
      ...day,
      meals: day.meals.map((meal) => ({ ...meal, restrictionConflicts: ['allergen'] })),
    };
    await open(plan);

    expect(headOf(plan, '2026-01-06')).toHaveAttribute('aria-expanded', 'false');
    expect(headOf(plan, '2026-01-06')).toHaveTextContent(messages.mealPlans.dayToCheck);
    expect(headOf(plan, '2026-01-05')).not.toHaveTextContent(messages.mealPlans.dayToCheck);
  });

  it('shows a plan of a week whole', async () => {
    onTheDay('2026-01-05');
    const plan = daysLong(7);
    await open(plan);

    expect(screen.queryByRole('tablist')).toBeNull();
    expect(dayOf(plan, '2026-01-11')).toBeVisible();
  });

  it('shows a longer plan a week at a time, on the week that holds today', async () => {
    onTheDay('2026-01-13');
    const plan = daysLong(15);
    await open(plan);

    expect(screen.getByRole('tablist', { name: messages.mealPlans.planWeeks })).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    expect(weekTab(2)).toHaveAttribute('aria-selected', 'true');
    expect(dayOf(plan, '2026-01-05')).toBeNull();
    expect(headOf(plan, '2026-01-13')).toHaveAttribute('aria-expanded', 'true');

    await userEvent.click(weekTab(1));

    expect(dayOf(plan, '2026-01-13')).not.toBeVisible();
    expect(headOf(plan, '2026-01-05')).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(weekTab(3));

    expect(
      within(screen.getByRole('tabpanel', { name: 'Week 3' })).getByText('Mon, Jan 19'),
    ).toBeVisible();
  });

  it('goes to today from another week, with the week and the day opened', async () => {
    onTheDay('2026-01-13');
    const plan = daysLong(14);
    await open(plan);
    await userEvent.click(headOf(plan, '2026-01-13'));
    await userEvent.click(weekTab(1));
    scrollIntoView.mockClear();

    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.goToToday }));

    expect(weekTab(2)).toHaveAttribute('aria-selected', 'true');
    expect(headOf(plan, '2026-01-13')).toHaveAttribute('aria-expanded', 'true');
    expect(dayOf(plan, '2026-01-13')).toBeVisible();
    expect(dayOf(plan, '2026-01-13')).toHaveFocus();
    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(scrollIntoView.mock.contexts[0]).toBe(dayOf(plan, '2026-01-13'));
  });

  it('opens the week and the day a link names, and goes there once', async () => {
    onTheDay('2026-03-01');
    const plan = daysLong(14);
    address.search = `plan=${plan.id}&day=2026-01-15`;
    await renderPage(aSupply(), [plan]);
    await screen.findAllByRole('button', { name: messages.mealPlans.addCustomMeal });

    expect(weekTab(2)).toHaveAttribute('aria-selected', 'true');
    expect(headOf(plan, '2026-01-15')).toHaveAttribute('aria-expanded', 'true');
    expect(dayOf(plan, '2026-01-15')).toHaveFocus();
    expect(scrollIntoView).toHaveBeenCalledOnce();

    await userEvent.click(weekTab(1));

    expect(weekTab(1)).toHaveAttribute('aria-selected', 'true');
    expect(scrollIntoView).toHaveBeenCalledOnce();
  });

  it('takes no notice of a link to a day the plan does not hold', async () => {
    onTheDay('2026-03-01');
    const plan = daysLong(3);
    address.search = `plan=${plan.id}&day=2026-02-20`;
    await renderPage(aSupply(), [plan]);
    await screen.findAllByRole('button', { name: messages.mealPlans.addCustomMeal });

    expect(headOf(plan, '2026-01-05')).toHaveAttribute('aria-expanded', 'true');
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('folds the ways to change a meal behind one button, and folds them again once the meal is changed', async () => {
    onTheDay('2026-01-05');
    const plan = daysLong(1);
    await open(plan);
    const change = screen.getByRole('button', { name: ofAMeal(messages.mealPlans.changeMeal) });

    expect(change).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: ofAMeal(messages.mealPlans.swap) })).toBeNull();

    await userEvent.click(change);

    expect(change).toHaveAttribute('aria-expanded', 'true');
    vi.spyOn(api, 'post')
      .mockResolvedValueOnce(anOffer as never)
      .mockResolvedValue({ plan, rebalance: null } as never);
    await userEvent.click(screen.getByRole('button', { name: ofAMeal(messages.mealPlans.swap) }));
    await userEvent.click(
      await screen.findByRole('button', { name: messages.mealPlans.offerTake }),
    );

    await vi.waitFor(() => expect(change).toHaveAttribute('aria-expanded', 'false'));
    expect(screen.queryByRole('button', { name: ofAMeal(messages.mealPlans.swap) })).toBeNull();
  });

  describe('once a meal was changed', () => {
    const rowOf = (plan: MealPlan): HTMLElement =>
      document.getElementById(`meal-${plan.days[0]!.meals[0]!.id}`)!;
    const placedAt = (top: number, bottom: number) =>
      vi
        .spyOn(Element.prototype, 'getBoundingClientRect')
        .mockReturnValue({ top, bottom } as DOMRect);
    const markEaten = async (plan: MealPlan) => {
      const patch = vi.spyOn(api, 'patch').mockResolvedValue({ plan, rebalance: null } as never);
      await userEvent.click(
        screen.getByRole('checkbox', { name: ofAMeal(messages.mealPlans.markEaten) }),
      );
      await vi.waitFor(() => expect(patch).toHaveBeenCalled());
    };

    it('leaves the view alone where the meal is still on the screen', async () => {
      onTheDay('2026-01-05');
      const plan = daysLong(1);
      await open(plan);
      placedAt(100, 200);

      await markEaten(plan);
      await vi.waitFor(() => expect(rowOf(plan)).toBeInTheDocument());
      await new Promise((settled) => setTimeout(settled, 50));

      expect(scrollIntoView).not.toHaveBeenCalled();
    });

    it.each([
      ['above', -300, -200],
      ['below', 900, 1000],
    ])('brings it back where it has gone %s the screen', async (_where, top, bottom) => {
      onTheDay('2026-01-05');
      const plan = daysLong(1);
      await open(plan);
      placedAt(top, bottom);

      await markEaten(plan);

      await vi.waitFor(() => expect(scrollIntoView).toHaveBeenCalledOnce());
      expect(scrollIntoView.mock.contexts[0]).toBe(rowOf(plan));
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
    });

    it('gives the focus to the meal where what was pressed went with the change', async () => {
      onTheDay('2026-01-05');
      const plan = daysLong(1);
      await open(plan);
      placedAt(100, 200);
      vi.spyOn(api, 'post')
        .mockResolvedValueOnce(anOffer as never)
        .mockResolvedValue({ plan, rebalance: null } as never);
      await unfoldMeal();
      await userEvent.click(screen.getByRole('button', { name: ofAMeal(messages.mealPlans.swap) }));

      await userEvent.click(
        await screen.findByRole('button', { name: messages.mealPlans.offerTake }),
      );

      await vi.waitFor(() => expect(rowOf(plan)).toHaveFocus());
      expect(scrollIntoView).not.toHaveBeenCalled();
    });

    it('leaves the focus where it is otherwise', async () => {
      onTheDay('2026-01-05');
      const plan = daysLong(1);
      await open(plan);
      placedAt(100, 200);

      await markEaten(plan);
      const change = screen.getByRole('checkbox', { name: ofAMeal(messages.mealPlans.markEaten) });
      change.focus();
      await new Promise((settled) => setTimeout(settled, 50));

      expect(change).toHaveFocus();
    });

    it('does not move for an offer that was refused', async () => {
      onTheDay('2026-01-05');
      const plan = daysLong(1);
      await open(plan);
      placedAt(-300, -200);
      vi.spyOn(api, 'post').mockRejectedValue(new ApiClientError(500, 'INTERNAL', 'x'));

      await unfoldMeal();
      await userEvent.click(screen.getByRole('button', { name: ofAMeal(messages.mealPlans.swap) }));
      await new Promise((settled) => setTimeout(settled, 50));

      expect(scrollIntoView).not.toHaveBeenCalled();
    });
  });

  describe('of the form for a new plan', () => {
    const head = (): HTMLElement => screen.getByRole('button', { name: /^Make a plan for / });

    it('is open where the profile has no plan', async () => {
      await renderPage();

      expect(head()).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByRole('button', { name: messages.mealPlans.generateButton })).toBeVisible();
    });

    it('is folded where it has one, and keeps what was typed when it is folded again', async () => {
      await renderPage(aSupply(), [aPlan()]);

      expect(head()).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByRole('button', { name: messages.mealPlans.generateButton })).toBeNull();

      await userEvent.click(head());
      await userEvent.type(screen.getByLabelText(messages.mealPlans.calorieTarget), '1800');
      await userEvent.click(head());

      expect(screen.queryByRole('button', { name: messages.mealPlans.generateButton })).toBeNull();

      await userEvent.click(head());

      expect(screen.getByLabelText(messages.mealPlans.calorieTarget)).toHaveValue(1800);
    });

    it('is open where a link asks for a new plan, plans or none', async () => {
      address.search = 'new=1';
      await renderPage(aSupply(), [aPlan()]);

      expect(head()).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByRole('button', { name: messages.mealPlans.generateButton })).toBeVisible();
    });

    it('stays folded where only a filter leaves the list without a plan', async () => {
      await renderPage(aSupply(), [aPlan()]);
      const get = vi.mocked(api.get);
      const answers = get.getMockImplementation()!;
      get.mockImplementation((path: string) =>
        path.startsWith('/meal-plans?')
          ? Promise.resolve({ items: [], page: 1, pageSize: 20, total: 0, totalPages: 0 } as never)
          : answers(path),
      );

      await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.statusPast }));
      await screen.findByText(messages.mealPlans.noPlansTitle);

      expect(head()).toHaveAttribute('aria-expanded', 'false');
    });

    it('opens by itself once the last plan is gone', async () => {
      await renderPage(aSupply(), [aPlan()]);
      await userEvent.click(head());
      await userEvent.click(head());
      expect(head()).toHaveAttribute('aria-expanded', 'false');
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      vi.spyOn(api, 'delete').mockResolvedValue(undefined as never);
      const get = vi.mocked(api.get);
      const answers = get.getMockImplementation()!;
      get.mockImplementation((path: string) =>
        path.startsWith('/meal-plans?')
          ? Promise.resolve({ items: [], page: 1, pageSize: 20, total: 0, totalPages: 0 } as never)
          : answers(path),
      );

      await userEvent.click(screen.getByRole('button', { name: messages.common.delete }));

      await vi.waitFor(() => expect(head()).toHaveAttribute('aria-expanded', 'true'));
    });

    it('folds itself once the plan is made, and opens that plan', async () => {
      const plan = aPlan();
      const generate = await renderPage();
      vi.spyOn(api, 'post').mockResolvedValue(plan as never);

      await userEvent.click(generate);

      await vi.waitFor(() => expect(head()).toHaveAttribute('aria-expanded', 'false'));
    });
  });

  describe('of what an action came to', () => {
    it('says it where it is seen, and lets it be closed', async () => {
      onTheDay('2026-01-05');
      const plan = daysLong(1);
      await open(plan);
      vi.spyOn(api, 'post').mockRejectedValue(new ApiClientError(500, 'INTERNAL', 'x'));

      await unfoldMeal();
      await userEvent.click(screen.getByRole('button', { name: ofAMeal(messages.mealPlans.swap) }));

      const said = await screen.findByRole('alert');
      expect(said.closest('.fixed')).not.toBeNull();

      await userEvent.click(screen.getByRole('button', { name: messages.common.close }));

      expect(screen.queryByRole('alert')).toBeNull();
    });
  });
});

describe('the plan page, on a dish cooked for two days and on what a change comes to', () => {
  const MONDAY = '2026-01-05';
  const TUESDAY = '2026-01-06';
  const first = '33333333-3333-4333-8333-333333333333';
  const second = '33333338-3333-4333-8333-333333333333';
  const theDish = aPlan().days[0]!.meals[0]!;

  /** Two days whose breakfast is one dish cooked on the first. */
  const aPairOfDays = (): MealPlan => {
    const plan = aPlan();
    const day = plan.days[0]!;
    return {
      ...plan,
      durationDays: 2,
      options: { ...plan.options, mealPrepFriendly: true },
      days: [
        {
          ...day,
          meals: [
            {
              ...theDish,
              servings: 1,
              ingredients: [
                {
                  ingredientId: '55555555-5555-4555-8555-555555555555',
                  name: 'Rolled oats',
                  quantity: 60,
                  unit: 'g',
                  display: { quantity: 60, unit: 'g' },
                  note: null,
                },
              ],
              cookAhead: 'cook',
              cooking: {
                with: [{ mealId: second, date: TUESDAY, mealType: 'breakfast', eaten: false }],
                ingredients: [
                  {
                    ingredientId: '55555555-5555-4555-8555-555555555555',
                    name: 'Rolled oats',
                    quantity: 130,
                    unit: 'g',
                    display: { quantity: 130, unit: 'g' },
                    note: null,
                  },
                ],
              },
            },
          ],
        },
        {
          ...day,
          id: '22222228-2222-4222-8222-222222222222',
          date: TUESDAY,
          meals: [
            {
              ...theDish,
              id: second,
              servings: 1.25,
              cookAhead: 'cooked',
              cooking: {
                with: [{ mealId: first, date: MONDAY, mealType: 'breakfast', eaten: false }],
                ingredients: [],
              },
            },
          ],
        },
      ],
    };
  };
  const scramble: MealSwapPreview = {
    recipe: {
      ...theDish.recipe!,
      id: '66666666-6666-4666-8666-666666666666',
      title: 'Tofu scramble',
    },
    servings: 1.5,
    before: theDish.nutrition,
    after: { calories: 240, protein: 14, fat: 9, carbs: 26 },
    dayBefore: aPlan().days[0]!.dayNutrition,
    dayAfter: { calories: 1990, protein: 94, fat: 60, carbs: 250 },
    calorieTarget: 2000,
    targetMacros: { protein: 130, fat: 62, carbs: 260, carbsFloor: null },
    cooking: { changes: [{ date: TUESDAY, mealType: 'breakfast' }], stays: [] },
    outsideLimits: [],
    revision: 4,
  };

  beforeEach(() => {
    onTheDay(MONDAY);
    // The page keeps in view what was changed: the test's document has no layout to scroll.
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const opened = async (plan: MealPlan) => {
    await renderPage(aSupply(), [plan]);
    await userEvent.click(await screen.findByText(/-day plan · Vegan/));
    await screen.findAllByRole('button', { name: 'Oat porridge' });
  };
  const askForASwap = async () => {
    await userEvent.click(screen.getAllByRole('button', { name: ofAMeal('Change') })[0]!);
    await userEvent.click(screen.getByRole('button', { name: ofAMeal(messages.mealPlans.swap) }));
    return screen.findByRole('group', { name: messages.mealPlans.offerTitle });
  };
  const post = (result: unknown = { plan: aPairOfDays(), rebalance: null }) =>
    vi
      .spyOn(api, 'post')
      .mockImplementation((path: string) =>
        Promise.resolve((path.endsWith('/preview') ? scramble : result) as never),
      );
  const taken = (spy: ReturnType<typeof post>) =>
    spy.mock.calls.find(([path]) => path === '/meal-plans/swap-meal')?.[1];

  it('says before a swap what else it changes, and sends the change with it', async () => {
    const spy = post();
    await opened(aPairOfDays());

    const offered = await askForASwap();

    expect(plain(offered.textContent)).toContain('This also changes: Tue breakfast.');
    expect(plain(offered.textContent)).toContain('Protein 94 of 130 g');
    await userEvent.click(
      within(offered).getByRole('button', { name: messages.mealPlans.offerTake }),
    );

    await vi.waitFor(() => expect(taken(spy)).toMatchObject({ together: true }));
  });

  it('keeps a swap to this day when that is ticked', async () => {
    const spy = post();
    await opened(aPairOfDays());

    const offered = await askForASwap();
    await userEvent.click(
      within(offered).getByRole('checkbox', { name: messages.mealPlans.cooking.only }),
    );
    expect(plain(offered.textContent)).not.toContain('This also changes');
    await userEvent.click(
      within(offered).getByRole('button', { name: messages.mealPlans.offerTake }),
    );

    await vi.waitFor(() => expect(taken(spy)).toBeDefined());
    expect(taken(spy)).not.toHaveProperty('together');
  });

  it('says of an offer outside a limit which limit that is', async () => {
    vi.spyOn(api, 'post').mockResolvedValue({
      ...scramble,
      outsideLimits: ['cook_time'],
    } as never);
    await opened(aPairOfDays());

    const offered = await askForASwap();

    expect(plain(offered.textContent)).toContain(
      `This recipe is outside a limit: ${messages.mealPlans.limit.cook_time}.`,
    );
  });

  it('says what the day holds after a swap where no portion changed, and takes the swap back on the plan it left', async () => {
    const after = { ...aPairOfDays(), revision: 5 };
    const figures = { calories: 0, protein: 0, fat: 0, carbs: 0 };
    const spy = post({
      plan: after,
      rebalance: {
        scope: 'day',
        feasibility: 'in-window',
        changes: [],
        unabsorbedKcal: 0,
        macrosBefore: figures,
        macrosAfter: figures,
      },
    });
    await opened(aPairOfDays());

    const offered = await askForASwap();
    await userEvent.click(
      within(offered).getByRole('button', { name: messages.mealPlans.offerTake }),
    );

    expect(await screen.findByText(messages.mealPlans.swapDoneTitle)).toBeVisible();
    expect(screen.getByText('The day: 230 of 2000 kcal · protein 8 of 100 g')).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.undoSwap }));

    await vi.waitFor(() =>
      expect(spy).toHaveBeenCalledWith('/meal-plans/swap-meal/undo', {
        planId: after.id,
        revision: 5,
      }),
    );
    await vi.waitFor(() => expect(screen.queryByText(messages.mealPlans.swapDoneTitle)).toBeNull());
  });

  it('opens the meal to cook with the amounts of the whole cooking, and says how far they are from the original', async () => {
    await opened(aPairOfDays());

    await userEvent.click(screen.getAllByRole('button', { name: 'Oat porridge' })[0]!);

    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText(/130/);
    expect(plain(dialog.textContent)).toContain(
      'Below are the amounts for the whole cooking: 2.3 servings. The original recipe makes 1 serving.',
    );
  });

  it('opens the meal eaten from what was cooked with its own amounts', async () => {
    await opened(aPairOfDays());
    await userEvent.click(screen.getByRole('button', { name: /^Tue, Jan 6(?!:)/ }));

    await userEvent.click(screen.getAllByRole('button', { name: 'Oat porridge' })[1]!);

    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText(messages.recipeDetail.ingredients);
    expect(plain(dialog.textContent)).toContain(
      'Below are the amounts for your meal: 1.3 servings. The original recipe makes 1 serving.',
    );
  });

  it('tells where the meal to cook is removed that the next day cooks by itself', async () => {
    await opened(aPairOfDays());

    await userEvent.click(screen.getAllByRole('button', { name: ofAMeal('Change') })[0]!);
    await userEvent.click(
      screen.getAllByRole('button', { name: ofAMeal(messages.mealPlans.remove) })[0]!,
    );

    expect(screen.getByText('On Tuesday you cook this dish separately.')).toBeVisible();
  });

  it('says before a meal is taken off that the shopping list of its day goes out of date, where one covers it', async () => {
    const plan = aPairOfDays();
    await opened({
      ...plan,
      days: plan.days.map((day, index) => ({ ...day, listed: index === 0 })),
    });

    await userEvent.click(screen.getAllByRole('button', { name: ofAMeal('Change') })[0]!);
    await userEvent.click(
      screen.getAllByRole('button', { name: ofAMeal(messages.mealPlans.remove) })[0]!,
    );

    expect(screen.getByText(messages.mealPlans.listOutOfDateDay)).toBeVisible();
  });

  it('brings a meal back to the dish of the day before it was parted from', async () => {
    const plan = aPairOfDays();
    const other = {
      ...plan.days[1]!.meals[0]!,
      cookAhead: null,
      cooking: null,
      recipe: { ...theDish.recipe!, id: '77777777-7777-4777-8777-777777777777', title: 'Toast' },
    };
    const parted: MealPlan = {
      ...plan,
      days: [
        {
          ...plan.days[0]!,
          meals: [{ ...plan.days[0]!.meals[0]!, cookAhead: null, cooking: null }],
        },
        { ...plan.days[1]!, meals: [other] },
      ],
    };
    const spy = post();
    await opened(parted);
    await userEvent.click(screen.getByRole('button', { name: /^Tue, Jan 6(?!:)/ }));

    await userEvent.click(screen.getByRole('button', { name: /^Change: Toast/ }));
    await userEvent.click(screen.getByRole('button', { name: 'The same as Mon' }));

    await vi.waitFor(() =>
      expect(spy).toHaveBeenCalledWith(
        '/meal-plans/swap-meal/preview',
        expect.objectContaining({
          plannedMealId: second,
          strategy: 'favorite',
          favoriteRecipeId: theDish.recipe!.id,
        }),
      ),
    );
  });

  it('keeps the dishes of a day that is over, with what can still be done on it', async () => {
    onTheDay(TUESDAY);
    await opened(aPairOfDays());
    await userEvent.click(screen.getByRole('button', { name: /^Mon, Jan 5(?!:)/ }));

    expect(screen.getByText(messages.mealPlans.dayIsOver)).toBeVisible();
    expect(screen.getAllByRole('button', { name: ofAMeal('Change') })).toHaveLength(1);
    // Today's changes alone: the day that is over has none.
    await unfoldDay();
    expect(screen.getAllByRole('button', { name: messages.mealPlans.otherWays })).toHaveLength(1);
    expect(
      screen.getAllByRole('button', { name: ofAMeal(messages.mealPlans.remove) }).length,
    ).toBeGreaterThan(0);
  });

  it('tells what to do on the second day where the first is over with nothing marked eaten', async () => {
    onTheDay(TUESDAY);
    await opened(aPairOfDays());

    expect(
      screen.getByText(
        'If there was no cooking on Monday, cook today: the amounts are for this meal.',
      ),
    ).toBeVisible();
  });

  it('marks a meal as eaten from its day on, and lets one marked ahead be unmarked', async () => {
    const plan = aPairOfDays();
    plan.days[1]!.meals[0]!.eatenAt = null;
    await opened(plan);
    await userEvent.click(screen.getByRole('button', { name: /^Tue, Jan 6(?!:)/ }));

    const boxes = screen.getAllByRole('checkbox', { name: ofAMeal(messages.mealPlans.markEaten) });
    expect(boxes[0]).toBeEnabled();
    expect(boxes[1]).toBeDisabled();
    expect(boxes[1]).toHaveAttribute('title', messages.mealPlans.eatenAhead);
  });

  it('marks a day whose macronutrients are far from its target, and says so of a plan on average', async () => {
    const plan = aPairOfDays();
    await opened({
      ...plan,
      averageOff: { calories: 'under', macros: true },
      days: [{ ...plan.days[0]!, macrosOff: true }, plan.days[1]!],
    });

    expect(screen.getAllByText(messages.mealPlans.macrosOffChip)).toHaveLength(1);
    expect(screen.getByText(messages.mealPlans.macrosOffHint)).toBeVisible();
    expect(screen.getByText(messages.mealPlans.planAverageUnder)).toBeVisible();
    expect(screen.getByText(messages.mealPlans.planAverageMacros)).toBeVisible();
  });

  it('says what makes a day far from its split: too much of one, too little of another, and each cause', async () => {
    const plan = aPairOfDays();
    await opened({
      ...plan,
      days: [
        {
          ...plan.days[0]!,
          macrosOff: true,
          macrosOffWhy: {
            over: 'fat',
            under: 'protein',
            causes: [
              { kind: 'cookTime', minutes: 15 },
              { kind: 'byHand', count: 2 },
              { kind: 'singleDish', slots: ['lunch', 'dinner'] },
            ],
          },
        },
        plan.days[1]!,
      ],
    });

    expect(await screen.findByText('Too much fat, too little protein.')).toBeVisible();
    expect(
      screen.getByText(
        spaced(
          'A cooking-time limit of 15 min leaves few dishes of this diet. Lengthen it in “Day settings…” or add a meal.',
        ),
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        spaced(
          '2 meals of the day were chosen by hand: a swap, a favourite or a dish off the diet.',
        ),
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        'When the plan was made, only one dish fit lunch, dinner: the exclusions and the diet leave few recipes there.',
      ),
    ).toBeVisible();
    expect(screen.queryByText(messages.mealPlans.macrosOffHint)).toBeNull();
  });

  it('turns the figure of a day red only where the day is off its target', async () => {
    const plan = aPairOfDays();
    await opened({
      ...plan,
      days: [
        { ...plan.days[0]!, calorieDelta: -60, offTarget: null },
        { ...plan.days[1]!, calorieDelta: -300, offTarget: 'under' },
      ],
    });

    const figures = screen.getAllByText(/\/ 2000 kcal/);
    expect(figures[0]).not.toHaveClass('text-destructive');
    expect(figures[1]).toHaveClass('text-destructive');
  });

  it('offers to size the portions of a day off its target that the diary has no part in', async () => {
    const plan = aPairOfDays();
    await opened({
      ...plan,
      days: [{ ...plan.days[0]!, offTarget: 'under', resizes: true }, plan.days[1]!],
    });

    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.dayUnder }));
    expect(
      await screen.findByRole('button', { name: messages.mealPlans.resizeDay }),
    ).toHaveAccessibleDescription(messages.mealPlans.resizeDayNotePlain);
  });

  describe('the form for a new plan', () => {
    const newPlanForm = async (plans: MealPlan[], listed: boolean) => {
      await renderPage(aSupply(), plans);
      if (listed)
        await userEvent.click(await screen.findByRole('button', { name: /^Make a plan for / }));
    };

    it('says that cooking ahead changes nothing on a plan of one day', async () => {
      await newPlanForm([], false);

      await userEvent.click(
        screen.getByRole('checkbox', { name: messages.mealPlans.mealPrepFriendly }),
      );
      expect(screen.queryByText(messages.mealPlans.prepCannotPair)).toBeNull();

      const length = screen.getByLabelText(messages.mealPlans.durationDays);
      await userEvent.clear(length);
      await userEvent.type(length, '1');
      expect(await screen.findByText(messages.mealPlans.prepCannotPair)).toBeVisible();
    });

    it('says what follows from days another plan holds', async () => {
      await newPlanForm([aPlan()], true);

      expect(await screen.findByText(messages.mealPlans.overlapNote)).toBeVisible();
    });
  });
});

describe('the plan page, on a plan made together with another profile', () => {
  const ewa: Profile = { ...profile, id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', name: 'Ewa' };
  const SHARED = '12121212-1212-4212-8212-121212121212';
  const HERS = '13131313-1313-4313-8313-131313131313';
  /** A plan whose one breakfast Ewa's plan holds too, with her portion. */
  const together = (
    over: Partial<MealPlan['days'][number]['meals'][number]['shared']> = {},
  ): MealPlan => {
    const plan = aPlan({
      joint: {
        planId: '14141414-1414-4414-8414-141414141414',
        profileId: ewa.id,
        profileName: 'Ewa',
        cookApart: false,
      },
    });
    const meal = plan.days[0]!.meals[0]!;
    return {
      ...plan,
      days: [
        {
          ...plan.days[0]!,
          meals: [
            {
              ...meal,
              ingredients: meal.recipe!.ingredients.map(
                ({ ingredientId, name, quantity, unit, display, note }) => ({
                  ingredientId,
                  name,
                  quantity,
                  unit,
                  display,
                  note,
                }),
              ),
              shared: {
                id: SHARED,
                apart: false,
                with: {
                  mealId: HERS,
                  planId: '14141414-1414-4414-8414-141414141414',
                  profileName: 'Ewa',
                  servings: 1.1,
                  calories: 540,
                  eaten: false,
                  ingredients: [],
                },
                pot: [
                  {
                    ingredientId: '55555555-5555-4555-8555-555555555555',
                    name: 'Rolled oats',
                    quantity: 126,
                    unit: 'g',
                    display: { quantity: 125, unit: 'g' },
                    note: null,
                  },
                ],
                ...over,
              },
            },
          ],
        },
      ],
    };
  };
  const open = async (plan: MealPlan) => {
    await renderPage(aSupply(), [plan]);
    await userEvent.click(await screen.findByText('1-day plan · Vegan'));
  };

  beforeEach(() => {
    otherProfiles = [ewa];
    onTheDay('2026-01-05');
  });
  afterEach(() => {
    otherProfiles = [];
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('is asked for with the other profile chosen, without settings of its days', async () => {
    const generate = await renderPage(aSupply(), []);
    const post = vi.spyOn(api, 'post').mockResolvedValue(aPlan() as never);

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: messages.mealPlans.jointPlanWith }),
      'Ewa',
    );
    expect(screen.getByText(messages.mealPlans.advanced.perDayJoint)).toBeInTheDocument();
    // The options explain only what the form holds: the days are set in each plan afterwards.
    expect(screen.queryByText(messages.mealPlans.advanced.hint)).not.toBeInTheDocument();
    expect(screen.queryByText(messages.mealPlans.advanced.legendDayKind)).not.toBeInTheDocument();
    expect(screen.queryByText(messages.mealPlans.advanced.perDay)).not.toBeInTheDocument();
    // The dishes both eat are cooked apart unless the box is unticked.
    expect(screen.getByRole('checkbox', { name: messages.mealPlans.jointCookApart })).toBeChecked();
    await userEvent.click(generate);

    const [path, body] = post.mock.calls.at(-1)! as [string, Record<string, unknown>];
    expect(path).toBe('/meal-plans/generate');
    expect(body).toMatchObject({ profileId: profile.id, withProfileId: ewa.id, cookApart: true });
    expect(body.dayOverrides).toBeUndefined();
  });

  it('asks for the dishes both eat in one pot where the box is unticked', async () => {
    const generate = await renderPage(aSupply(), []);
    const post = vi.spyOn(api, 'post').mockResolvedValue(aPlan() as never);

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: messages.mealPlans.jointPlanWith }),
      'Ewa',
    );
    await userEvent.click(
      screen.getByRole('checkbox', { name: messages.mealPlans.jointCookApart }),
    );
    await userEvent.click(generate);

    expect(post.mock.calls.at(-1)![1]).toMatchObject({ withProfileId: ewa.id, cookApart: false });
  });

  it('offers no plan together where the account has one profile', async () => {
    otherProfiles = [];
    await renderPage(aSupply(), []);

    expect(screen.queryByRole('combobox', { name: messages.mealPlans.jointPlanWith })).toBeNull();
  });

  it('marks a meal only this person eats by their name, and one each cooks apart as shared and apart', async () => {
    const plan = together({ apart: true });
    const shared = plan.days[0]!.meals[0]!;
    // A time of day the other person does not have: this person's alone.
    const alone = {
      ...shared,
      id: '15151515-1515-4515-8515-151515151515',
      mealType: 'dinner' as const,
      shared: null,
    };
    plan.days[0]!.meals = [shared, alone];
    await open(plan);

    expect(
      screen.getByText(spaced(messages.mealPlans.sharedApartChip.replaceAll('\u00a0', ' '))),
    ).toBeInTheDocument();
    expect(screen.getByText('Only Me')).toBeInTheDocument();
    expect(screen.queryByText(messages.mealPlans.sharedChip, { exact: true })).toBeNull();
  });

  it('leads to the household list of both plans, which buys the pot of its shared dishes', async () => {
    const plan = together();
    await open(plan);

    expect(screen.getByRole('link', { name: messages.mealPlans.jointList })).toHaveAttribute(
      'href',
      `/shopping-lists?profile=${plan.profileId}&plan=${plan.id}&together=1`,
    );
  });

  it('marks no meal of a plan made alone by anyone’s name', async () => {
    await renderPage(aSupply(), [aPlan()]);
    await userEvent.click(await screen.findByText('1-day plan · Vegan'));

    expect(screen.queryByText(/^Only /)).toBeNull();
    expect(screen.queryByText(messages.mealPlans.sharedChip)).toBeNull();
  });

  it('says whose plan it was made with, marks a shared meal as one, and marks it eaten for both from its changes', async () => {
    const plan = together();
    await open(plan);
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({ plan, rebalance: null } as never);

    expect(screen.getByText('Planned together with: Ewa')).toBeInTheDocument();
    expect(screen.getByText(messages.mealPlans.sharedChip)).toBeInTheDocument();
    // The other person's portion is in the meal's window, not on its card.
    expect(screen.queryByText(spaced('Ewa: 1.1 servings · 540 kcal'))).toBeNull();
    await unfoldMeal();
    await userEvent.click(
      screen.getByRole('button', { name: ofAMeal(messages.mealPlans.eatenTogether) }),
    );

    expect(patch).toHaveBeenCalledWith(
      `/meal-plans/${plan.id}/meals/${plan.days[0]!.meals[0]!.id}/eaten`,
      {
        eaten: true,
        forAll: true,
      },
    );
  });

  it("offers, once a shared meal is eaten by both, both people's portions at once, and takes both on one press", async () => {
    const plan = together();
    await open(plan);
    const mine = `/meal-plans/${plan.id}/meals/${plan.days[0]!.meals[0]!.id}`;
    const oats = (grams: number) => ({
      ingredientId: '55555555-5555-4555-8555-555555555555',
      name: 'Rolled oats',
      eaten: { quantity: grams, unit: 'g' },
      held: { quantity: 500, unit: 'g' },
      taken: { quantity: grams, unit: 'g' },
      borrowed: null,
    });
    const read = vi.mocked(api.get).getMockImplementation()!;
    vi.mocked(api.get).mockImplementation((asked: string) =>
      asked === `${mine}/pantry/both`
        ? Promise.resolve([
            { profileName: 'Me', offer: [oats(60)], taken: [] },
            { profileName: 'Ewa', offer: [oats(66)], taken: [] },
          ] as never)
        : read(asked),
    );
    vi.spyOn(api, 'patch').mockResolvedValue({ plan, rebalance: null } as never);
    const post = vi.spyOn(api, 'post').mockResolvedValue({} as never);

    await unfoldMeal();
    await userEvent.click(
      screen.getByRole('button', { name: ofAMeal(messages.mealPlans.eatenTogether) }),
    );

    const dialog = within(
      await screen.findByRole('dialog', { name: messages.eatenPantry.takeTitle }),
    );
    expect(dialog.getByText(messages.eatenPantry.byPerson)).toBeInTheDocument();
    expect(dialog.getByRole('heading', { name: 'Ewa' })).toBeInTheDocument();
    expect(
      dialog.getByText(spaced('eaten 66 g · in the pantry 500 g · you take 66 g')),
    ).toBeInTheDocument();
    await userEvent.click(dialog.getByRole('button', { name: messages.eatenPantry.take }));

    await waitFor(() => expect(post).toHaveBeenCalledWith(`${mine}/pantry-take/both`));
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('says how a shared meal is cooked when the box is ticked', async () => {
    const plan = together();
    await open(plan);
    const patch = vi.spyOn(api, 'patch').mockResolvedValue(plan as never);

    await unfoldMeal();
    await userEvent.click(screen.getByRole('checkbox', { name: messages.mealPlans.cookApart }));

    expect(patch).toHaveBeenCalledWith(`/meal-plans/${plan.id}/shared-meals/${SHARED}`, {
      apart: true,
    });
  });

  it('says how the dishes both eat are cooked from today for the whole plan, and on one day', async () => {
    const plan = together();
    await open(plan);
    const patch = vi.spyOn(api, 'patch').mockResolvedValue(plan as never);

    await userEvent.click(
      screen.getByRole('checkbox', { name: messages.mealPlans.jointCookApart }),
    );
    expect(patch).toHaveBeenCalledWith(`/meal-plans/${plan.id}/cook-apart`, { apart: true });

    // The day's shared dish is cooked in one pot: the day offers to cook its shared dishes apart.
    await unfoldDay();
    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.dayCookApart }));
    expect(patch).toHaveBeenLastCalledWith(`/meal-plans/${plan.id}/cook-apart`, {
      apart: true,
      date: plan.days[0]!.date,
    });
  });

  it('asks another dish for both, and for this one alone when the offer is turned to it', async () => {
    const plan = together();
    await open(plan);
    const offered = {
      recipe: {
        ...plan.days[0]!.meals[0]!.recipe!,
        id: '66666666-6666-4666-8666-666666666666',
        title: 'Tofu scramble',
      },
      servings: 1,
      before: plan.days[0]!.meals[0]!.nutrition,
      after: plan.days[0]!.meals[0]!.nutrition,
      dayAfter: plan.days[0]!.dayNutrition,
      calorieTarget: 2000,
      targetMacros: plan.days[0]!.targetMacros,
      cooking: null,
      outsideLimits: [],
      revision: 0,
    };
    const post = vi.spyOn(api, 'post').mockResolvedValue(offered as never);

    await unfoldMeal();
    await userEvent.click(screen.getByRole('button', { name: ofAMeal(messages.mealPlans.swap) }));
    await screen.findByRole('group', { name: messages.mealPlans.offerTitle });
    expect(post.mock.calls[0]![1]).toMatchObject({ forAll: true });

    await userEvent.click(screen.getByRole('radio', { name: messages.mealPlans.offerForMe }));
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1]![1]).not.toHaveProperty('forAll');
    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.offerTake }));

    expect(post.mock.calls[2]![0]).toBe('/meal-plans/swap-meal');
    expect(post.mock.calls[2]![1]).not.toHaveProperty('forAll');
  });

  it('takes a shared meal off both days, or off its own alone', async () => {
    const plan = together();
    await open(plan);
    const remove = vi.spyOn(api, 'delete').mockResolvedValue({ plan, rebalance: null } as never);

    await unfoldMeal();
    await userEvent.click(screen.getByRole('button', { name: ofAMeal(messages.mealPlans.remove) }));
    expect(screen.getByText('Ewa has this dish in their plan.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.removeForAll }));

    expect(remove).toHaveBeenCalledWith(
      `/meal-plans/${plan.id}/meals/${plan.days[0]!.meals[0]!.id}?forAll=true`,
    );
  });

  it('opens the recipe of a shared dish with what the pot takes and the portions in it', async () => {
    const plan = together();
    await open(plan);

    await userEvent.click(screen.getByRole('button', { name: 'Oat porridge' }));

    const window = within(await screen.findByRole('dialog', { name: messages.recipeModal.title }));
    expect(
      await window.findByText(
        spaced(
          'Below are the amounts for the whole pot: 2.1 servings, of which you 1, Ewa 1.1. The original recipe makes 1 serving.',
        ),
      ),
    ).toBeInTheDocument();
    expect(window.getByText(spaced('125 g'))).toBeInTheDocument();
  });

  describe('served on a plate of each person’s own', () => {
    const line = (ingredientId: string, name: string, grams: number, share?: number) => ({
      ingredientId,
      name,
      quantity: grams,
      unit: 'g' as const,
      display: { quantity: Math.round(grams / 5) * 5, unit: 'g' as const },
      note: null,
      ...(share !== undefined ? { share } : {}),
    });
    const CHICKEN = '56565656-5656-4565-8565-565656565656';
    const RICE = '57575757-5757-4575-8575-575757575757';
    const OIL = '58585858-5858-4585-8585-585858585858';
    /** Chicken and rice: more chicken and less rice on this plate, the other way round on Ewa's; the oil as the recipe has it. */
    const onPlates = (): MealPlan => {
      const plan = together();
      const meal = plan.days[0]!.meals[0]!;
      meal.ingredients = [
        line(CHICKEN, 'Chicken breast', 156, 1.3),
        line(RICE, 'Basmati rice', 48, 0.8),
        line(OIL, 'Olive oil', 10),
      ];
      meal.shared!.with.ingredients = [
        line(CHICKEN, 'Chicken breast', 84, 0.7),
        line(RICE, 'Basmati rice', 72, 1.2),
        line(OIL, 'Olive oil', 15),
      ];
      return plan;
    };

    it('says nothing of the plates on the card: the meal’s window shows them', async () => {
      await open(onPlates());

      expect(screen.queryByText(/^Your plate –/)).toBeNull();
      expect(screen.queryByText(/Basmati rice/)).toBeNull();
    });

    it('shows both plates in the window of a meal each person cooks apart', async () => {
      const plan = onPlates();
      plan.days[0]!.meals[0]!.shared!.apart = true;
      await open(plan);
      await userEvent.click(screen.getByRole('button', { name: 'Oat porridge' }));

      const window = within(
        await screen.findByRole('dialog', { name: messages.recipeModal.title }),
      );
      const table = await window.findByRole('table');
      expect(within(table).getByRole('columnheader', { name: 'Ewa' })).toBeInTheDocument();
      expect(within(table).getByRole('row', { name: /Chicken breast/ })).toBeInTheDocument();
      // Each cooks a plate of their own: every line with both amounts, the oil the recipe's proportion gives as well.
      expect(
        within(within(table).getByRole('row', { name: /Olive oil/ }))
          .getAllByRole('cell')
          .map((cell) => plain(cell.textContent)),
      ).toEqual(['10 g', '15 g']);
      expect(window.getByText(/^Ewa: /)).toBeInTheDocument();
      // Each cooks a portion of their own: there is no pot to split.
      expect(window.getByText(messages.recipeModal.platesApart)).toBeInTheDocument();
      expect(window.queryByText(messages.recipeModal.platesPot, { exact: false })).toBeNull();
      expect(window.queryByText(messages.split.partRisk)).toBeNull();
    });

    it('says nothing of plates where neither differs from the recipe', async () => {
      await open(together());

      expect(screen.queryByText(/^Your plate –/)).toBeNull();
    });

    it('shows both plates in the recipe of the pot, with how to split each part', async () => {
      await open(onPlates());
      await userEvent.click(screen.getByRole('button', { name: 'Oat porridge' }));

      const window = within(
        await screen.findByRole('dialog', { name: messages.recipeModal.title }),
      );
      // The window shows the plates once the recipe has come.
      const table = await window.findByRole('table');
      expect(within(table).getByRole('columnheader', { name: 'Ewa' })).toBeInTheDocument();
      const chicken = within(table).getByRole('row', { name: /Chicken breast/ });
      expect(
        within(chicken)
          .getAllByRole('cell')
          .map((cell) => plain(cell.textContent)),
      ).toEqual(['155 g', '85 g']);
      // In one pot the table holds the lines a plate holds otherwise than the recipe: the oil is split with the pot.
      expect(within(table).queryByRole('row', { name: /Olive oil/ })).toBeNull();
      expect(
        window.getByText(messages.recipeModal.platesPot, { exact: false }),
      ).toBeInTheDocument();
      expect(window.getByText(messages.split.partRisk)).toBeInTheDocument();
    });

    it('splits a part weighed alone by what each plate takes of it', async () => {
      await open(onPlates());
      await userEvent.click(screen.getByRole('button', { name: messages.split.open }));
      const splitting = within(await screen.findByRole('dialog', { name: messages.split.title }));

      // The shares come from the plan, and of one part from what each plate takes of it.
      expect(splitting.getByText(messages.split.planIntroParts)).toBeVisible();
      await userEvent.click(splitting.getByRole('radio', { name: messages.split.way.part }));
      await userEvent.type(splitting.getByLabelText(messages.split.onScale), '1000');
      // Nothing is split until the part weighed is named.
      expect(splitting.getAllByText(messages.split.partUnknown)).toHaveLength(2);
      await userEvent.selectOptions(
        splitting.getByRole('combobox', { name: messages.split.partWhich }),
        'Chicken breast',
      );

      expect(splitting.getByText(spaced('650 g'))).toBeVisible();
      expect(splitting.getByText(spaced('350 g'))).toBeVisible();
      expect(splitting.getByText(messages.split.partRisk)).toBeVisible();
      await userEvent.selectOptions(
        splitting.getByRole('combobox', { name: messages.split.partWhich }),
        'Basmati rice',
      );
      expect(splitting.getByText(spaced('400 g'))).toBeVisible();
      expect(splitting.getByText(spaced('600 g'))).toBeVisible();
    });
  });

  it('makes the plan again for both unless the window is turned to this plan alone', async () => {
    const plan = together();
    await open(plan);
    const post = answering(
      () => aPreview(),
      () => Promise.resolve(plan),
    );

    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.recalculate }));
    const dialog = await rerollWindow();
    expect(dialog.getByRole('radio', { name: 'For both: you and Ewa' })).toBeChecked();
    await recalculate(dialog);

    expect(rerolls(post)).toEqual([[`/meal-plans/${plan.id}/regenerate`, { forAll: true }]]);
  });

  it('says which times of day were planned apart, and why', async () => {
    await open({
      ...together(),
      report: {
        relaxations: [],
        singleCandidate: [],
        sameAgain: [],
        pantry: 'empty',
        apart: ['breakfast'],
      },
    });

    expect(
      screen.getByText('Planned apart, as no dish suits both: breakfast.'),
    ).toBeInTheDocument();
  });
});

describe('the plan page, on a portion the planner sized', () => {
  /** The one meal of the plan, as `over` says it. */
  const withMeal = (over: Partial<MealPlan['days'][number]['meals'][number]>): MealPlan => {
    const plan = aPlan();
    return {
      ...plan,
      days: [{ ...plan.days[0]!, meals: [{ ...plan.days[0]!.meals[0]!, ...over }] }],
    };
  };
  const open = async (plan: MealPlan) => {
    await renderPage(aSupply(), [plan]);
    await userEvent.click(await screen.findByText('1-day plan · Vegan'));
  };

  beforeEach(() => {
    onTheDay('2026-01-05');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("says a meal's portion in words once it is a tenth off its plan's, and no factor", async () => {
    await open(withMeal({ servings: 1, quantityScale: 1.22 }));

    expect(screen.getByText('1.2 servings')).toBeInTheDocument();
    expect(screen.queryByText(/×\s?1[.,]22/)).toBeNull();
  });

  it('says nothing of a portion sized by less', async () => {
    await open(withMeal({ servings: 2, quantityScale: 1.06 }));

    expect(screen.queryByText('2.1 servings')).toBeNull();
  });

  it('says a portion made smaller as well', async () => {
    await open(withMeal({ servings: 1, quantityScale: 0.2 }));

    expect(screen.getByText('0.2 servings')).toBeInTheDocument();
  });
});

describe('the plan page, on what is left of a meal', () => {
  const texts = messages.mealPlans.leftover;
  /** The one meal of the plan, as `over` says it. */
  const withMeal = (over: Partial<MealPlan['days'][number]['meals'][number]>): MealPlan => {
    const plan = aPlan();
    return {
      ...plan,
      days: [{ ...plan.days[0]!, meals: [{ ...plan.days[0]!.meals[0]!, ...over }] }],
    };
  };
  const open = async (plan: MealPlan) => {
    await renderPage(aSupply(), [plan]);
    await userEvent.click(await screen.findByText('1-day plan · Vegan'));
  };
  const action = (name: string) => screen.getByRole('button', { name: ofAMeal(name) });

  beforeEach(() => {
    onTheDay('2026-01-05');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('says what the pot cooked already will have left beside a meal, and carries it to the next day', async () => {
    const plan = withMeal({
      servings: 1,
      quantityScale: 1.15,
      pot: { cookedOn: '2026-01-04', cooked: 1.75, rest: 0.6, held: false, offer: 'ok' },
    });
    await open(plan);

    expect(
      screen.getByText(
        /^The pot will have 0\.6 servings left, \d+ kcal: it can be eaten the next day\.$/,
      ),
    ).toBeInTheDocument();
    await userEvent.click(action(messages.mealPlans.potAction));

    expect(await screen.findByRole('dialog', { name: texts.potTitle })).toBeInTheDocument();
    await vi.waitFor(() =>
      expect(api.get).toHaveBeenCalledWith(
        `/meal-plans/${plan.id}/meals/${plan.days[0]!.meals[0]!.id}/leftover?fromPot=true`,
      ),
    );
  });

  it('says of a meal its pot holds where its day would have given it more that no more was cooked, with nothing to carry', async () => {
    await open(
      withMeal({ pot: { cookedOn: '2026-01-04', cooked: 1.75, rest: 0, held: true, offer: null } }),
    );

    expect(
      screen.getByText('From the pot at most 1.8 servings: no more was cooked.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: ofAMeal(messages.mealPlans.potAction) }),
    ).toBeNull();
  });

  it('says nothing of the pot of a meal that takes what was cooked for it', async () => {
    await open(
      withMeal({
        pot: { cookedOn: '2026-01-04', cooked: 1.75, rest: 0, held: false, offer: null },
      }),
    );

    expect(screen.getByRole('button', { name: 'Oat porridge' })).toBeInTheDocument();
    expect(screen.queryByText(/^From the pot/)).toBeNull();
    expect(screen.queryByText(/^The pot will have/)).toBeNull();
  });

  it('says nothing of the pot of a meal whose rest went to the next day, which the leftover line says', async () => {
    await open(
      withMeal({
        carriedTo: { date: '2026-01-06', mealType: 'lunch', fromPot: true },
        pot: { cookedOn: '2026-01-04', cooked: 1.75, rest: 0, held: true, offer: null },
      }),
    );

    expect(screen.getByRole('button', { name: 'Oat porridge' })).toBeInTheDocument();
    expect(screen.queryByText(/^From the pot/)).toBeNull();
  });

  it('says why the next day cannot take what the pot will have left', async () => {
    await open(
      withMeal({
        pot: { cookedOn: '2026-01-04', cooked: 1.75, rest: 0.6, held: false, offer: 'no_day' },
      }),
    );

    expect(action(messages.mealPlans.potAction)).toBeDisabled();
    expect(action(messages.mealPlans.potAction)).toHaveAccessibleDescription(texts.offNoDay);
  });

  it('offers to carry the rest of a meal of today to the next day, beside the other changes', async () => {
    await open(withMeal({ leftoverOffer: 'ok' }));
    await unfoldMeal();

    expect(action(messages.mealPlans.swap)).toBeInTheDocument();
    await userEvent.click(action(texts.action));

    expect(await screen.findByRole('dialog', { name: texts.title })).toBeInTheDocument();
  });

  it('offers it for a meal that was eaten as well, folded with its removal, and says why the next day cannot take it', async () => {
    await open(withMeal({ leftoverOffer: 'no_day', eatenAt: '2026-01-05T08:00:00.000Z' }));
    await unfoldMeal();

    expect(action(texts.action)).toBeDisabled();
    expect(action(texts.action)).toHaveAccessibleDescription(texts.offNoDay);
    expect(action(messages.mealPlans.remove)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: ofAMeal(messages.mealPlans.swap) })).toBeNull();
  });

  it('marks a leftover with the day it was left on, says what it is, and offers to carry it back instead of another dish', async () => {
    await open(
      withMeal({
        leftover: { date: '2026-01-04', mealType: 'dinner', undoable: true },
        leftoverOffer: null,
        topping: null,
        quantityScale: 0.5,
      }),
    );

    expect(screen.getByText('From Sunday')).toBeInTheDocument();
    // A part of a portion, not a portion resized.
    expect(screen.queryByText('0.5 servings')).toBeNull();
    expect(
      screen.getByText('No cooking: this is what was left of the dinner from Sunday.'),
    ).toBeInTheDocument();
    await unfoldMeal();
    expect(screen.queryByRole('button', { name: ofAMeal(messages.mealPlans.swap) })).toBeNull();
    expect(action(messages.mealPlans.remove)).toBeInTheDocument();
    await userEvent.click(action(texts.undo));

    expect(await screen.findByRole('dialog', { name: texts.undoTitle })).toBeInTheDocument();
  });

  it('keeps the portion of a meal whose pot gave its rest to the next day, and not of one whose own portion was parted', async () => {
    await open(
      withMeal({
        servings: 1,
        quantityScale: 1.9,
        carriedTo: { date: '2026-01-06', mealType: 'lunch', fromPot: true },
      }),
    );

    expect(screen.getByText('1.9 servings')).toBeInTheDocument();
  });

  it('marks no portion on a meal whose own portion was parted for the next day', async () => {
    await open(
      withMeal({
        servings: 1,
        quantityScale: 1.9,
        carriedTo: { date: '2026-01-06', mealType: 'lunch', fromPot: false },
      }),
    );

    expect(screen.getByRole('button', { name: 'Oat porridge' })).toBeInTheDocument();
    expect(screen.queryByText('1.9 servings')).toBeNull();
  });

  it('says under the meal it was left of where the rest of it is eaten', async () => {
    await open(
      withMeal({
        eatenAt: '2026-01-05T08:00:00.000Z',
        carriedTo: { date: '2026-01-06', mealType: 'lunch', fromPot: false },
      }),
    );

    expect(
      screen.getByText('The rest of this meal is eaten on Tuesday for lunch.'),
    ).toBeInTheDocument();
    // Nothing else to change of it but its removal.
    expect(
      screen.queryByRole('button', { name: ofAMeal(messages.mealPlans.changeMeal) }),
    ).toBeNull();
  });
});

describe('the plan page, on what a plan puts in the freezer and takes out of it', () => {
  beforeEach(() => {
    onTheDay('2026-01-05');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const CHICKEN = '66666666-6666-4666-8666-666666666666';
  const texts = messages.mealPlans.freezer;
  /** Two days of porridge for breakfast; Monday's opens a pack of chicken, Tuesday's takes 100 g of what was frozen. */
  const twoDays = (rest: Partial<MealPlan['packs']['frozen'][number]> = {}): MealPlan => {
    const plan = aPlan();
    const monday = plan.days[0]!;
    const tuesday = {
      ...monday,
      id: '22222222-2222-4222-8222-222222222223',
      date: '2026-01-06',
      meals: [{ ...monday.meals[0]!, id: '33333333-3333-4333-8333-333333333334' }],
    };
    return {
      ...plan,
      durationDays: 2,
      days: [monday, tuesday],
      packs: {
        bought: 500,
        used: 250,
        open: [],
        frozen: [
          {
            ingredientId: CHICKEN,
            name: 'Chicken breast',
            unit: 'g',
            date: '2026-01-05',
            mealId: monday.meals[0]!.id,
            amount: 350,
            thawed: [{ date: '2026-01-06', mealId: tuesday.meals[0]!.id, amount: 100 }],
            left: 250,
            portion: null,
            loose: false,
            inPantry: false,
            ...rest,
          },
        ],
        staysFrozen: [],
        fromFreezer: [],
      },
    };
  };
  const opened = async (plan: MealPlan) => {
    await renderPage(aSupply(), [plan]);
    await userEvent.click(await screen.findByText('2-day plan · Vegan'));
    await screen.findAllByRole('button', { name: 'Oat porridge' });
  };

  it('says with the meal that opens the pack to freeze its rest in the portions the plan takes, and gives the pantry the one for later', async () => {
    const plan = twoDays();
    await opened(plan);
    const post = vi.spyOn(api, 'post').mockResolvedValue(twoDays({ inPantry: true }) as never);

    expect(
      screen.getByText(
        'Freeze the rest of the pack at once in separate portions: Chicken breast, 100 g (Tue) and 250 g for later.',
      ),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', {
        name: 'Add to the pantry as frozen: Chicken breast, 250\u00a0g',
      }),
    );

    expect(post).toHaveBeenCalledWith(`/meal-plans/${plan.id}/frozen`, {
      ingredientId: CHICKEN,
      date: '2026-01-05',
    });
  });

  it('says to split the part for later into portions that two days of the plan eat, where it is bigger', async () => {
    await opened(twoDays({ portion: 100 }));

    expect(
      await screen.findByText(
        `Split the part for later into portions of up to 100 g: that is the most this plan eats of it in two days, and a plan takes only whole packages out of the freezer.`,
      ),
    ).toBeInTheDocument();
  });

  it('says no size for a part for later that two days of the plan eat whole, nor where nothing is left', async () => {
    await opened(twoDays({ portion: 250 }));
    // The rules come with the same part of the page: once they are there, so would the size be.
    expect(await screen.findByText(messages.freezing.rulesTitle)).toBeInTheDocument();
    expect(screen.queryByText(/^Split the part for later/)).toBeNull();
  });

  it('folds the rules of freezing under the line that says what to freeze', async () => {
    await opened(
      twoDays({
        amount: 100,
        left: 0,
        thawed: [{ date: '2026-01-06', mealId: null, amount: 100 }],
        portion: 100,
      }),
    );

    const rules = await screen.findByText(messages.freezing.rulesTitle);
    expect(screen.queryByText(/^Split the part for later/)).toBeNull();
    const rule = screen.getByText(messages.freezing.ruleRefreeze);
    expect(rule).not.toBeVisible();
    await userEvent.click(rules);
    expect(rule).toBeVisible();
    for (const one of ['ruleLabel', 'ruleUseBy', 'ruleThaw'] as const)
      expect(screen.getByText(messages.freezing[one])).toBeVisible();
  });

  it('says the rest of what was bought by weight as such', async () => {
    await opened(twoDays({ loose: true }));

    expect(
      screen.getByText(
        'Freeze the rest of what you bought by weight at once in separate portions: Chicken breast, 100 g (Tue) and 250 g for later.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Freeze the rest of the pack/)).toBeNull();
  });

  it('gives the pantry nothing of a rest the plan freezes on a later day', async () => {
    // The same two days, still to come.
    const plan = twoDays();
    const later = { '2026-01-05': '2100-01-04', '2026-01-06': '2100-01-05' } as Record<
      string,
      string
    >;
    const rest = plan.packs.frozen[0]!;
    await opened({
      ...plan,
      startDate: later[plan.startDate] ?? plan.startDate,
      days: plan.days.map((day) => ({ ...day, date: later[day.date]! })),
      packs: {
        ...plan.packs,
        frozen: [
          {
            ...rest,
            date: later[rest.date]!,
            thawed: rest.thawed.map((one) => ({ ...one, date: later[one.date]! })),
          },
        ],
      },
    });

    expect(screen.getByText(/^Freeze the rest of the pack at once/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Add to the pantry as frozen/ })).toBeNull();
  });
  it('says a rest the pantry was given is there, and offers it no more', async () => {
    await opened(twoDays({ inPantry: true }));

    expect(screen.getByText(texts.inPantry)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Add to the pantry/ })).toBeNull();
  });

  it('offers nothing for the pantry of a rest the plan eats whole', async () => {
    await opened(
      twoDays({
        amount: 100,
        left: 0,
        thawed: [{ date: '2026-01-06', mealId: null, amount: 100 }],
      }),
    );

    expect(
      screen.getByText('Freeze the rest of the pack at once: Chicken breast, 100 g (Tue).'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Add to the pantry/ })).toBeNull();
  });

  it('says the day before what to take out of the freezer, and marks that day in its head', async () => {
    await opened(twoDays());

    expect(
      screen.getByText(
        'Take out of the freezer for tomorrow: Chicken breast, a portion of 100 g (breakfast).',
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByText(texts.thawChip)).toHaveLength(1);
  });

  it('says on its own day to take out the whole portion the freezer held, for the first meal that takes it', async () => {
    const plan = twoDays();
    await opened({
      ...plan,
      packs: {
        ...plan.packs,
        frozen: [],
        staysFrozen: [],
        fromFreezer: [
          {
            ingredientId: CHICKEN,
            name: 'Chicken breast',
            unit: 'g',
            date: '2026-01-05',
            mealId: plan.days[0]!.meals[0]!.id,
            amount: 286,
            eaten: 150,
          },
        ],
      },
    });

    expect(
      screen.getByText(
        'Take out of the freezer as early as you can that day: Chicken breast, a portion of 286 g (breakfast).',
      ),
    ).toBeInTheDocument();
  });
});

describe('the plans read again', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('says why a plan opened could not be read, instead of waiting for ever', async () => {
    onTheDay('2026-01-05');
    const plan = aPlan();
    await renderPage(aSupply(), [plan]);
    const answers = vi.mocked(api.get).getMockImplementation()!;
    vi.mocked(api.get).mockImplementation((path: string) =>
      path === `/meal-plans/${plan.id}`
        ? Promise.reject(new ApiClientError(0, 'NETWORK', 'Failed to fetch'))
        : answers(path),
    );

    await userEvent.click(await screen.findByText('1-day plan · Vegan'));

    expect(await screen.findByText(messages.errors.NETWORK)).toBeInTheDocument();
    vi.mocked(api.get).mockImplementation(answers);
    await userEvent.click(
      within(
        screen.getByText(messages.errors.NETWORK).closest('[role="alert"]') as HTMLElement,
      ).getByRole('button', { name: messages.common.retry }),
    );
    await vi.waitFor(() => expect(screen.queryByText(messages.errors.NETWORK)).toBeNull());
  });

  it('keeps the plans it showed when a read fails again, says why above them, and reads again when asked', async () => {
    onTheDay('2026-01-05');
    await renderPage(aSupply(), [aPlan()]);
    expect(
      await screen.findByRole('button', { name: messages.mealPlans.recalculate }),
    ).toBeInTheDocument();

    const answerAgain = await failReadsAgain(shownWith);

    const note = await screen.findByText(messages.common.shownFromBefore, { exact: false });
    expect(note.closest('[role="alert"]')).toHaveTextContent(messages.errors.NETWORK);
    expect(
      screen.getByRole('button', { name: messages.mealPlans.recalculate }),
    ).toBeInTheDocument();
    answerAgain();
    await userEvent.click(
      within(note.closest('[role="alert"]') as HTMLElement).getByRole('button', {
        name: messages.common.retry,
      }),
    );
    await vi.waitFor(() =>
      expect(screen.queryByText(messages.common.shownFromBefore, { exact: false })).toBeNull(),
    );
    expect(
      screen.getByRole('button', { name: messages.mealPlans.recalculate }),
    ).toBeInTheDocument();
  });
});

describe('the plan page, on how a day is changed', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const help = messages.mealPlans.dayHelp;
  const helpWindow = async () => within(await screen.findByRole('dialog', { name: help.title }));
  const open = async (plan: MealPlan) => {
    await renderPage(aSupply(), [plan]);
    await userEvent.click(await screen.findByText('1-day plan · Vegan'));
  };

  it('opens from under the figures of a day and from its changes, and says what stays, which way when and what it changes', async () => {
    onTheDay('2026-01-05');
    await open(aPlan());

    await userEvent.click(await screen.findByRole('button', { name: help.link }));
    const window = await helpWindow();
    for (const said of [
      help.kept,
      help.wayResize,
      help.waySwap,
      help.wayVariants,
      help.wayReroll,
      help.when,
      help.affectsList,
      help.affectsDiary,
      help.affectsCooking,
      help.affectsUndo,
    ])
      expect(window.getByText(plain(said))).toBeInTheDocument();
    // A plan of one person has no other person to make the day again for.
    expect(window.queryByText(plain(help.affectsJoint))).toBeNull();
    await userEvent.click(window.getByRole('button', { name: messages.common.close }));
    await vi.waitFor(() => expect(screen.queryByRole('dialog', { name: help.title })).toBeNull());

    // Among the ways to change the day as well, once they are unfolded.
    await unfoldDay();
    const links = screen.getAllByRole('button', { name: help.link });
    expect(links).toHaveLength(2);
    await userEvent.click(links[0]!);
    expect(await helpWindow()).toBeTruthy();
  });

  it('says in a joint plan that the day is made again for both or for one', async () => {
    onTheDay('2026-01-05');
    const plan = aPlan();
    await open({
      ...plan,
      joint: {
        planId: '77777777-7777-4777-8777-777777777777',
        profileId: '88888888-8888-4888-8888-888888888888',
        profileName: 'Ewa',
        cookApart: false,
      },
    });

    await userEvent.click(await screen.findByRole('button', { name: help.link }));

    expect((await helpWindow()).getByText(plain(help.affectsJoint))).toBeInTheDocument();
  });

  it('opens the other ways and the window that changes the day, for the day it was opened on', async () => {
    onTheDay('2026-01-05');
    const plan = aPlan();
    const post = vi.spyOn(api, 'post').mockImplementation(((path: string) =>
      path.endsWith('/variations')
        ? Promise.resolve({
            date: '2026-01-05',
            calorieTarget: 2000,
            diary: null,
            cooking: null,
            current: {
              dayNutrition: plan.days[0]!.dayNutrition,
              packs: { bought: 0, used: 0, wasted: 0 },
            },
            variations: [],
            aiMeta: null,
          })
        : path.endsWith('/regenerate/preview')
          ? Promise.resolve(
              aPreview({
                days: 1,
                replaced: 1,
                couldGo: { past: false, eaten: false, custom: false },
              }),
            )
          : Promise.reject(new Error('nothing else was expected'))) as never);
    await open(plan);

    await userEvent.click(await screen.findByRole('button', { name: help.link }));
    await userEvent.click(
      (await helpWindow()).getByRole('button', { name: messages.mealPlans.otherWays }),
    );
    const ways = within(
      await screen.findByRole('dialog', { name: 'Other ways to fill Mon, Jan 5' }),
    );
    expect(screen.queryByRole('dialog', { name: help.title })).toBeNull();
    expect(post).toHaveBeenCalledWith(
      `/meal-plans/${plan.id}/days/${plan.days[0]!.id}/variations`,
      { weigh: false },
    );
    await userEvent.click(ways.getByRole('button', { name: messages.common.close }));

    await userEvent.click(await screen.findByRole('button', { name: help.link }));
    await userEvent.click(
      (await helpWindow()).getByRole('button', { name: messages.mealPlans.changeDay }),
    );
    const asked = await rerollWindow();
    expect(asked.getByLabelText(messages.mealPlans.reroll.day)).toBeChecked();
    expect(asked.getByLabelText(messages.mealPlans.reroll.dayWhich)).toHaveValue('2026-01-05');
  });

  it('is not offered for a day that has passed', async () => {
    onTheDay('2026-01-06');
    const plan = aPlan();
    await open(plan);
    await screen.findByText(messages.mealPlans.dayIsOver);
    expect(screen.queryByRole('button', { name: help.link })).toBeNull();
  });

  it('is not offered for a day the user skips', async () => {
    onTheDay('2026-01-05');
    const plan = aPlan();
    await open({ ...plan, days: [{ ...plan.days[0]!, skipped: true, meals: [] }] });
    await screen.findByText(messages.mealPlans.daySkipped);
    await unfoldDay();

    expect(screen.queryByRole('button', { name: help.link })).toBeNull();
  });
  it('stands under a day that lacks much protein, after the line that says so', async () => {
    onTheDay('2026-01-05');
    const plan = aPlan();
    const day = plan.days[0]!;
    await open({
      ...plan,
      days: [
        {
          ...day,
          proteinShort: true,
          dayNutrition: { ...day.dayNutrition, protein: 134 },
          targetMacros: { ...day.targetMacros, protein: 178 },
        },
      ],
    });

    const line = await screen.findByText(
      'Too little protein: 134 of 178 g, more than a fifth less than the day aims at.',
    );
    const link = screen.getByRole('button', { name: help.link });
    expect(line.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('says nothing of protein on a day that does not lack much of it', async () => {
    onTheDay('2026-01-05');
    await open(aPlan());

    await screen.findByRole('button', { name: help.link });
    expect(screen.queryByText(/^Too little protein/)).toBeNull();
  });
});

describe('the plan page, after a change that answers with the plan', () => {
  beforeEach(() => {
    onTheDay('2026-01-05');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    favoriteSets = [];
  });

  const LIST = {
    id: '77777777-7777-4777-8777-777777777777',
    planId: '11111111-1111-4111-8111-111111111111',
    profileId: profile.id,
    fromDate: '2026-01-05',
    toDate: '2026-01-05',
    householdId: null,
  };
  /** The plan as a change left it, with the list it made stop matching. */
  const changed = (plan: MealPlan) => ({
    ...plan,
    effects: { lists: [LIST], thaw: [], freeze: [] },
  });
  /** The card says the change as the day's history names it, and the list it made stop matching. */
  const toldAs = async (cause: keyof typeof messages.dayHistory.cause) => {
    const title = await screen.findByText(messages.dayHistory.cause[cause], { selector: 'p' });
    const card = title.closest('div')!;
    expect(within(card).getByText(/no longer matches the plan\./)).toBeInTheDocument();
    expect(
      within(card).getByRole('link', { name: messages.mealPlans.effectOpenList }),
    ).toHaveAttribute(
      'href',
      `/shopping-lists?profile=${profile.id}&plan=${LIST.planId}&list=${LIST.id}`,
    );
  };
  const opened = async (plan: MealPlan, title = '1-day plan · Vegan') => {
    await renderPage(aSupply(), [plan]);
    await userEvent.click(await screen.findByText(title));
  };

  it('after the profile’s target is taken from today', async () => {
    const plan = aPlan({ targetMoved: { profileTarget: 2440, planTarget: 2135 } });
    await opened(plan);
    vi.spyOn(api, 'post').mockResolvedValue(changed(plan) as never);

    // The note of a profile that moved is fetched once a plan needs it.
    await userEvent.click(await screen.findByRole('button', { name: messages.mealPlans.retarget }));

    await toldAs('retarget');
  });

  it('after the profile’s number of meals is taken from today', async () => {
    const plan = aPlan({ mealCountMoved: { profileCount: 4, planCount: 3 } });
    await opened(plan);
    vi.spyOn(api, 'post').mockResolvedValue(changed(plan) as never);

    await userEvent.click(
      await screen.findByRole('button', { name: messages.mealPlans.takeCount }),
    );

    await toldAs('meal-count');
  });

  it('after the settings of a day are saved', async () => {
    const plan = aPlan();
    await opened(plan);
    const day = plan.days[0]!;
    vi.spyOn(api, 'post').mockResolvedValue({
      revision: plan.revision,
      date: day.date,
      calorieTarget: { now: day.calorieTarget, then: day.calorieTarget + 300 },
      targetMacros: { now: day.targetMacros, then: day.targetMacros },
      belowSafetyFloor: false,
      meals: day.meals.map((meal) => ({
        mealId: meal.id,
        mealType: meal.mealType,
        fate: 'resized',
        because: null,
        portion: null,
      })),
      added: [],
      dayCalories: day.calorieTarget + 300,
      fits: true,
      short: null,
      listOutOfDate: false,
      cooking: null,
      unchanged: false,
      week: null,
    } as never);
    const put = vi.spyOn(api, 'put').mockResolvedValue(changed(plan) as never);

    await unfoldDay();
    await userEvent.click(
      screen.getByRole('button', { name: messages.mealPlans.daySettingsButton }),
    );
    const dialog = within(
      await screen.findByRole('dialog', { name: messages.mealPlans.daySettings.title }),
    );
    await userEvent.selectOptions(
      dialog.getByRole('combobox', { name: new RegExp(`^${messages.mealPlans.daySettings.kind}`) }),
      messages.mealPlans.daySettings.kinds.training,
    );
    const save = dialog.getByRole('button', { name: messages.mealPlans.daySettings.save });
    await vi.waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(save);

    await vi.waitFor(() => expect(put).toHaveBeenCalled());
    await toldAs('day-settings');
  });

  it('after another way of filling a day is taken', async () => {
    const plan = aPlan();
    await opened(plan);
    const day = plan.days[0]!;
    vi.spyOn(api, 'post').mockImplementation(((path: string) =>
      Promise.resolve(
        path.endsWith('/take')
          ? changed(plan)
          : {
              date: day.date,
              calorieTarget: day.calorieTarget,
              diary: null,
              cooking: null,
              current: { dayNutrition: day.dayNutrition, packs: { bought: 0, used: 0, wasted: 0 } },
              variations: [
                {
                  offer: 'the-offer',
                  reason: null,
                  meals: day.meals.map((meal) => ({
                    mealType: meal.mealType,
                    recipeId: meal.recipe?.id ?? null,
                    title: 'Lentil soup',
                    servings: 1,
                    stays: false,
                    nutrition: meal.nutrition,
                  })),
                  dayNutrition: day.dayNutrition,
                  packs: { bought: 0, used: 0, wasted: 0 },
                },
              ],
              aiMeta: null,
            },
      )) as never);

    await unfoldDay();
    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.otherWays }));
    const dialog = within(
      await screen.findByRole('dialog', { name: 'Other ways to fill Mon, Jan 5' }),
    );
    await userEvent.click(
      await dialog.findByRole('button', { name: messages.mealPlans.variations.take }),
    );

    await toldAs('day-variant');
  });

  it('after a favourite set is put on a day', async () => {
    favoriteSets = [
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        profileId: profile.id,
        label: 'Workday',
        slots: { breakfast: '44444444-4444-4444-8444-444444444444' },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    const plan = aPlan();
    await opened(plan);
    vi.spyOn(api, 'post').mockResolvedValue(changed(plan) as never);

    await userEvent.click(screen.getByRole('button', { name: messages.favoriteSets.apply }));
    await userEvent.selectOptions(
      await screen.findByRole('combobox', { name: messages.favoriteSets.applyPickSet }),
      await screen.findByRole('option', { name: 'Workday' }),
    );
    await userEvent.click(screen.getByRole('button', { name: messages.favoriteSets.applyConfirm }));

    await toldAs('favorite-set');
  });

  it('after a week is evened out in a plan of more than a week, from the tab of its week', async () => {
    const one = aPlan();
    const days = Array.from({ length: 8 }, (_, at) => ({
      ...one.days[0]!,
      id: `2222222${at}-2222-4222-8222-222222222222`,
      date: dayAfter('2026-01-05', at),
      meals: one.days[0]!.meals.map((meal) => ({
        ...meal,
        id: `3333333${at}-3333-4333-8333-333333333333`,
      })),
    }));
    const plan = aPlan({
      durationDays: 8,
      days,
      weeks: [
        { ...one.weeks[0]!, from: '2026-01-05', to: '2026-01-11', average: 260, uneven: true },
        { ...one.weeks[0]!, from: '2026-01-12', to: '2026-01-12' },
      ],
    });
    await opened(plan, '8-day plan · Vegan');
    vi.spyOn(api, 'post').mockResolvedValue(changed(plan) as never);

    await userEvent.click(await screen.findByRole('button', { name: messages.mealPlans.evenWeek }));

    await toldAs('week-evened');
  });
});

describe('the plan page, on a meal marked eaten', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** The plan open on its day, the API answering the meal's pantry with `pantry`. */
  const open = async (pantry: object) => {
    onTheDay('2026-01-05');
    const plan = aPlan();
    await renderPage(aSupply(), [plan]);
    await userEvent.click(await screen.findByText('1-day plan · Vegan'));
    const path = `/meal-plans/${plan.id}/meals/${plan.days[0]!.meals[0]!.id}`;
    const read = vi.mocked(api.get).getMockImplementation()!;
    vi.mocked(api.get).mockImplementation((asked: string) =>
      asked === `${path}/pantry` ? Promise.resolve(pantry as never) : read(asked),
    );
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({ plan, rebalance: null } as never);
    const post = vi.spyOn(api, 'post').mockResolvedValue({ offer: [], taken: [] } as never);
    return { path, patch, post };
  };
  const oats = { ingredientId: '55555555-5555-4555-8555-555555555555', name: 'Rolled oats' };

  it('offers to take what the meal ate off the pantry where the API offers it, and takes it only when told to', async () => {
    const { path, patch, post } = await open({
      offer: [
        {
          ...oats,
          eaten: { quantity: 60, unit: 'g' },
          held: { quantity: 400, unit: 'g' },
          taken: { quantity: 60, unit: 'g' },
        },
      ],
      taken: [],
    });

    await userEvent.click(
      screen.getByRole('checkbox', { name: ofAMeal(messages.mealPlans.markEaten) }),
    );

    expect(patch).toHaveBeenCalledWith(`${path}/eaten`, { eaten: true });
    const dialog = within(
      await screen.findByRole('dialog', { name: messages.eatenPantry.takeTitle }),
    );
    expect(dialog.getByText('Rolled oats')).toBeInTheDocument();
    expect(
      dialog.getByText(spaced('eaten 60 g · in the pantry 400 g · you take 60 g')),
    ).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
    await userEvent.click(dialog.getByRole('button', { name: messages.eatenPantry.take }));

    expect(post).toHaveBeenCalledWith(`${path}/pantry-take`);
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: messages.eatenPantry.takeTitle })).toBeNull(),
    );
  });

  it('asks nothing where the API offers nothing, as on a day a shopping list covers', async () => {
    const { patch, post } = await open({ offer: [], taken: [] });

    await userEvent.click(
      screen.getByRole('checkbox', { name: ofAMeal(messages.mealPlans.markEaten) }),
    );

    await waitFor(() => expect(patch).toHaveBeenCalled());
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringMatching(/\/pantry$/)));
    expect(screen.queryByRole('dialog', { name: messages.eatenPantry.takeTitle })).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });
});
