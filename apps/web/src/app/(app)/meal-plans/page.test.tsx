// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CatalogueSupply,
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
import * as files from '@/lib/save-file';
import { aPublicConfig, aSupply } from '@/testing/public-config';
import messages from '../../../../messages/en.json';
import MealPlansPage from './page';
import { dayAnchor } from './plan-card';

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
  activityLevel: 'moderate',
  dietType: 'vegan',
  weeklyLossTarget: '0.5',
  manualCalorieTarget: null,
  riskAcknowledgedAt: null,
  mealCount: 4,
  weightReminderCadence: 'weekly',
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
          nutrition: { calories: 230, protein: 8, fat: 4, carbs: 40 },
        },
      ],
      dayNutrition: { calories: 230, protein: 8, fat: 4, carbs: 40 },
      diary: null,
      calorieTarget: 2000,
      targetMacros: { protein: 100, fat: 62, carbs: 260 },
      calorieDelta: -1770,
      offTarget: null,
      skipped: false,
      belowSafetyFloor: false,
      overrides: null,
      mealCount: 3,
    },
  ],
  averageDailyNutrition: { calories: 230, protein: 8, fat: 4, carbs: 40 },
  targetMacros: { protein: 100, fat: 62, carbs: 260 },
  ingredientReuseScore: 0,
  packs: { bought: 0, used: 0, open: [] },
  generationMode: 'deterministic',
  options: {
    dietType: null,
    mealCount: null,
    calorieTargetOverride: null,
    mealPrepFriendly: false,
    respectExclusions: true,
    respectFavorites: true,
    respectInventory: true,
    maxRepeatsPerRecipe: null,
    allowRelaxations: [],
  },
  report: { relaxations: [], singleCandidate: [], pantry: 'empty' },
  revision: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
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
        ? [profile]
        : path === '/users/me'
          ? { aiMode }
          : path.startsWith('/meal-plans?')
            ? listed
            : path.startsWith('/meal-plans/calendar?')
              ? { days: plans.flatMap(daysOnTheCalendar) }
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
  client.setQueryData(['config'], aPublicConfig({ catalogue: { supply }, ...operator }));
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider client={client}>
        <MealPlansPage />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  // A profile without a plan has the form open by itself once the list is read; with plans, the form is its head alone.
  return screen.findByRole('button', {
    name: plans.length > 0 ? /^Generate a plan/ : messages.mealPlans.generateButton,
  });
}

/** The name of a control of a meal: what it does, then the meal it does it to. */
const ofAMeal = (action: string): RegExp => new RegExp(`^${action}: `);

/** Unfold the ways the one meal on the page can be changed. */
const unfoldMeal = () =>
  userEvent.click(screen.getByRole('button', { name: ofAMeal(messages.mealPlans.changeMeal) }));

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
  kept: { outside: 0, past: 1, skipped: 0, eaten: 0, custom: 0, locked: 0 },
  couldGo: { past: true, eaten: false, custom: false },
  fromToday: null,
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

    expect(screen.getByRole('status').textContent).toContain('has only 2 recipes to choose from');
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
    expect(notice.textContent).toContain('Sat, Jan 10 · Breakfast: times a week for one recipe');
    expect(
      (post.mock.calls[0]![1] as { allowRelaxations?: string[] }).allowRelaxations,
    ).toBeUndefined();

    await userEvent.click(await lettingGiveWay(1));
    // The second attempt needs another limit: what was let before stays let.
    expect((await screen.findByRole('alert')).textContent).toContain(
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

  it('marks a meal that is outside a limit, and one that was the only recipe to choose from', async () => {
    await open(
      aPlan({
        report: {
          relaxations: [
            { date: '2026-01-05', slot: 'breakfast', gaveWay: ['consecutive_days', 'weekly_cap'] },
          ],
          singleCandidate: [{ date: '2026-01-05', slot: 'breakfast' }],
          pantry: 'counted',
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

  it('says nothing of a meal the report does not speak of, nor of a pantry that is empty', async () => {
    await open(aPlan());

    expect(screen.queryByText('Outside a limit')).toBeNull();
    expect(screen.queryByText('Only recipe')).toBeNull();
    for (const line of [
      messages.mealPlans.pantryCounted,
      messages.mealPlans.pantryLeftOut,
      messages.mealPlans.pantryUnused,
    ])
      expect(screen.queryByText(line)).toBeNull();
  });

  it.each([
    ['left_out', messages.mealPlans.pantryLeftOut],
    ['unused', messages.mealPlans.pantryUnused],
  ] as const)('says why the pantry did not count when the reason is %s', async (pantry, line) => {
    await open(aPlan({ report: { relaxations: [], singleCandidate: [], pantry } }));

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
      diary: { entries: 1, nutrition: { calories: 400, protein: 10, fat: 10, carbs: 60 } },
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
  afterEach(() => {
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
    expect(offered.textContent).toContain(
      'Instead: Tofu scramble, 1.5 servings: 240 kcal in place of 230.',
    );
    expect(offered.textContent).toContain('Protein 14 g · fat 9 g · carbohydrate 26 g');
    expect(offered.textContent).toContain(
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
    client.setQueryData(['config'], aPublicConfig({ catalogue: { supply: aSupply() } }));
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
    expect(screen.getByRole('button', { name: messages.mealPlans.pageNewer })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.pageOlder }));

    expect(await screen.findByText('Page 2 of 3')).toBeInTheDocument();
    expect(asked().at(-1)).toBe(`/meal-plans?profileId=${profile.id}&page=2`);

    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.statusPast }));
    expect(await screen.findByText('Page 1 of 3')).toBeInTheDocument();
    expect(asked().at(-1)).toBe(`/meal-plans?profileId=${profile.id}&page=1&status=past`);
  });
});

describe('the plan page, on what a model had to do with a plan', () => {
  afterEach(() => {
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
    const notes = screen.getAllByText(/^AI is turned off for this account/);
    expect(swap).toBeDisabled();
    expect(notes).toHaveLength(1);
    expect(swap).toHaveAccessibleDescription(notes[0]!.textContent!);
    expect(screen.getByRole('link', { name: 'Turn AI on in Settings' })).toHaveAttribute(
      'href',
      '/settings?tab=ai',
    );
  });

  it('says nothing of the kind on an account that has a model to ask', async () => {
    await opened(aPlan(), 'admin');
    await unfoldMeal();

    expect(screen.getByRole('button', { name: ofAMeal(messages.mealPlans.aiSwap) })).toBeEnabled();
    expect(screen.queryByText(/^AI is turned off for this account/)).toBeNull();
  });

  it('marks a meal whose recipe a model chose, says why, and says it again where the recipe is opened', async () => {
    const recipe = await opened(aPlanWith({ modelPick: { reason: 'Lighter than the porridge.' } }));

    expect(marks()).toHaveLength(1);
    expect(marks()[0]).toContain(
      'A model chose this recipe for the meal: “Lighter than the porridge.”',
    );

    await userEvent.click(recipe);

    const window = await screen.findByRole('dialog', { name: messages.recipeModal.title });
    expect(window.textContent).toContain(
      'A model chose this recipe for the meal: “Lighter than the porridge.”',
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
      wasted: false,
    } as const;
    const milk = {
      ingredientId: '77777777-7777-4777-8777-777777777777',
      name: 'Whole milk',
      unit: 'ml',
      packSize: 1000,
      packs: 1,
      left: 500,
      wasted: true,
    } as const;
    const feta = {
      ingredientId: '88888888-8888-4888-8888-888888888888',
      name: 'Feta cheese',
      unit: 'g',
      packSize: 200,
      packs: 1,
      left: 160,
      wasted: true,
    } as const;

    it('says how much of what the menu buys it uses, and how many packs it leaves more than a fifth of', async () => {
      await opened(aPlan({ packs: { bought: 2200, used: 1520, open: [feta, milk, chicken] } }));

      const line = screen.getByText(
        'Packs that do not keep once opened: the menu uses 69% of what it buys, and leaves more than a fifth of 2 packs.',
      );
      expect(line).toBeVisible();
      // Unfolded, it names every pack that is not finished: the ones with much left as such.
      await userEvent.click(line);
      const packs = within(line.closest('details')!)
        .getAllByRole('listitem')
        .map((pack) => pack.textContent);
      expect(packs).toEqual([
        'Feta cheese: 160 g left of a pack of 200 g, more than a fifth of it',
        'Whole milk: 500 ml left of a pack of 1000 ml, more than a fifth of it',
        'Chicken breast: 20 g left of a pack of 500 g',
      ]);
      expect(screen.getByText(messages.mealPlans.packs.explain)).toBeInTheDocument();
    });

    it('says so when one pack is left much of, and when none is', async () => {
      await opened(aPlan({ packs: { bought: 1500, used: 980, open: [milk, chicken] } }));

      expect(
        screen.getByText(
          'Packs that do not keep once opened: the menu uses 65% of what it buys, and leaves more than a fifth of 1 pack.',
        ),
      ).toBeVisible();
    });

    it('says that every pack is used up when the menu finishes them all', async () => {
      await opened(aPlan({ packs: { bought: 500, used: 500, open: [] } }));

      await userEvent.click(
        screen.getByText('Packs that do not keep once opened: the menu uses 100% of what it buys.'),
      );
      expect(screen.getByText(messages.mealPlans.packs.allFinished)).toBeInTheDocument();
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
        diary: { entries: 2, nutrition: { calories: 700, protein: 20, fat: 30, carbs: 80 } },
      }),
    );

    expect(screen.getByText(messages.mealPlans.dayOverDiaryHint)).toBeVisible();
    // Nothing says that resizing the day could not close the gap: it was not resized with the entries.
    expect(screen.queryByText(messages.mealPlans.dayOverHint)).toBeNull();
    expect(
      screen.getByText('The diary adds 700 kcal to this day (2 entries).', { exact: false }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: messages.mealPlans.openDiary })).toHaveAttribute(
      'href',
      `/diary?profile=${aPlan().profileId}&date=${today}`,
    );
    const resize = screen.getByRole('button', { name: messages.mealPlans.resizeDay });
    expect(resize).toHaveAccessibleDescription(messages.mealPlans.resizeDayNote);
    await userEvent.click(resize);

    expect(posted).toHaveBeenCalledWith(`/meal-plans/${aPlan().id}/rebalance`, {
      scope: 'day',
      date: today,
    });
  });

  it('offers no resizing of a day that has no meal from a recipe left to resize', async () => {
    const today = localDate();
    const day = aPlan().days[0]!;
    await opened(
      aDay({
        date: today,
        offTarget: 'over',
        diary: { entries: 1, nutrition: { calories: 700, protein: 20, fat: 30, carbs: 80 } },
        meals: day.meals.map((meal) => ({ ...meal, eatenAt: `${today}T08:00:00.000Z` })),
      }),
    );

    expect(screen.getByText(messages.mealPlans.dayOverDiaryHint)).toBeVisible();
    expect(screen.queryByRole('button', { name: messages.mealPlans.resizeDay })).toBeNull();
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
        diary: { entries: 2, nutrition: { calories: 700, protein: 20, fat: 30, carbs: 80 } },
      }),
    );

    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.resizeDay }));

    expect(await screen.findByText(messages.mealPlans.resizeNothing)).toBeVisible();
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

  it('marks, in a plan made for cooking ahead, the meal a dish is cooked at and the one it is eaten from', async () => {
    await opened(aPlanOf({ cookAhead: 'cook' }, { cookAhead: 'cooked' }));

    for (const text of ['cookOnceChip', 'cookOnceHint', 'cookedChip', 'cookedHint'] as const)
      expect(screen.getByText(messages.mealPlans[text])).toBeVisible();
  });

  it('says nothing of cooking ahead of a meal that is cooked for itself', async () => {
    await opened(aPlanOf({}, {}));

    expect(screen.queryByText(messages.mealPlans.cookOnceChip)).toBeNull();
    expect(screen.queryByText(messages.mealPlans.cookedChip)).toBeNull();
  });

  it('says over the days how many meals hold what the profile has ruled out since, and under each of them what and what to do', async () => {
    await opened(
      aPlanOf(
        { restrictionConflicts: ['allergen'] },
        { restrictionConflicts: ['excluded_ingredient', 'avoided'] },
      ),
    );

    expect(screen.getByRole('alert').textContent).toBe(
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
  afterEach(() => {
    vi.restoreAllMocks();
    favoriteSets = [];
    profile.customMacroSplit = null;
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

  it('does not offer the custom diet to a profile that has said no split for it', async () => {
    await renderPage();

    expect(screen.queryByRole('option', { name: /^Custom/ })).toBeNull();
  });

  it('offers the custom diet to a profile that has said its split, names the split, and asks for the diet', async () => {
    profile.customMacroSplit = { protein: 30, fat: 40, carbs: 30 };
    await renderPage();

    expect(
      screen.getByRole('option', { name: 'Custom (30 % protein, 40 % fat, 30 % carbohydrate)' }),
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
      await screen.findByRole('button', { name: /^Mon, Jan 5: 230 of 2000 kcal/ }),
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
    expect(listsAsked()).toEqual([`/meal-plans?profileId=${profile.id}&page=1`]);
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
  afterEach(() => {
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
      current: {
        dayNutrition: plan.days[0]!.dayNutrition,
        packs: { bought: 0, used: 0, wasted: 0 },
      },
      variations: [],
      aiMeta: null,
    } as never);

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

  it('offers no other ways for a day the user skips', async () => {
    const plan = aPlan();
    await renderPage(aSupply(), [
      { ...plan, days: [{ ...plan.days[0]!, skipped: true, meals: [] }] },
    ]);
    await userEvent.click(await screen.findByText('1-day plan · Vegan'));
    await screen.findByText(messages.mealPlans.daySkipped);

    expect(screen.queryByRole('button', { name: messages.mealPlans.otherWays })).toBeNull();
  });

  it('offers, with the packs a plan leaves more than a fifth of, to look for what would use them up', async () => {
    const plan = aPlan({ packs: { bought: 500, used: 150, open: [chicken] } });
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
      aPlan({ packs: { bought: 500, used: 480, open: [{ ...chicken, left: 20, wasted: false }] } }),
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
    const head = (): HTMLElement => screen.getByRole('button', { name: /^Generate a plan/ });

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
