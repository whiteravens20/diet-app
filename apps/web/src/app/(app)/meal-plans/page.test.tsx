// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CatalogueDepth, MealPlan, Profile, RelaxationNeeded, UnfilledMeal } from '@diet-app/shared';
import { api, ApiClientError } from '@/lib/api';
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
  activityLevel: 'moderate',
  dietType: 'vegan',
  weeklyLossTarget: '0.5',
  manualCalorieTarget: null,
  riskAcknowledgedAt: null,
  mealCount: 4,
  weightReminderCadence: 'weekly',
  preferences: {
    favoriteIngredientIds: [],
    excludedIngredientIds: [],
    allergens: [],
    dislikedFoods: [],
    preferredCuisines: [],
    maxConsecutiveDaysSameMeal: 2,
    maxTimesPerWeekSameMeal: 3,
    inventoryBiasResetEvery: 5,
  },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const nothing = { calories: 0, protein: 0, fat: 0, carbs: 0 };

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
            allergens: [],
            nutritionPerServing: { calories: 230, protein: 8, fat: 4, carbs: 40 },
            reuseScore: 0,
            origin: 'seed',
          },
          ingredients: [],
          source: 'CATALOGUE',
          customName: null,
          servings: 1,
          quantityScale: 1,
          eatenAt: null,
          dietOverride: false,
          restrictionConflicts: [],
          nutrition: { calories: 230, protein: 8, fat: 4, carbs: 40 },
        },
      ],
      dayNutrition: { calories: 230, protein: 8, fat: 4, carbs: 40 },
      calorieTarget: 2000,
      calorieDelta: -1770,
      skipped: false,
      belowSafetyFloor: false,
      overrides: null,
    },
  ],
  averageDailyNutrition: { calories: 230, protein: 8, fat: 4, carbs: 40 },
  targetMacros: nothing,
  ingredientReuseScore: 0,
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
  report: { relaxations: [], singleCandidate: [], pantryBiasApplied: false },
  revision: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

/** The page of somebody with that one profile and `plans`, on an instance whose catalogue has `depth`. */
async function renderPage(depth: CatalogueDepth = aDepth(9), plans: MealPlan[] = []) {
  vi.spyOn(api, 'get').mockImplementation((path: string) =>
    Promise.resolve(
      (path === '/profiles' ? [profile] : path === '/users/me' ? { aiMode: 'none' } : path.startsWith('/meal-plans') ? plans : []) as never,
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
        'There is no recipe for "Snack" on the "Vegan" diet, so the plan could not be made. Choose another diet or fewer meals a day in the profile.',
      ),
    ).toBeInTheDocument();
  });

  it('does not advise fewer meals for a meal that every day has', async () => {
    await refusedWith({ slot: 'breakfast', dietType: 'vegan', ruledOut: 0 });

    expect(
      await screen.findByText(
        'There is no recipe for "Breakfast" on the "Vegan" diet, so the plan could not be made. Choose another diet in the profile.',
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
    expect(notice.textContent).toContain('2026-01-10 · Breakfast: times a week for one recipe');
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
    const plan = aPlan({ options: { ...aPlan().options, allowRelaxations: ['variety_floor'] } });
    await renderPage(aDepth(9), [plan]);
    const post = vi.spyOn(api, 'post').mockRejectedValueOnce(refusal(oneBreakfast)).mockResolvedValue(plan as never);

    await userEvent.click(await screen.findByRole('button', { name: messages.mealPlans.recalculate }));
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
          pantryBiasApplied: true,
        },
      }),
    );

    expect(screen.getByText('Outside a limit')).toHaveAttribute('title', 'No recipe was left for this meal inside: days in a row with one recipe, times a week for one recipe.');
    expect(screen.getByText('Only recipe')).toBeInTheDocument();
    expect(screen.getByText(messages.mealPlans.pantryCounted)).toBeInTheDocument();
  });

  it('says nothing of a meal the report does not speak of, and that the pantry did not count when it did not', async () => {
    await open(aPlan());

    expect(screen.queryByText('Outside a limit')).toBeNull();
    expect(screen.queryByText('Only recipe')).toBeNull();
    expect(screen.getByText(messages.mealPlans.pantryNotCounted)).toBeInTheDocument();
  });

  it('names the limits a plan may go outside, and makes it again inside every limit when asked', async () => {
    const plan = aPlan({ options: { ...aPlan().options, allowRelaxations: ['cook_time', 'weekly_cap'] } });
    await open(plan);
    const post = vi.spyOn(api, 'post').mockResolvedValue(plan as never);

    expect(screen.getByText('This plan may go outside: cooking time of the day, times a week for one recipe.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.holdLimits }));

    expect(post).toHaveBeenCalledWith(`/meal-plans/${plan.id}/regenerate`, { allowRelaxations: [] });
  });

  it('says nothing of how a plan was made when the plan is from before that was kept', async () => {
    await open(aPlan({ report: null }));

    expect(screen.queryByText(messages.mealPlans.pantryNotCounted)).toBeNull();
    expect(screen.queryByText(messages.mealPlans.pantryCounted)).toBeNull();
  });
});

describe('the plan page, when a plan is made again', () => {
  afterEach(() => {
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
  const refusal = (status: number, code: string) => new ApiClientError(status, code, 'the text of the API');

  it('says what stays as it is', async () => {
    await open(threeDays());

    expect(screen.getByText(messages.mealPlans.rerollKeeps)).toBeInTheDocument();
  });

  it('asks for the days from one day to another, when the user picks them', async () => {
    const plan = threeDays();
    await open(plan);
    const post = vi.spyOn(api, 'post').mockResolvedValue(plan as never);

    await userEvent.selectOptions(screen.getByLabelText(messages.mealPlans.rangeFrom), '2026-01-06');
    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.recalculateRange }));

    expect(post).toHaveBeenCalledWith(`/meal-plans/${plan.id}/regenerate`, { from: '2026-01-06', to: '2026-01-07' });
  });

  it('does not offer days in the wrong order', async () => {
    await open(threeDays());

    await userEvent.selectOptions(screen.getByLabelText(messages.mealPlans.rangeFrom), '2026-01-07');
    await userEvent.selectOptions(screen.getByLabelText(messages.mealPlans.rangeTo), '2026-01-05');

    expect(screen.getByRole('button', { name: messages.mealPlans.recalculateRange })).toBeDisabled();
  });

  it.each([
    { code: 'NOTHING_TO_REGENERATE', status: 409, button: messages.mealPlans.includePastAndRetry, allowed: { includePast: true } },
    { code: 'LOCKED_RECIPE_INELIGIBLE', status: 400, button: messages.mealPlans.dropLockAndRetry, allowed: { dropIneligibleLocks: true } },
  ])('offers to send a request refused with $code again with what would let it through', async ({ code, status, button, allowed }) => {
    const plan = threeDays();
    await open(plan);
    const post = vi.spyOn(api, 'post').mockRejectedValueOnce(refusal(status, code)).mockResolvedValue(plan as never);

    await userEvent.selectOptions(screen.getByLabelText(messages.mealPlans.rangeTo), '2026-01-06');
    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.recalculateRange }));
    expect(await screen.findByText(messages.errors[code as 'NOTHING_TO_REGENERATE'])).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: button }));

    // The same days, with that allowed.
    expect(post.mock.calls[1]).toEqual([`/meal-plans/${plan.id}/regenerate`, { from: '2026-01-05', to: '2026-01-06', ...allowed }]);
    await vi.waitFor(() => expect(screen.queryByRole('button', { name: button })).toBeNull());
  });

  it('asks for one day with nothing of its own, and for the whole plan likewise', async () => {
    const plan = threeDays();
    await open(plan);
    const post = vi.spyOn(api, 'post').mockResolvedValue(plan as never);

    await userEvent.click(screen.getAllByRole('button', { name: messages.mealPlans.changeDay })[1]!);
    await userEvent.click(screen.getByRole('button', { name: messages.mealPlans.recalculate }));

    expect(post.mock.calls).toEqual([
      [`/meal-plans/${plan.id}/days/${plan.days[1]!.id}/regenerate`, undefined],
      [`/meal-plans/${plan.id}/regenerate`, undefined],
    ]);
  });
});
