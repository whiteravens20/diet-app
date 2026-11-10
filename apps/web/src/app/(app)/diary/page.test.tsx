// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiaryDay, DiaryEntry } from '@diet-app/shared';
import { DIARY_DAYS_BACK } from '@diet-app/shared/constants';
import { api } from '@/lib/api';
import { localDate } from '@/lib/http';
import { dayAfter } from '@/lib/plan-dates';
import { aPublicConfig } from '@/testing/public-config';
import { spaced } from '@/testing/spaces';
import messages from '../../../../messages/en.json';
import DiaryPage from './page';

/** What the address of the page says after its question mark: empty unless a test is about a link that leads here. */
const address = vi.hoisted(() => ({ search: '' }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(address.search) }));

const texts = messages.diary;
const PROFILE = '6f1c2b1e-7a52-4a3a-9d0e-0a1b2c3d4e5f';
const PLAN = '11111111-1111-4111-8111-111111111111';
const OATS = '33333333-3333-4333-8333-333333333331';
const SOUP = '33333333-3333-4333-8333-333333333332';
const RECIPE = '44444444-4444-4444-8444-444444444444';
const TODAY = localDate();

/** An entry of a meal of one's own of `kcal`, under lunch. */
const anEntry = (over: Partial<DiaryEntry> = {}): DiaryEntry => ({
  id: '55555555-5555-4555-8555-555555555551',
  profileId: PROFILE,
  date: TODAY,
  mealType: 'lunch',
  kind: 'meal',
  name: 'Soup from the canteen',
  recipeId: null,
  ingredientId: null,
  productId: null,
  productCode: null,
  productSource: null,
  servings: 1,
  amount: null,
  nutrition: { calories: 300, protein: 19, fat: 10, carbs: 34 },
  label: null,
  labelAtLeast: [],
  estimated: true,
  createdAt: `${TODAY}T12:00:00.000Z`,
  ...over,
});

/** A day of the plan with oats for breakfast, eaten, and a soup for dinner, and the entries given. */
const aDay = (over: Partial<DiaryDay> = {}): DiaryDay => ({
  profileId: PROFILE,
  date: TODAY,
  target: { calories: 2000, protein: 125, fat: 67, carbs: 225, from: 'plan' },
  plan: {
    id: PLAN,
    skipped: false,
    meals: [
      {
        id: OATS,
        mealType: 'breakfast',
        name: 'Oat porridge',
        recipeId: RECIPE,
        eaten: true,
        nutrition: { calories: 450, protein: 15, fat: 9, carbs: 75 },
        label: { fiber: null, sugars: null, salt: null, saturatedFat: null },
        fromPot: false,
      },
      {
        id: SOUP,
        mealType: 'dinner',
        name: 'Tomato soup',
        recipeId: RECIPE,
        eaten: false,
        nutrition: { calories: 600, protein: 25, fat: 20, carbs: 80 },
        label: { fiber: null, sugars: null, salt: null, saturatedFat: null },
        fromPot: false,
      },
    ],
    calorieDelta: 150,
    offTarget: null,
  },
  entries: [anEntry()],
  eaten: { calories: 750, protein: 34, fat: 19, carbs: 109 },
  eatenLabel: { fiber: null, sugars: null, salt: null, saturatedFat: null },
  labelNotes: [],
  estimated: true,
  ...over,
});

/** The days the page asked for, in order. */
let askedDays: string[] = [];

/**
 * The page of an account of one profile whose diary answers `days` (by date, the day given
 * otherwise); the profile tracks water unless `tracksWater` says it does not.
 */
async function renderPage(
  day: DiaryDay = aDay(),
  days: Record<string, DiaryDay> = {},
  tracksWater = true,
) {
  askedDays = [];
  vi.spyOn(api, 'get').mockImplementation((path: string) => {
    if (path.startsWith('/diary/day?')) {
      const date = new URLSearchParams(path.slice('/diary/day?'.length)).get('date')!;
      askedDays.push(date);
      return Promise.resolve((days[date] ?? { ...day, date }) as never);
    }
    if (path === '/profiles')
      return Promise.resolve([
        { id: PROFILE, name: 'Me', mealCount: 3, waterTracking: tracksWater },
      ] as never);
    // The day's water and the week in sum, which the page shows beside the day.
    if (path.startsWith('/water?'))
      return Promise.resolve({
        day: day.date,
        ml: 0,
        target: 1500,
        entries: 0,
        last: null,
        days: Array.from({ length: 7 }, (_, at) => ({ day: dayAfter(day.date, at - 6), ml: 0 })),
      } as never);
    if (path.startsWith('/diary/week?'))
      return Promise.resolve({
        from: day.date,
        to: day.date,
        counted: 0,
        empty: 7,
        eaten: null,
        target: null,
        withinTarget: 0,
        water: { counted: 0, averageMl: null, target: 1500, reached: 0 },
        weight: { kgPerWeek: null, targetKg: null, reachesTargetOn: null },
      } as never);
    if (path.startsWith('/recipes?'))
      return Promise.resolve({
        items: [{ id: RECIPE, title: 'Oat porridge', nutritionPerServing: { calories: 320 } }],
        page: 1,
        pageSize: 8,
        total: 1,
        totalPages: 1,
      } as never);
    return Promise.resolve([] as never);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['config'], aPublicConfig());
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider client={client}>
        <DiaryPage />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  await screen.findByText('2000', { exact: false });
}

describe('the diary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    address.search = '';
  });

  it("shows what was eaten against the day's target, and each meal with what its plan has and what was written for it", async () => {
    await renderPage();

    expect(screen.getByText(/750 of 2000 kcal/)).toBeInTheDocument();
    expect(screen.getByText(texts.estimatedNote)).toBeInTheDocument();
    expect(screen.getByText(texts.targetFromPlan)).toBeInTheDocument();
    // The meals in the order they are eaten: those of the plan and the one something was written for.
    expect(
      screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent),
    ).toEqual(['Eaten', 'Breakfast', 'Lunch', 'Dinner', texts.copyTitle]);
    const breakfast = within(screen.getByRole('region', { name: 'Breakfast' }));
    expect(breakfast.getByRole('checkbox', { name: texts.eatenToggle })).toBeChecked();
    const lunch = within(screen.getByRole('region', { name: 'Lunch' }));
    expect(lunch.getByText('Soup from the canteen')).toBeInTheDocument();
    expect(lunch.getByText(`≈ ${texts.estimated}`)).toBeInTheDocument();
    expect(screen.getByText(texts.planOnTarget)).toBeInTheDocument();
  });

  it('opens on the day a link names, and goes to the days on either side and back to today', async () => {
    const yesterday = dayAfter(TODAY, -1);
    address.search = `profile=${PROFILE}&date=${yesterday}`;
    await renderPage();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: texts.previousDay }));
    await screen.findByDisplayValue(dayAfter(TODAY, -2));
    await user.click(screen.getByRole('button', { name: texts.today }));
    await screen.findByDisplayValue(TODAY);

    expect(askedDays).toEqual([yesterday, dayAfter(TODAY, -2), TODAY]);
  });

  it("shows the day's water for a profile that tracks it, and none for one that does not", async () => {
    await renderPage();
    expect(await screen.findByRole('button', { name: spaced('+200 ml') })).toBeInTheDocument();
    cleanup();
    vi.restoreAllMocks();

    await renderPage(aDay(), {}, false);
    expect(screen.queryByRole('button', { name: spaced('+200 ml') })).toBeNull();
  });

  it('takes no entry for a day still to come, and says so', async () => {
    const tomorrow = dayAfter(TODAY, 1);
    address.search = `date=${tomorrow}`;
    await renderPage(aDay({ entries: [], date: tomorrow }));

    expect(screen.getByText(texts.aheadNote)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: texts.addTitle })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: texts.copyTitle })).not.toBeInTheDocument();
  });

  it('takes no new entry for a day more than a year back, and says so, and what the day holds can still be changed', async () => {
    const long = dayAfter(TODAY, -DIARY_DAYS_BACK - 1);
    address.search = `date=${long}`;
    await renderPage(aDay({ date: long }));

    expect(screen.getByText(texts.tooOldNote)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: texts.addTitle })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: texts.copyTitle })).not.toBeInTheDocument();
    const lunch = within(screen.getByRole('region', { name: 'Lunch' }));
    expect(lunch.queryByRole('button', { name: 'Add an entry to Lunch' })).not.toBeInTheDocument();
    expect(lunch.getByRole('button', { name: 'Change Soup from the canteen' })).toBeInTheDocument();
    expect(lunch.getByRole('button', { name: 'Remove Soup from the canteen' })).toBeInTheDocument();
  });

  it('still takes an entry for the day a year back', async () => {
    const oldest = dayAfter(TODAY, -DIARY_DAYS_BACK);
    address.search = `date=${oldest}`;
    await renderPage(aDay({ date: oldest }));

    expect(screen.getByRole('button', { name: texts.addTitle })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: texts.copyTitle })).toBeInTheDocument();
    expect(screen.queryByText(texts.tooOldNote)).not.toBeInTheDocument();
  });

  const nothingWritten = {
    plan: null,
    entries: [],
    eaten: { calories: 0, protein: 0, fat: 0, carbs: 0 },
    eatenLabel: { fiber: null, sugars: null, salt: null, saturatedFat: null },
    labelNotes: [],
    estimated: false,
  };

  it('asks for something to be added on an empty day that takes entries', async () => {
    await renderPage(aDay(nothingWritten));

    expect(screen.getByText(texts.emptyTitle)).toBeInTheDocument();
    expect(screen.getByText(texts.emptyText)).toBeInTheDocument();
  });

  it.each([
    ['a day still to come', 1, texts.aheadNote],
    ['a day more than a year back', -DIARY_DAYS_BACK - 1, texts.tooOldNote],
  ])('says why %s holds nothing, and asks for nothing to be added', async (_, offset, note) => {
    const date = dayAfter(TODAY, offset);
    address.search = `date=${date}`;
    await renderPage(aDay({ ...nothingWritten, date }));

    expect(screen.getByText(note)).toBeInTheDocument();
    expect(screen.queryByText(texts.emptyText)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: texts.addTitle })).not.toBeInTheDocument();
  });

  it("adds a meal of one's own known by its energy alone, and leaves the macronutrients to the API", async () => {
    await renderPage();
    const posted = vi.spyOn(api, 'post').mockResolvedValue(anEntry() as never);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: texts.addTitle }));
    const window = within(screen.getByRole('dialog', { name: texts.addTitle }));
    await user.click(window.getByRole('radio', { name: texts.kindMeal }));
    await user.selectOptions(window.getByRole('combobox', { name: texts.mealLabel }), 'snack');
    await user.type(window.getByRole('textbox', { name: texts.mealName }), 'Cake at work');
    await user.type(window.getByRole('spinbutton', { name: texts.calories }), '350');

    expect(window.getByText('Adds 350 kcal to the day.')).toBeInTheDocument();
    await user.click(window.getByRole('button', { name: texts.submit }));

    expect(posted).toHaveBeenCalledWith('/diary/entries', {
      kind: 'meal',
      mealType: 'snack',
      name: 'Cake at work',
      servings: 1,
      nutrition: { calories: 350 },
      profileId: PROFILE,
      date: TODAY,
    });
  });

  it('adds a recipe found by its name, in servings, and says what it adds first', async () => {
    await renderPage();
    const posted = vi.spyOn(api, 'post').mockResolvedValue(anEntry() as never);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: texts.addTitle }));
    const window = within(screen.getByRole('dialog', { name: texts.addTitle }));
    // Nothing is picked yet: the reason the window cannot add is said beside its button.
    expect(window.getByRole('button', { name: texts.submit })).toBeDisabled();
    expect(window.getByText(texts.pickRecipeFirst)).toBeInTheDocument();
    // The field's name says what to type, and how much of it.
    await user.type(
      window.getByRole('searchbox', { name: `${texts.searchRecipe} ${texts.searchHint}` }),
      'oat',
    );
    await user.click(await window.findByRole('button', { name: /Oat porridge/ }));
    const servings = window.getByRole('spinbutton', { name: texts.servings });
    await user.clear(servings);
    await user.type(servings, '1.5');

    expect(window.getByText('Adds 480 kcal to the day.')).toBeInTheDocument();
    await user.click(window.getByRole('button', { name: texts.submit }));

    expect(posted).toHaveBeenCalledWith('/diary/entries', {
      kind: 'recipe',
      mealType: 'breakfast',
      recipeId: RECIPE,
      servings: 1.5,
      profileId: PROFILE,
      date: TODAY,
    });
  });

  it('changes how much of an entry there was, and the meal it is under', async () => {
    await renderPage();
    const patched = vi.spyOn(api, 'patch').mockResolvedValue(anEntry() as never);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Change Soup from the canteen' }));
    const window = within(screen.getByRole('dialog', { name: texts.editTitle }));
    await user.selectOptions(window.getByRole('combobox', { name: texts.mealLabel }), 'dinner');
    const servings = window.getByRole('spinbutton', { name: texts.servings });
    await user.clear(servings);
    await user.type(servings, '2');
    await user.click(window.getByRole('button', { name: messages.common.save }));

    expect(patched).toHaveBeenCalledWith(`/diary/entries/${anEntry().id}`, {
      mealType: 'dinner',
      servings: 2,
    });
  });

  it("marks a meal of the plan as eaten, which rebalances the plan's day as its page does", async () => {
    await renderPage();
    const patched = vi
      .spyOn(api, 'patch')
      .mockResolvedValue({ plan: {}, rebalance: null } as never);
    const user = userEvent.setup();

    const dinner = within(screen.getByRole('region', { name: 'Dinner' }));
    await user.click(dinner.getByRole('checkbox', { name: texts.eatenToggle }));

    expect(patched).toHaveBeenCalledWith(`/meal-plans/${PLAN}/meals/${SOUP}/eaten`, {
      eaten: true,
    });
  });

  it("offers to resize the plan's meals when the entries put its day off its target, and says what that does", async () => {
    await renderPage(aDay({ plan: { ...aDay().plan!, calorieDelta: 450, offTarget: 'over' } }));
    const posted = vi.spyOn(api, 'post').mockResolvedValue({ plan: {}, rebalance: null } as never);
    const user = userEvent.setup();

    expect(
      screen.getByText(
        "With what the diary holds counted as eaten, the plan's day is 450 kcal over its target.",
      ),
    ).toBeInTheDocument();
    const resize = screen.getByRole('button', { name: texts.rebalance });
    expect(resize).toHaveAccessibleDescription(texts.rebalanceNote);
    await user.click(resize);

    expect(posted).toHaveBeenCalledWith(`/meal-plans/${PLAN}/rebalance`, {
      scope: 'day',
      date: TODAY,
    });
  });

  it('sends a day before today that the entries put off its target to the plan, whose later days can take it', async () => {
    const yesterday = dayAfter(TODAY, -1);
    address.search = `date=${yesterday}`;
    await renderPage(aDay({ plan: { ...aDay().plan!, calorieDelta: -600, offTarget: 'under' } }));

    expect(screen.getByText(texts.planPastNote)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: texts.rebalance })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: texts.openPlan })).toHaveAttribute(
      'href',
      `/meal-plans?profile=${PROFILE}&plan=${PLAN}&day=${yesterday}`,
    );
  });

  it('says of a press that changes nothing that the portions cannot come any closer', async () => {
    await renderPage(aDay({ plan: { ...aDay().plan!, calorieDelta: 450, offTarget: 'over' } }));
    const figures = { calories: 0, protein: 0, fat: 0, carbs: 0 };
    vi.spyOn(api, 'post').mockResolvedValue({
      plan: {},
      rebalance: {
        scope: 'day',
        feasibility: 'best-effort',
        changes: [],
        unabsorbedKcal: 0,
        macrosBefore: figures,
        macrosAfter: figures,
      },
    } as never);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: texts.rebalance }));

    expect(await screen.findByRole('status')).toHaveTextContent(messages.mealPlans.resizeNothing);
  });

  it('offers no resizing where no meal from a recipe is left to resize', async () => {
    const plan = aDay().plan!;
    await renderPage(
      aDay({
        plan: {
          ...plan,
          calorieDelta: 450,
          offTarget: 'over',
          meals: [
            { ...plan.meals[0]!, eaten: true },
            { ...plan.meals[1]!, recipeId: null, eaten: false },
          ],
        },
      }),
    );

    expect(screen.queryByRole('button', { name: texts.rebalance })).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "With what the diary holds counted as eaten, the plan's day is 450 kcal over its target.",
      ),
    ).toBeInTheDocument();
  });

  it("speaks of the plan's day alone where nothing is written for it", async () => {
    const nothing = { entries: [], estimated: false };
    await renderPage(aDay(nothing));

    expect(screen.getByText(texts.planOnTargetPlain)).toBeInTheDocument();
    expect(screen.queryByText(texts.planOnTarget)).not.toBeInTheDocument();
  });

  it("says of a plan's day off its target with nothing written only what its meals do", async () => {
    await renderPage(
      aDay({
        entries: [],
        estimated: false,
        plan: { ...aDay().plan!, calorieDelta: -300, offTarget: 'under' },
      }),
    );

    expect(screen.getByText("The plan's day is 300 kcal under its target.")).toBeInTheDocument();
    expect(screen.queryByText(/counted as eaten/)).not.toBeInTheDocument();
  });

  it("aims a day its plan skips at the profile's own target, and says so", async () => {
    const plan = aDay().plan!;
    await renderPage(
      aDay({
        target: { calories: 2000, protein: 125, fat: 67, carbs: 225, from: 'profile' },
        plan: { ...plan, skipped: true, calorieDelta: 0, offTarget: null },
      }),
    );

    expect(screen.getByText(texts.targetFromSkipped)).toBeInTheDocument();
    expect(screen.queryByText(texts.targetFromProfile)).not.toBeInTheDocument();
    expect(screen.queryByText(texts.targetFromPlan)).not.toBeInTheDocument();
    expect(screen.queryByText(texts.planOnTarget)).not.toBeInTheDocument();
  });

  it('takes no meal of a day still to come as eaten', async () => {
    const tomorrow = dayAfter(TODAY, 1);
    address.search = `date=${tomorrow}`;
    await renderPage(aDay({ date: tomorrow }));

    for (const toggle of screen.getAllByRole('checkbox', { name: texts.eatenToggle })) {
      expect(toggle).toBeDisabled();
    }
  });

  it('goes to today when the address names a day no request may name', async () => {
    address.search = 'date=1999-12-31';
    await renderPage();

    expect(askedDays).toEqual([TODAY]);
  });

  it('asks for no day while a year is being typed, and for the day once it is whole', async () => {
    await renderPage();
    const day = screen.getByLabelText(texts.dayLabel);
    const typed = dayAfter(TODAY, -2);

    // A date field names a day at every step of a year being typed.
    fireEvent.change(day, { target: { value: `0002${typed.slice(4)}` } });
    fireEvent.change(day, { target: { value: `0202${typed.slice(4)}` } });
    expect(askedDays).toEqual([TODAY]);
    expect(day).toHaveValue(`0202${typed.slice(4)}`);

    fireEvent.change(day, { target: { value: typed } });
    await screen.findByDisplayValue(typed);
    expect(askedDays).toEqual([TODAY, typed]);
  });

  it('shows a meal copied from a plan in round servings, and leaves them alone when only its meal changes', async () => {
    await renderPage(aDay({ entries: [anEntry({ servings: 0.9707324547961999 })] }));
    const patched = vi.spyOn(api, 'patch').mockResolvedValue(anEntry() as never);
    const user = userEvent.setup();

    expect(screen.getByText(/0\.97 servings/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Change Soup from the canteen' }));
    const window = within(screen.getByRole('dialog', { name: texts.editTitle }));
    const servings = window.getByRole('spinbutton', { name: texts.servings });
    expect(servings).toHaveValue(0.97);
    expect(servings).toBeValid();
    await user.selectOptions(window.getByRole('combobox', { name: texts.mealLabel }), 'dinner');
    await user.click(window.getByRole('button', { name: messages.common.save }));

    expect(patched).toHaveBeenCalledWith(`/diary/entries/${anEntry().id}`, { mealType: 'dinner' });
  });

  it('shows an amount of an ingredient as it was written, and asks for a change in the same words', async () => {
    await renderPage(
      aDay({
        entries: [
          anEntry({
            kind: 'ingredient',
            name: 'Bread',
            servings: null,
            amount: { quantity: 2.5, unit: 'piece', shown: { quantity: 2.5, unit: 'slice' } },
            estimated: false,
          }),
          anEntry({
            id: '55555555-5555-4555-8555-555555555552',
            kind: 'ingredient',
            name: 'Rice',
            servings: null,
            amount: { quantity: 12.5, unit: 'g', shown: { quantity: 12.5, unit: 'g' } },
            estimated: false,
          }),
        ],
        estimated: false,
      }),
    );
    const user = userEvent.setup();

    expect(screen.getByText(/2\.5 slices/)).toBeInTheDocument();
    expect(screen.getByText(/12\.5 g/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Change Bread' }));

    const window = within(screen.getByRole('dialog', { name: texts.editTitle }));
    expect(window.getByRole('spinbutton', { name: `${texts.quantity} (slices)` })).toHaveValue(2.5);
  });

  it.each([
    ['own', 'entrySourceOwn'],
    ['instance', 'entrySourceInstance'],
  ] as const)(
    'says of a product whose figures came from %s that they did not come from Open Food Facts',
    async (productSource, said) => {
      const entry = anEntry({ kind: 'product', name: 'Chleb babci', productSource });
      await renderPage(aDay({ entries: [entry] }));

      const row = screen.getByText('Chleb babci').closest('li')!;
      expect(within(row).getByText(texts[said])).toBeInTheDocument();
      expect(within(row).queryByText(texts.entrySource)).not.toBeInTheDocument();
    },
  );

  it('says where the figures of a product come from, and takes a change of its amount', async () => {
    const entry = anEntry({
      kind: 'product',
      name: 'Mleko, Mlekovita',
      productId: '77777777-7777-4777-8777-777777777777',
      productCode: null,
      productSource: 'open_food_facts',
      servings: null,
      amount: { quantity: 250, unit: 'ml', shown: { quantity: 250, unit: 'ml' } },
      label: { fiber: null, sugars: 11.8, salt: 0.3, saturatedFat: 5.3 },
      estimated: false,
    });
    await renderPage(aDay({ entries: [entry] }));
    const patched = vi.spyOn(api, 'patch').mockResolvedValue(entry as never);
    const user = userEvent.setup();

    const row = screen.getByText('Mleko, Mlekovita').closest('li')!;
    expect(within(row).getByText(texts.entrySource)).toBeInTheDocument();
    await user.click(
      within(row).getByRole('button', {
        name: texts.editLabel.replace('{name}', 'Mleko, Mlekovita'),
      }),
    );
    const window = within(screen.getByRole('dialog', { name: texts.editTitle }));
    const quantity = window.getByRole('spinbutton', { name: /ml/ });
    expect(quantity).toHaveValue(250);
    await user.clear(quantity);
    await user.type(quantity, '300');
    await user.click(window.getByRole('button', { name: messages.common.save }));

    expect(patched).toHaveBeenCalledWith(`/diary/entries/${entry.id}`, {
      mealType: 'lunch',
      quantity: 300,
    });
  });

  it("moves an entry of a product of the base to its reader's correction, written in its window", async () => {
    const code = '5900512320359';
    const entry = anEntry({
      kind: 'product',
      name: 'Mleko, Mlekovita',
      productId: '77777777-7777-4777-8777-777777777777',
      productCode: code,
      productSource: 'open_food_facts',
      servings: null,
      amount: { quantity: 250, unit: 'ml', shown: { quantity: 250, unit: 'ml' } },
      label: { fiber: null, sugars: 11.8, salt: 0.3, saturatedFat: 5.3 },
      estimated: false,
    });
    const base = {
      id: '77777777-7777-4777-8777-777777777777',
      code,
      source: 'open_food_facts',
      name: 'Mleko 3,2%',
      brand: 'Mlekovita',
      pack: '1l',
      unit: 'ml',
      packAmount: 1000,
      servingAmount: 250,
      per100: {
        calories: 60,
        protein: 3.2,
        fat: 3.2,
        carbs: 4.7,
        fiber: null,
        sugars: 4.7,
        salt: 0.1,
        saturatedFat: 2.1,
      },
      energyWorkedOut: false,
      doubtful: false,
      correction: false,
      changedAt: null,
    };
    await renderPage(aDay({ entries: [entry] }));
    const answers = vi.mocked(api.get).getMockImplementation()!;
    vi.mocked(api.get).mockImplementation((path: string) =>
      path === `/products/code/${code}` ? Promise.resolve(base) : answers(path),
    );
    const correction = {
      ...base,
      id: '99999999-9999-4999-8999-999999999999',
      source: 'own',
      correction: true,
      state: 'own',
      reason: null,
      sentAt: null,
      updatedAt: '2026-11-03T10:00:00.000Z',
    };
    const posted = vi.spyOn(api, 'post').mockResolvedValue(correction as never);
    const patched = vi.spyOn(api, 'patch').mockResolvedValue(entry as never);
    const user = userEvent.setup();

    const row = screen.getByText('Mleko, Mlekovita').closest('li')!;
    await user.click(
      within(row).getByRole('button', {
        name: texts.editLabel.replace('{name}', 'Mleko, Mlekovita'),
      }),
    );
    const window = within(screen.getByRole('dialog', { name: texts.editTitle }));
    await user.click(window.getByRole('button', { name: texts.entryCorrect }));
    const form = within(
      await screen.findByRole('dialog', { name: messages.products.correctTitle }),
    );
    const calories = await form.findByRole('textbox', { name: messages.products.calories });
    expect(calories).toHaveValue('60');
    await user.clear(calories);
    await user.type(calories, '64');
    await user.click(form.getByRole('button', { name: messages.products.save }));

    expect(posted).toHaveBeenCalledWith(
      '/products/own',
      expect.objectContaining({ code, per100: expect.objectContaining({ calories: 64 }) }),
    );
    expect(patched).toHaveBeenCalledWith(`/diary/entries/${entry.id}`, {
      mealType: 'lunch',
      productId: correction.id,
    });
  });

  it('offers an entry of a product its reader has a version of already that version, not a second one', async () => {
    const code = '5900512320359';
    const entry = anEntry({
      kind: 'product',
      name: 'Mleko, Mlekovita',
      productId: '77777777-7777-4777-8777-777777777777',
      productCode: code,
      productSource: 'open_food_facts',
      servings: null,
      amount: { quantity: 250, unit: 'ml', shown: { quantity: 250, unit: 'ml' } },
      estimated: false,
    });
    await renderPage(aDay({ entries: [entry] }));
    const answers = vi.mocked(api.get).getMockImplementation()!;
    const mine = { id: '99999999-9999-4999-8999-999999999999', source: 'own', name: 'Moje mleko' };
    vi.mocked(api.get).mockImplementation((path: string) =>
      path === `/products/code/${code}` ? Promise.resolve(mine) : answers(path),
    );
    const patched = vi.spyOn(api, 'patch').mockResolvedValue(entry as never);
    const user = userEvent.setup();

    const row = screen.getByText('Mleko, Mlekovita').closest('li')!;
    await user.click(
      within(row).getByRole('button', {
        name: texts.editLabel.replace('{name}', 'Mleko, Mlekovita'),
      }),
    );
    const window = within(screen.getByRole('dialog', { name: texts.editTitle }));
    await user.click(window.getByRole('button', { name: texts.entryCorrect }));
    expect(
      await window.findByText(texts.entryOwnVersion.replace('{name}', 'Moje mleko')),
    ).toBeInTheDocument();
    await user.click(window.getByRole('button', { name: texts.entryUseOwnVersion }));

    expect(patched).toHaveBeenCalledWith(`/diary/entries/${entry.id}`, {
      mealType: 'lunch',
      productId: mine.id,
    });
  });

  it('says nothing of what a number that cannot be written would add', async () => {
    await renderPage();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: texts.addTitle }));
    const window = within(screen.getByRole('dialog', { name: texts.addTitle }));
    await user.click(window.getByRole('radio', { name: texts.kindMeal }));
    await user.type(window.getByRole('spinbutton', { name: texts.calories }), '350');
    const servings = window.getByRole('spinbutton', { name: texts.servings });
    expect(window.getByText('Adds 350 kcal to the day.')).toBeInTheDocument();

    await user.clear(servings);
    await user.type(servings, '-1');
    expect(window.queryByText(/kcal to the day/)).not.toBeInTheDocument();
    await user.clear(servings);
    await user.type(servings, '0');
    expect(window.queryByText(/kcal to the day/)).not.toBeInTheDocument();
  });

  it('says when a search got no answer, which is not that nothing was found', async () => {
    await renderPage();
    const answers = vi.mocked(api.get).getMockImplementation()!;
    vi.mocked(api.get).mockImplementation((path: string) =>
      path.startsWith('/recipes?') ? Promise.reject(new Error('down')) : answers(path),
    );
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: texts.addTitle }));
    const window = within(screen.getByRole('dialog', { name: texts.addTitle }));
    await user.type(
      window.getByRole('searchbox', { name: `${texts.searchRecipe} ${texts.searchHint}` }),
      'oat',
    );

    expect(await window.findByText(texts.searchFailed)).toBeInTheDocument();
    expect(window.queryByText(texts.noResults)).not.toBeInTheDocument();
  });

  it('copies another day into this one, and says how many entries came', async () => {
    await renderPage();
    const posted = vi.spyOn(api, 'post').mockResolvedValue({ copied: 2, day: aDay() } as never);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /^Copy into/ }));

    expect(posted).toHaveBeenCalledWith('/diary/copy', {
      profileId: PROFILE,
      from: dayAfter(TODAY, -1),
      to: TODAY,
    });
    expect(await screen.findByRole('status')).toHaveTextContent('2 entries copied.');
  });

  it('copies a day once, however quickly a second press comes, and goes on to copy another', async () => {
    await renderPage();
    const posted = vi.spyOn(api, 'post').mockResolvedValue({ copied: 2, day: aDay() } as never);
    const user = userEvent.setup();
    const button = screen.getByRole('button', { name: /^Copy into/ });

    await user.dblClick(button);

    await screen.findByText(texts.copyDone);
    expect(posted).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(texts.copyDone);

    fireEvent.change(screen.getByLabelText(texts.copyFrom), {
      target: { value: dayAfter(TODAY, -2) },
    });
    expect(button).toBeEnabled();
    await user.click(button);
    expect(posted).toHaveBeenCalledTimes(2);
  });

  it('says that a day holds nothing yet where neither a plan nor an entry is there', async () => {
    await renderPage(
      aDay({
        plan: null,
        entries: [],
        target: { ...aDay().target, from: 'profile' },
        eaten: { calories: 0, protein: 0, fat: 0, carbs: 0 },
        eatenLabel: { fiber: null, sugars: null, salt: null, saturatedFat: null },
        labelNotes: [],
        estimated: false,
      }),
    );

    expect(screen.getByText(texts.emptyTitle)).toBeInTheDocument();
    expect(screen.getByText(texts.targetFromProfile)).toBeInTheDocument();
    expect(screen.queryByText(texts.estimatedNote)).not.toBeInTheDocument();
  });
});
