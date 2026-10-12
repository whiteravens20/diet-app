// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogueDepth, FavoriteSet, MealPlan, MealSwapPreview, PlanCalendarDay, Profile, RelaxationNeeded, UnfilledMeal } from '@diet-app/shared';
import { api } from '@/lib/api';
import { ApiClientError } from '@/lib/http';
import * as files from '@/lib/save-file';
import { aDepth, aPublicConfig } from '@/testing/public-config';
import messages from '../../../../messages/en.json';
import MealPlansPage from './page';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));

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
    maxWeeklyAmountPerIngredient: 3000,
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
              { ingredientId: '55555555-5555-4555-8555-555555555555', name: 'Rolled oats', quantity: 60, unit: 'g', display: { quantity: 60, unit: 'g' }, note: null },
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
      calorieTarget: 2000,
      targetMacros: { protein: 100, fat: 62, carbs: 260 },
      calorieDelta: -1770,
      offTarget: null,
      skipped: false,
      belowSafetyFloor: false,
      overrides: null,
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
    eaten: { meals: day.meals.filter((meal) => meal.eatenAt !== null).length, of: day.meals.length },
    skipped: day.skipped,
  }));

/** The favourite sets the profile has, for the tests that are about them. */
let favoriteSets: FavoriteSet[] = [];

/** The page of somebody with that one profile and `plans`, on an instance whose catalogue has `depth`. AI is off for them unless `aiMode` says otherwise. */
async function renderPage(depth: CatalogueDepth = aDepth(9), plans: MealPlan[] = [], aiMode: 'none' | 'admin' = 'none') {
  // The list answers each plan as a summary, a page at a time; a plan that is opened is read whole.
  const listed = { items: plans.map(({ days: _days, report: _report, targetMacros: _targetMacros, packs: _packs, ...summary }) => summary), page: 1, pageSize: 20, total: plans.length, totalPages: 1 };
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
                ? plans.flatMap((plan) => plan.days.flatMap((day) => day.meals.map((meal) => meal.recipe))).find((recipe) => recipe && path === `/recipes/${recipe.id}`)
                : []) as never,
    ),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['config'], aPublicConfig({ catalogue: { depth } }));
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider client={client}>
        <MealPlansPage />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  return screen.findByRole('button', { name: messages.mealPlans.generateButton });
}

/** Make it the given day for the page, which reads the clock for what has passed. The date alone is replaced: the timers a test waits on stay real. */
const onTheDay = (day: string) => vi.useFakeTimers({ toFake: ['Date'], now: new Date(`${day}T12:00:00`) });

/** The window a plan is made again in, once it has read the plan. */
async function rerollWindow() {
  const dialog = within(await screen.findByRole('dialog', { name: messages.mealPlans.reroll.title }));
  await dialog.findByRole('button', { name: messages.mealPlans.reroll.confirm });
  return dialog;
}
const recalculate = (asked: Awaited<ReturnType<typeof rerollWindow>>) => userEvent.click(asked.getByRole('button', { name: messages.mealPlans.reroll.confirm }));

/** Ask for a plan and have the API refuse it for lack of a recipe. */
async function refusedWith(details: UnfilledMeal) {
  const generate = await renderPage();
  vi.spyOn(api, 'post').mockRejectedValue(
    new ApiClientError(400, 'NO_ELIGIBLE_RECIPE', 'the text of the API', undefined, undefined, details),
  );
  await userEvent.click(generate);
}

describe('the plan page, where the catalogue is short of recipes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('warns on the form when the profile\'s diet has no recipe for one of its meals', async () => {
    const depth = aDepth(9);
    depth.vegan = { 2: 9, 3: 9, 4: 0, 5: 0 };
    await renderPage(depth);

    expect(screen.getByRole('status').textContent).toContain('no plan can be made: choose another diet, or no more than 3 meals a day.');
  });

  it('warns that plans will repeat when one of the meals has few', async () => {
    const depth = aDepth(9);
    depth.vegan['4'] = 2;
    await renderPage(depth);

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
    vi.spyOn(api, 'post').mockRejectedValue(new ApiClientError(400, 'NO_ELIGIBLE_RECIPE', 'the text of the API'));
    await userEvent.click(generate);

    expect(await screen.findByText(messages.errors.NO_ELIGIBLE_RECIPE)).toBeInTheDocument();
  });
});

describe('the plan page, where a plan does not fit inside its limits', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const refusal = (details?: RelaxationNeeded) => new ApiClientError(422, 'PLAN_NEEDS_RELAXATION', 'the text of the API', undefined, undefined, details);
  const oneBreakfast: RelaxationNeeded = { needs: ['weekly_cap'], meals: [{ date: '2026-01-10', slot: 'breakfast', gaveWay: ['weekly_cap'] }] };
  const aRushedDay: RelaxationNeeded = {
    needs: ['cook_time'],
    meals: [
      { date: '2026-01-06', slot: 'breakfast', gaveWay: ['cook_time'] },
      { date: '2026-01-06', slot: 'dinner', gaveWay: ['cook_time'] },
    ],
  };
  const lettingGiveWay = (count: 1 | 2) => screen.findByRole('button', { name: count === 1 ? 'Make the plan and let this limit give way' : 'Make the plan and let these limits give way' });

  it('says which limits stand in the way and for which meals, and asks again with them once the user lets them give way', async () => {
    const generate = await renderPage();
    const post = vi.spyOn(api, 'post').mockRejectedValueOnce(refusal(oneBreakfast)).mockRejectedValueOnce(refusal(aRushedDay)).mockResolvedValue(aPlan() as never);
    await userEvent.click(generate);

    const notice = await screen.findByRole('alert');
    expect(notice.textContent).toContain('This plan cannot be filled inside its limits. One meal would go outside: times a week for one recipe.');
    expect(notice.textContent).toContain('Sat, Jan 10 · Breakfast: times a week for one recipe');
    expect((post.mock.calls[0]![1] as { allowRelaxations?: string[] }).allowRelaxations).toBeUndefined();

    await userEvent.click(await lettingGiveWay(1));
    // The second attempt needs another limit: what was let before stays let.
    expect((await screen.findByRole('alert')).textContent).toContain('2 meals would go outside: cooking time of the day.');
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
    await renderPage(aDepth(9), [plan]);
    const post = vi.spyOn(api, 'post').mockRejectedValueOnce(refusal(oneBreakfast)).mockResolvedValue(plan as never);

    await userEvent.click(await screen.findByRole('button', { name: messages.mealPlans.recalculate }));
    await recalculate(await rerollWindow());
    await userEvent.click(await lettingGiveWay(1));

    expect(post.mock.calls[0]).toEqual([`/meal-plans/${plan.id}/regenerate`, undefined]);
    expect(post.mock.calls[1]).toEqual([`/meal-plans/${plan.id}/regenerate`, { allowRelaxations: ['variety_floor', 'weekly_cap'] }]);
  });

  it('falls back on the general text for a refusal without details', async () => {
    const generate = await renderPage();
    vi.spyOn(api, 'post').mockRejectedValue(refusal());
    await userEvent.click(generate);

    expect(await screen.findByText(messages.errors.PLAN_NEEDS_RELAXATION)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('the plan page, on a plan and how it was made', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const open = async (plan: MealPlan) => {
    await renderPage(aDepth(9), [plan]);
    await userEvent.click(await screen.findByText('1-day plan · Vegan'));
  };

  it('marks a meal that is outside a limit, and one that was the only recipe to choose from', async () => {
    await open(
      aPlan({
        report: {
          relaxations: [{ date: '2026-01-05', slot: 'breakfast', gaveWay: ['consecutive_days', 'weekly_cap'] }],
          singleCandidate: [{ date: '2026-01-05', slot: 'breakfast' }],
          pantry: 'counted',
        },
      }),
    );

    // Each chip with what it means in words under the meal: a text that shows on hover says nothing to a finger.
    expect(screen.getByText('Outside a limit')).toBeInTheDocument();
    expect(screen.getByText('No recipe was left for this meal inside: days in a row with one recipe, times a week for one recipe.')).toBeVisible();
    expect(screen.getByText('Only recipe')).toBeInTheDocument();
    expect(screen.getByText(messages.mealPlans.onlyRecipeHint)).toBeVisible();
    expect(screen.getByText(messages.mealPlans.pantryCounted)).toBeInTheDocument();
  });

  it('says nothing of a meal the report does not speak of, nor of a pantry that is empty', async () => {
    await open(aPlan());

    expect(screen.queryByText('Outside a limit')).toBeNull();
    expect(screen.queryByText('Only recipe')).toBeNull();
    for (const line of [messages.mealPlans.pantryCounted, messages.mealPlans.pantryLeftOut, messages.mealPlans.pantryUnused]) expect(screen.queryByText(line)).toBeNull();
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
    const plan = aPlan({ options: { ...aPlan().options, allowRelaxations: ['cook_time', 'weekly_cap'] } });
    await open(plan);
    const post = vi.spyOn(api, 'post').mockResolvedValue(plan as never);

    expect(screen.getByText('This plan may go outside: cooking time of the day, times a week for one recipe.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.holdLimits }));
    // The window opens with every limit held: that is what was asked for.
    const asked = await rerollWindow();
    expect(asked.getByLabelText('Stay inside every limit this time. The plan may now go outside: cooking time of the day, times a week for one recipe.')).toBeChecked();
    await recalculate(asked);

    expect(post).toHaveBeenCalledWith(`/meal-plans/${plan.id}/regenerate`, { allowRelaxations: [] });
  });

  it('leaves the limits as the plan has them when the window is asked for nothing about them', async () => {
    onTheDay('2026-01-05');
    const plan = aPlan({ options: { ...aPlan().options, allowRelaxations: ['cook_time'] } });
    await open(plan);
    const post = vi.spyOn(api, 'post').mockResolvedValue(plan as never);

    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.recalculate }));
    const asked = await rerollWindow();
    expect(asked.getByLabelText(/^Stay inside every limit this time/)).not.toBeChecked();
    await recalculate(asked);

    expect(post).toHaveBeenCalledWith(`/meal-plans/${plan.id}/regenerate`, undefined);
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
        meals: one.days[0]!.meals.map((meal) => ({ ...meal, id: `3333333${i}-3333-4333-8333-333333333333` })),
      })),
    };
  };
  const open = async (plan: MealPlan) => {
    await renderPage(aDepth(9), [plan]);
    await userEvent.click(await screen.findByText('3-day plan · Vegan'));
  };
  /** The window for the whole of the plan, opened from the plan's own button. */
  const forThePlan = async (plan: MealPlan) => {
    await open(plan);
    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.recalculate }));
    return rerollWindow();
  };
  const refusal = (status: number, code: string) => new ApiClientError(status, code, 'the text of the API');
  const texts = messages.mealPlans.reroll;

  it('says in the window, before anything is asked of the API, what would be replaced and what kept', async () => {
    const post = vi.spyOn(api, 'post');
    const asked = await forThePlan(threeDays());

    expect(asked.getByText('Replaced: 2 meals on 2 days.')).toBeInTheDocument();
    expect(asked.getByText('1 day that has passed')).toBeInTheDocument();
    // Nothing on these days is eaten or the user's own: there is nothing to ask about either.
    expect(asked.queryByLabelText(texts.replaceEaten)).toBeNull();
    expect(asked.queryByLabelText(texts.replaceCustom)).toBeNull();

    await userEvent.click(asked.getByLabelText(texts.includePast));

    expect(asked.getByText('Replaced: 3 meals on 3 days.')).toBeInTheDocument();
    expect(asked.getByText(texts.keptNothing)).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it('asks for the whole plan with nothing of its own', async () => {
    const plan = threeDays();
    const asked = await forThePlan(plan);
    const post = vi.spyOn(api, 'post').mockResolvedValue(plan as never);

    await recalculate(asked);

    expect(post.mock.calls).toEqual([[`/meal-plans/${plan.id}/regenerate`, undefined]]);
    // The window closes on the request: what comes of it is said on the page.
    expect(screen.queryByRole('dialog', { name: texts.title })).toBeNull();
  });

  it('asks for what is left of the plan from today', async () => {
    const plan = threeDays();
    const asked = await forThePlan(plan);
    const post = vi.spyOn(api, 'post').mockResolvedValue(plan as never);

    await userEvent.click(asked.getByLabelText(texts.fromToday));
    expect(asked.getByText('1 day outside the days chosen')).toBeInTheDocument();
    await recalculate(asked);

    expect(post).toHaveBeenCalledWith(`/meal-plans/${plan.id}/regenerate`, { from: '2026-01-06' });
  });

  it('asks for the days from one day to another, and offers no last day before the first', async () => {
    const plan = threeDays();
    const asked = await forThePlan(plan);
    const post = vi.spyOn(api, 'post').mockResolvedValue(plan as never);

    await userEvent.click(asked.getByLabelText(texts.range));
    const last = asked.getByLabelText(texts.rangeTo);
    await userEvent.selectOptions(asked.getByLabelText(texts.rangeFrom), '2026-01-07');
    expect(within(last).getAllByRole('option').map((option) => (option as HTMLOptionElement).value)).toEqual(['2026-01-07']);

    await userEvent.selectOptions(asked.getByLabelText(texts.rangeFrom), '2026-01-06');
    await userEvent.selectOptions(last, '2026-01-06');
    await recalculate(asked);

    expect(post).toHaveBeenCalledWith(`/meal-plans/${plan.id}/regenerate`, { from: '2026-01-06', to: '2026-01-06' });
  });

  it('asks for one day, the one whose own button opened the window', async () => {
    const plan = threeDays();
    await open(plan);
    const post = vi.spyOn(api, 'post').mockResolvedValue(plan as never);

    await userEvent.click(screen.getAllByRole('button', { name: messages.mealPlans.changeDay })[2]!);
    const asked = await rerollWindow();

    expect(asked.getByLabelText(texts.day)).toBeChecked();
    expect(asked.getByLabelText(texts.dayWhich)).toHaveValue('2026-01-07');
    expect(asked.getByText('Replaced: 1 meal on 1 day.')).toBeInTheDocument();
    await recalculate(asked);

    expect(post.mock.calls).toEqual([[`/meal-plans/${plan.id}/days/${plan.days[2]!.id}/regenerate`, undefined]]);
  });

  it('asks about the meals that were eaten and the user\'s own where the days chosen hold them, and replaces them when told to', async () => {
    const plan = threeDays();
    const breakfast = plan.days[2]!.meals[0]!;
    plan.days[2]!.meals = [
      { ...breakfast, eatenAt: '2026-01-07T08:00:00.000Z' },
      { ...breakfast, id: '33333339-3333-4333-8333-333333333333', mealType: 'lunch', recipe: null, source: 'USER_CUSTOM', customName: 'Soup from the canteen' },
    ];
    const asked = await forThePlan(plan);
    const post = vi.spyOn(api, 'post').mockResolvedValue(plan as never);

    // The last day keeps both of its meals, so only today gets another.
    expect(asked.getByText('Replaced: 1 meal on 1 day.')).toBeInTheDocument();
    expect(asked.getByText('1 meal marked as eaten')).toBeInTheDocument();
    expect(asked.getByText('1 meal of your own')).toBeInTheDocument();

    await userEvent.click(asked.getByLabelText(texts.replaceEaten));
    await userEvent.click(asked.getByLabelText(texts.replaceCustom));
    expect(asked.getByText('Replaced: 3 meals on 2 days.')).toBeInTheDocument();
    await recalculate(asked);

    expect(post).toHaveBeenCalledWith(`/meal-plans/${plan.id}/regenerate`, { replaceEaten: true, replaceCustom: true });
  });

  it('asks for nothing while every day chosen has passed, says why, and asks for those days once it is told to', async () => {
    vi.setSystemTime(new Date('2026-02-01T12:00:00'));
    const plan = threeDays();
    const asked = await forThePlan(plan);
    const post = vi.spyOn(api, 'post').mockResolvedValue(plan as never);

    expect(asked.getByText(texts.nothingPast)).toBeInTheDocument();
    expect(asked.getByRole('button', { name: texts.confirm })).toBeDisabled();
    // What is left of a plan that is over is nothing: the choice is there, and says why it cannot be made.
    expect(asked.getByLabelText(texts.fromToday)).toBeDisabled();
    expect(asked.getByLabelText(texts.fromToday)).toHaveAccessibleDescription(texts.fromTodayOver);

    await userEvent.click(asked.getByLabelText(texts.includePast));
    await recalculate(asked);

    expect(post).toHaveBeenCalledWith(`/meal-plans/${plan.id}/regenerate`, { includePast: true });
  });

  it('says of a plan that has not begun that what is left of it is the whole of it', async () => {
    vi.setSystemTime(new Date('2026-01-02T12:00:00'));
    const asked = await forThePlan(threeDays());

    expect(asked.getByLabelText(texts.fromToday)).toBeDisabled();
    expect(asked.getByLabelText(texts.fromToday)).toHaveAccessibleDescription(texts.fromTodayNotBegun);
    expect(asked.queryByLabelText(texts.includePast)).toBeNull();
  });

  it.each([
    { code: 'NOTHING_TO_REGENERATE', status: 409, button: messages.mealPlans.includePastAndRetry, allowed: { includePast: true } },
    { code: 'LOCKED_RECIPE_INELIGIBLE', status: 400, button: messages.mealPlans.dropLockAndRetry, allowed: { dropIneligibleLocks: true } },
  ])('offers to send a request refused with $code again with what would let it through', async ({ code, status, button, allowed }) => {
    const plan = threeDays();
    const asked = await forThePlan(plan);
    const post = vi.spyOn(api, 'post').mockRejectedValueOnce(refusal(status, code)).mockResolvedValue(plan as never);

    await userEvent.click(asked.getByLabelText(texts.range));
    await recalculate(asked);
    expect(await screen.findByText(messages.errors[code as 'NOTHING_TO_REGENERATE'])).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: button }));

    // The same days, with that allowed.
    expect(post.mock.calls[1]).toEqual([`/meal-plans/${plan.id}/regenerate`, { from: '2026-01-06', to: '2026-01-07', ...allowed }]);
    await vi.waitFor(() => expect(screen.queryByRole('button', { name: button })).toBeNull());
  });
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
    await renderPage(aDepth(9), [plan]);
    await userEvent.click(await screen.findByText('1-day plan · Vegan'));
  };
  const theOffer = () => screen.findByRole('group', { name: messages.mealPlans.offerTitle });

  it('shows the recipe that is offered with what the swap would do, and makes the swap when the user takes it', async () => {
    await open();
    const post = vi.spyOn(api, 'post').mockResolvedValueOnce(scramble as never).mockResolvedValue({ plan, rebalance: null } as never);

    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.swap }));

    const offered = await theOffer();
    expect(offered.textContent).toContain('Instead: Tofu scramble, 1.5 servings: 240 kcal in place of 230.');
    expect(offered.textContent).toContain('Protein 14 g · fat 9 g · carbohydrate 26 g');
    expect(offered.textContent).toContain('The day would hold 240 of 2,000 kcal before its other meals are balanced around this one.');
    expect(post.mock.calls[0]).toEqual([
      '/meal-plans/swap-meal/preview',
      { planId: plan.id, plannedMealId: breakfast.id, strategy: 'random', respectInventory: true, allowOffDiet: false, skip: [] },
    ]);

    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.offerTake }));

    expect(post.mock.calls[1]).toEqual([
      '/meal-plans/swap-meal',
      { planId: plan.id, plannedMealId: breakfast.id, recipeId: scramble.recipe.id, revision: 0, strategy: 'random', allowOffDiet: false },
    ]);
    await vi.waitFor(() => expect(screen.queryByRole('group', { name: messages.mealPlans.offerTitle })).toBeNull());
  });

  it('asks for another recipe, naming the ones it was offered already', async () => {
    await open();
    const post = vi.spyOn(api, 'post').mockResolvedValueOnce(scramble as never).mockResolvedValueOnce(toast as never).mockResolvedValue(scramble as never);

    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.swap }));
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

    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.swap }));
    await theOffer();
    await userEvent.click(screen.getByRole('button', { name: messages.common.cancel }));

    expect(screen.queryByRole('group', { name: messages.mealPlans.offerTitle })).toBeNull();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('drops the offer and says so when the plan changed before it was taken', async () => {
    await open();
    vi.spyOn(api, 'post').mockResolvedValueOnce(scramble as never).mockRejectedValue(new ApiClientError(409, 'PLAN_CHANGED', 'the text of the API'));

    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.swap }));
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
    await renderPage(aDepth(9), [plan]);
    const get = vi.mocked(api.get);

    await screen.findByText('1-day plan · Vegan');
    // The calendar asks for the days of its month, in a request of its own.
    expect(get.mock.calls.map(([path]) => path).filter((path) => path.startsWith('/meal-plans') && !path.startsWith('/meal-plans/calendar?'))).toEqual([`/meal-plans?profileId=${profile.id}&page=1`]);
    expect(screen.queryByText(plan.days[0]!.date)).toBeNull();

    await userEvent.click(screen.getByText('1-day plan · Vegan'));

    // The day as the language of the application writes it, not as the API spells it.
    expect(await screen.findByText('Mon, Jan 5')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith(`/meal-plans/${plan.id}`);
  });

  it('pages through a list that is longer than a page, and begins at the first again when the list is narrowed', async () => {
    const summary = (({ days: _days, report: _report, targetMacros: _targetMacros, ...rest }) => rest)(aPlan());
    const get = vi.spyOn(api, 'get').mockImplementation((path: string) =>
      Promise.resolve(
        (path === '/profiles' ? [profile] : path === '/users/me' ? { aiMode: 'none' } : path.startsWith('/meal-plans?') ? { items: [summary], page: 1, pageSize: 20, total: 45, totalPages: 3 } : []) as never,
      ),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['config'], aPublicConfig({ catalogue: { depth: aDepth(9) } }));
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <QueryClientProvider client={client}>
          <MealPlansPage />
        </QueryClientProvider>
      </NextIntlClientProvider>,
    );
    const asked = (): string[] => get.mock.calls.map(([path]) => path).filter((path) => path.startsWith('/meal-plans?'));

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
  const aPlanWith = (meal: Partial<MealPlan['days'][number]['meals'][number]>, day: Partial<MealPlan['days'][number]> = {}, plan: Partial<MealPlan> = {}): MealPlan => {
    const base = aPlan(plan);
    return { ...base, days: [{ ...base.days[0]!, ...day, meals: [{ ...base.days[0]!.meals[0]!, ...meal }] }] };
  };
  const opened = async (plan: MealPlan, aiMode: 'none' | 'admin' = 'none') => {
    await renderPage(aDepth(9), [plan], aiMode);
    await userEvent.click(await screen.findByText('1-day plan · Vegan'));
    return screen.findByRole('button', { name: 'Oat porridge' });
  };
  const marks = (): string[] => screen.queryAllByText(messages.aiMark.label).map((mark) => mark.parentElement?.textContent ?? mark.textContent ?? '');

  it('marks no meal of a plan the engine made alone', async () => {
    await opened(aPlan());

    expect(marks()).toEqual([]);
  });

  it('keeps the model\'s swap in its place on an account with AI off, disabled, and says once over the plans why', async () => {
    await opened(aPlan());

    const swap = screen.getByRole('button', { name: messages.mealPlans.aiSwap });
    const notes = screen.getAllByText(/^AI is turned off for this account/);
    expect(swap).toBeDisabled();
    expect(notes).toHaveLength(1);
    expect(swap).toHaveAccessibleDescription(notes[0]!.textContent!);
    expect(screen.getByRole('link', { name: 'Turn AI on in Settings' })).toHaveAttribute('href', '/settings');
  });

  it('says nothing of the kind on an account that has a model to ask', async () => {
    await opened(aPlan(), 'admin');

    expect(screen.getByRole('button', { name: messages.mealPlans.aiSwap })).toBeEnabled();
    expect(screen.queryByText(/^AI is turned off for this account/)).toBeNull();
  });

  it('marks a meal whose recipe a model chose, says why, and says it again where the recipe is opened', async () => {
    const recipe = await opened(aPlanWith({ modelPick: { reason: 'Lighter than the porridge.' } }));

    expect(marks()).toHaveLength(1);
    expect(marks()[0]).toContain('A model chose this recipe for the meal: “Lighter than the porridge.”');

    await userEvent.click(recipe);

    const window = await screen.findByRole('dialog', { name: messages.recipeModal.title });
    expect(window.textContent).toContain('A model chose this recipe for the meal: “Lighter than the porridge.”');
  });

  it('names the cuisine of a recipe where the recipe is opened, and none for a recipe that belongs to none', async () => {
    const plain = aPlan();
    const meal = plain.days[0]!.meals[0]!;
    const recipe = await opened({ ...plain, days: [{ ...plain.days[0]!, meals: [{ ...meal, recipe: { ...meal.recipe!, cuisine: 'asian' } }] }] });

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
    await renderPage(aDepth(9), [aPlan({ generationMode: 'ai_assisted' })]);

    const row = await screen.findByText('1-day plan · Vegan');
    expect(row.textContent).toContain(messages.aiMark.label);
    expect(row.textContent).toContain(messages.aiMark.plan);
  });

  describe('when a model is asked for another recipe', () => {
    const plan = aPlan();
    const breakfast = plan.days[0]!.meals[0]!;
    const offered = (by: 'model' | 'engine') => ({
      recipe: { ...breakfast.recipe!, id: '66666666-6666-4666-8666-666666666666', title: 'Tofu scramble' },
      servings: 1.5,
      before: breakfast.nutrition,
      after: { calories: 240, protein: 14, fat: 9, carbs: 26 },
      dayBefore: plan.days[0]!.dayNutrition,
      dayAfter: { calories: 240, protein: 14, fat: 9, carbs: 26 },
      calorieTarget: 2000,
      revision: 0,
      aiMeta:
        by === 'model'
          ? { provider: 'ollama', model: 'a-model', failoverChain: [], usedDeterministicFallback: false, fallbackReason: null, reason: 'More protein to start the day.' }
          : { provider: null, model: null, failoverChain: [], usedDeterministicFallback: true, fallbackReason: 'all_providers_failed', reason: null },
      pick: by === 'model' ? 'the-note-the-api-signed' : null,
    });
    const ask = async (by: 'model' | 'engine') => {
      await opened(plan, 'admin');
      const post = vi.spyOn(api, 'post').mockResolvedValueOnce(offered(by) as never).mockResolvedValue({ plan, rebalance: null } as never);
      await userEvent.click(screen.getByRole('button', { name: new RegExp(messages.mealPlans.aiSwap) }));
      return { post, offer: await screen.findByRole('group', { name: messages.mealPlans.offerTitle }) };
    };

    it('says that the offer is the model\'s own pick, with its reason, and hands the note back when the offer is taken', async () => {
      const { post, offer } = await ask('model');

      expect(offer.textContent).toContain(messages.aiMark.label);
      expect(offer.textContent).toContain('A model chose this recipe for the meal: “More protein to start the day.”');

      await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.offerTake }));

      expect(post.mock.calls[1]).toEqual([
        '/meal-plans/swap-meal',
        { planId: plan.id, plannedMealId: breakfast.id, recipeId: '66666666-6666-4666-8666-666666666666', revision: 0, strategy: 'random', allowOffDiet: false, pick: 'the-note-the-api-signed' },
      ]);
    });

    it('does not say so of an offer the engine made in the model\'s place, and hands no note back', async () => {
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
    await renderPage(aDepth(9), [plan]);
    await userEvent.click(await screen.findByText('1-day plan · Vegan'));
    await screen.findByRole('button', { name: 'Oat porridge' });
  };

  describe('of the packs that do not keep once opened', () => {
    const chicken = { ingredientId: '66666666-6666-4666-8666-666666666666', name: 'Chicken breast', unit: 'g', packSize: 500, packs: 2, left: 20, wasted: false } as const;
    const milk = { ingredientId: '77777777-7777-4777-8777-777777777777', name: 'Whole milk', unit: 'ml', packSize: 1000, packs: 1, left: 500, wasted: true } as const;
    const feta = { ingredientId: '88888888-8888-4888-8888-888888888888', name: 'Feta cheese', unit: 'g', packSize: 200, packs: 1, left: 160, wasted: true } as const;

    it('says how much of what the menu buys it uses, and how many packs it leaves more than three tenths of', async () => {
      await opened(aPlan({ packs: { bought: 2200, used: 1520, open: [feta, milk, chicken] } }));

      const line = screen.getByText('Packs that do not keep once opened: the menu uses 69% of what it buys, and leaves more than three tenths of 2 packs.');
      expect(line).toBeVisible();
      // Unfolded, it names every pack that is not finished: the ones with much left as such.
      await userEvent.click(line);
      const packs = within(line.closest('details')!).getAllByRole('listitem').map((pack) => pack.textContent);
      expect(packs).toEqual([
        'Feta cheese: 160 g left of a pack of 200 g, more than three tenths of it',
        'Whole milk: 500 ml left of a pack of 1000 ml, more than three tenths of it',
        'Chicken breast: 20 g left of a pack of 500 g',
      ]);
      expect(screen.getByText(messages.mealPlans.packs.explain)).toBeInTheDocument();
    });

    it('says so when one pack is left much of, and when none is', async () => {
      await opened(aPlan({ packs: { bought: 1500, used: 980, open: [milk, chicken] } }));

      expect(screen.getByText('Packs that do not keep once opened: the menu uses 65% of what it buys, and leaves more than three tenths of 1 pack.')).toBeVisible();
    });

    it('says that every pack is used up when the menu finishes them all', async () => {
      await opened(aPlan({ packs: { bought: 500, used: 500, open: [] } }));

      await userEvent.click(screen.getByText('Packs that do not keep once opened: the menu uses 100% of what it buys.'));
      expect(screen.getByText(messages.mealPlans.packs.allFinished)).toBeInTheDocument();
    });

    it('says nothing of packs of a plan whose menu opens none', async () => {
      await opened(aPlan());

      expect(screen.queryByText(/^Packs that do not keep/)).toBeNull();
    });
  });

  it('says what the day holds of protein, fat and carbohydrate against what it aims at', async () => {
    await opened(aPlan());

    expect(screen.getByText('Protein 8 of 100 g · fat 4 of 62 g · carbs 40 of 260 g')).toBeInTheDocument();
    expect(screen.getByText('A day of this plan holds on average: protein 8 of 100 g · fat 4 of 62 g · carbs 40 of 260 g.')).toBeInTheDocument();
  });

  it.each([
    ['over', messages.mealPlans.dayOver, messages.mealPlans.dayOverHint],
    ['under', messages.mealPlans.dayUnder, messages.mealPlans.dayUnderHint],
  ] as const)('says on the day, for as long as it is so, that it stands %s its target, and what can be done', async (offTarget, label, hint) => {
    await opened(aDay({ offTarget }));

    expect(screen.getByText(label)).toBeVisible();
    expect(screen.getByText(hint)).toBeVisible();
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
    const meals = [{ ...breakfast, ...first }, ...(second ? [{ ...breakfast, id: '33333338-3333-4333-8333-333333333333', mealType: 'lunch' as const, ...second }] : [])];
    return { ...plan, days: [{ ...plan.days[0]!, meals }] };
  };
  const opened = async (plan: MealPlan) => {
    await renderPage(aDepth(9), [plan]);
    await userEvent.click(await screen.findByText('1-day plan · Vegan'));
    await screen.findAllByRole('button', { name: 'Oat porridge' });
  };

  it('marks, in a plan made for cooking ahead, the meal a dish is cooked at and the one it is eaten from', async () => {
    await opened(aPlanOf({ cookAhead: 'cook' }, { cookAhead: 'cooked' }));

    for (const text of ['cookOnceChip', 'cookOnceHint', 'cookedChip', 'cookedHint'] as const) expect(screen.getByText(messages.mealPlans[text])).toBeVisible();
  });

  it('says nothing of cooking ahead of a meal that is cooked for itself', async () => {
    await opened(aPlanOf({}, {}));

    expect(screen.queryByText(messages.mealPlans.cookOnceChip)).toBeNull();
    expect(screen.queryByText(messages.mealPlans.cookedChip)).toBeNull();
  });

  it('says over the days how many meals hold what the profile has ruled out since, and under each of them what and what to do', async () => {
    await opened(aPlanOf({ restrictionConflicts: ['allergen'] }, { restrictionConflicts: ['excluded_ingredient', 'avoided'] }));

    expect(screen.getByRole('alert').textContent).toBe(
      '2 meals of this plan hold something the profile has ruled out since the plan was made. Each is marked below: swap it, or recalculate the plan.',
    );
    for (const conflict of ['allergen', 'excluded_ingredient', 'avoided'] as const) {
      expect(screen.getByText(messages.mealPlans.conflictChip[conflict])).toBeVisible();
      expect(screen.getByText(messages.mealPlans.conflictHint[conflict])).toBeVisible();
    }
  });

  it('counts one such meal as one', async () => {
    await opened(aPlanOf({ restrictionConflicts: ['allergen', 'avoided'] }, {}));

    expect(screen.getByRole('alert').textContent).toContain('One meal of this plan holds something the profile has ruled out');
  });

  it('says of a meal outside the diet of the plan that it is, and that it stays until it is swapped', async () => {
    await opened(aPlanOf({ dietOverride: true }));

    expect(screen.getByText(messages.mealPlans.dietOverrideChip)).toBeVisible();
    expect(screen.getByText('This recipe does not fit the diet of the plan (Vegan). It stays until you swap it.')).toBeVisible();
    // Outside the diet is the user's to decide: nothing has been ruled out.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('names what a meal holds that the profile would rather not eat, and why it may be there', async () => {
    const oats = { ingredientId: '55555555-5555-4555-8555-555555555555', name: 'Rolled oats', quantity: 60, unit: 'g' as const, display: { quantity: 60, unit: 'g' as const }, note: null };
    const milk = { ...oats, ingredientId: '66666666-6666-4666-8666-666666666666', name: 'Whole milk' };
    await opened(aPlanOf({ ingredients: [oats, milk], dislikedIngredientIds: [oats.ingredientId, milk.ingredientId] }, { ingredients: [oats, milk] }));

    expect(screen.getAllByText(messages.mealPlans.dislikedChip)).toHaveLength(1);
    expect(screen.getByText(/^Holds Rolled oats and Whole milk, which this profile would rather not eat/)).toBeVisible();
    // Something a profile would rather not eat is not something it has ruled out.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says nothing of the kind of a plan whose meals are as the profile and the diet have them', async () => {
    await opened(aPlanOf({}));

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(messages.mealPlans.dietOverrideChip)).toBeNull();
    for (const conflict of ['allergen', 'excluded_ingredient', 'avoided'] as const) expect(screen.queryByText(messages.mealPlans.conflictChip[conflict])).toBeNull();
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

  it('offers the profile\'s diet, meals and target as what a plan is made for unless the form says otherwise', async () => {
    await renderPage();

    expect(screen.getByRole('option', { name: 'As in the profile (Vegan)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'As in the profile (4)' })).toBeInTheDocument();
    expect(await screen.findByText(/Empty: the profile’s target, 2,209 kcal a day\./)).toBeInTheDocument();
    expect(screen.getByLabelText(messages.mealPlans.calorieTarget)).toHaveAttribute('placeholder', '2209');
  });

  it('leaves all three to the profile when the form says nothing, so that the plan follows the profile when it is made again', async () => {
    await renderPage();

    const body = await sent();

    expect(body).toMatchObject({ profileId: profile.id, durationDays: 7 });
    for (const key of ['dietType', 'mealCount', 'calorieTargetOverride']) expect(body).not.toHaveProperty(key);
  });

  it('asks for the diet, the meals a day and the target the form names, for this plan', async () => {
    await renderPage();
    await userEvent.selectOptions(screen.getByLabelText(messages.mealPlans.diet), 'high_protein');
    await userEvent.selectOptions(screen.getByLabelText(messages.mealPlans.mealsPerDay), '5');
    await userEvent.type(screen.getByLabelText(messages.mealPlans.calorieTarget), '1800');

    expect(await sent()).toMatchObject({ dietType: 'high_protein', mealCount: 5, calorieTargetOverride: 1800 });
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

    expect(screen.getByRole('option', { name: 'Custom (30 % protein, 40 % fat, 30 % carbohydrate)' })).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText(messages.mealPlans.diet), 'custom');

    expect(await sent()).toMatchObject({ dietType: 'custom' });
  });

  it('warns about the diet and the meals the form names, not the profile\'s, and says of each diet what the catalogue has for it', async () => {
    const depth = aDepth(9);
    depth.keto = { 2: 9, 3: 9, 4: 0, 5: 0 };
    depth.low_carb['4'] = 2;
    await renderPage(depth);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('option', { name: 'Keto (no recipes yet)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Low carb (few recipes)' })).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText(messages.mealPlans.diet), 'keto');
    expect(screen.getByRole('status').textContent).toContain('no plan can be made: choose another diet, or no more than 3 meals a day.');

    // Three meals a day, and the same diet has enough.
    await userEvent.selectOptions(screen.getByLabelText(messages.mealPlans.mealsPerDay), '3');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('fills a day from a favourite set: its recipes for the meals the day has are locked before the plan is made', async () => {
    favoriteSets = [
      { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', profileId: profile.id, label: 'Workday', slots: { breakfast: 'r-breakfast', dinner: 'r-dinner', second_breakfast: 'r-second' }, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    ];
    await renderPage();
    await userEvent.click(screen.getByText(messages.mealPlans.advanced.toggle));
    const firstDay = (await screen.findAllByLabelText(messages.mealPlans.advanced.favoriteSet))[0]!;

    await userEvent.selectOptions(firstDay, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

    const { dayOverrides } = (await sent()) as { dayOverrides: { date: string; lockedSlots: { mealType: string; recipeId: string }[] }[] };
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
  const listsAsked = (): string[] => vi.mocked(api.get).mock.calls.map(([path]) => path).filter((path) => path.startsWith('/meal-plans?'));

  it('asks for the month it is for the profile whose plans the page shows', async () => {
    await renderPage(aDepth(9), [aPlan()]);

    expect(await screen.findByRole('grid', { name: 'January 2026' })).toBeInTheDocument();
    expect(vi.mocked(api.get)).toHaveBeenCalledWith(`/meal-plans/calendar?profileId=${profile.id}&from=2025-12-29&to=2026-02-01`);
  });

  it('opens the plan of a day that is chosen, with the list narrowed to the plans of that day, and goes to the day', async () => {
    const plan = aPlan();
    await renderPage(aDepth(9), [plan]);

    await userEvent.click(await screen.findByRole('button', { name: /^Mon, Jan 5: 230 of 2,000 kcal/ }));

    await vi.waitFor(() => expect(listsAsked().at(-1)).toBe(`/meal-plans?profileId=${profile.id}&page=1&from=2026-01-05&to=2026-01-05`));
    expect(vi.mocked(api.get)).toHaveBeenCalledWith(`/meal-plans/${plan.id}`);
    // The plan is open, and the reader is at the day that was chosen.
    await vi.waitFor(() => expect(document.getElementById(`plan-${plan.id}-2026-01-05`)).toHaveFocus());
    expect(screen.getByLabelText(texts.from)).toHaveValue('2026-01-05');
    expect(screen.getByLabelText(texts.to)).toHaveValue('2026-01-05');
  });

  it('takes a day without a plan as the day the next plan begins on, and puts the reader at the form', async () => {
    await renderPage(aDepth(9), [aPlan()]);
    const startDate = screen.getByLabelText(texts.startDate);
    expect(startDate).toHaveValue('2026-01-05');

    await userEvent.click(await screen.findByRole('button', { name: /^Fri, Jan 9: no plan/ }));

    expect(startDate).toHaveValue('2026-01-09');
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
    await renderPage(aDepth(9), [aPlan()]);
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
    expect(file.slice(1).split('\r\n')).toEqual(['Date,Meal,Dish,Servings,kcal,Protein (g),Fat (g),Carbohydrate (g),Eaten', '2026-01-05,Breakfast,Oat porridge,1,230,8,4,40,No', '']);
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
    expect(within(sheet).getByRole('heading', { level: 1 })).toHaveTextContent(/^Meal plan, Jan 5.*2026 · Vegan$/);
    expect(within(sheet).getByRole('heading', { level: 2 })).toHaveTextContent('Mon, Jan 5230 of 2,000 kcal');
    expect(within(sheet).getAllByRole('row').map((row) => row.textContent)).toEqual(['MealDishServingskcalProtein (g)Fat (g)Carbohydrate (g)', 'BreakfastOat porridge12308440']);
    expect(print).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event('afterprint'));

    await vi.waitFor(() => expect(document.querySelector('.print-sheet')).toBeNull());
  });
});

describe('the plan page, on what the planner proposes for a plan', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const chicken = { ingredientId: '66666666-6666-4666-8666-666666666666', name: 'Chicken breast', unit: 'g', packSize: 500, packs: 1, left: 350, wasted: true } as const;
  const opened = async (plan: MealPlan, aiMode: 'none' | 'admin' = 'none') => {
    await renderPage(aDepth(9), [plan], aiMode);
    await userEvent.click(await screen.findByText('1-day plan · Vegan'));
    await screen.findByRole('button', { name: 'Oat porridge' });
  };

  it('offers other ways to fill a day in a window of its own, asked of the API for that day of that plan', async () => {
    const plan = aPlan();
    await opened(plan);
    const post = vi.spyOn(api, 'post').mockResolvedValue({ date: '2026-01-05', calorieTarget: 2000, current: { dayNutrition: plan.days[0]!.dayNutrition, packs: { bought: 0, used: 0, wasted: 0 } }, variations: [], aiMeta: null } as never);

    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.otherWays }));

    const dialog = within(await screen.findByRole('dialog', { name: 'Other ways to fill Mon, Jan 5' }));
    expect(post).toHaveBeenCalledWith(`/meal-plans/${plan.id}/days/${plan.days[0]!.id}/variations`, { weigh: false });
    expect(await dialog.findByText(messages.mealPlans.variations.none)).toBeInTheDocument();
  });

  it('offers no other ways for a day the user skips', async () => {
    const plan = aPlan();
    await renderPage(aDepth(9), [{ ...plan, days: [{ ...plan.days[0]!, skipped: true, meals: [] }] }]);
    await userEvent.click(await screen.findByText('1-day plan · Vegan'));
    await screen.findByText(messages.mealPlans.daySkipped);

    expect(screen.queryByRole('button', { name: messages.mealPlans.otherWays })).toBeNull();
  });

  it('offers, with the packs a plan leaves more than three tenths of, to look for what would use them up', async () => {
    const plan = aPlan({ packs: { bought: 500, used: 150, open: [chicken] } });
    await opened(plan);
    const post = vi.spyOn(api, 'post').mockResolvedValue({ revision: 0, suggestions: [], aiMeta: null } as never);

    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.useUp.ask }));

    expect(post).toHaveBeenCalledWith(`/meal-plans/${plan.id}/use-up`, { weigh: false });
    expect(await screen.findByText(messages.mealPlans.useUp.none)).toBeInTheDocument();
  });

  it('does not offer that for a plan whose packs are used well enough', async () => {
    await opened(aPlan({ packs: { bought: 500, used: 480, open: [{ ...chicken, left: 20, wasted: false }] } }));

    expect(screen.queryByRole('button', { name: messages.mealPlans.useUp.ask })).toBeNull();
  });
});
