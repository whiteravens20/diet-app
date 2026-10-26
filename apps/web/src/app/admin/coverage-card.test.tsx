// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import { DietType, MealType } from '@diet-app/shared';
import type { AdminStats } from '@/lib/admin-api';
import messages from '../../../messages/en.json';
import { CoverageCard } from './coverage-card';

const coverage = Object.fromEntries(
  DietType.options.map((diet) => [
    diet,
    Object.fromEntries(MealType.options.map((meal) => [meal, 12])),
  ]),
) as AdminStats['coverage'];
coverage.vegan = { breakfast: 4, second_breakfast: 0, lunch: 2, snack: 3, dinner: 7 };

const none = Object.fromEntries(
  DietType.options.map((diet) => [
    diet,
    Object.fromEntries(MealType.options.map((meal) => [meal, 0])),
  ]),
) as AdminStats['coverageWaiting'];

const even = { protein: 0.25, fat: 0.3, carbs: 0.45 };
const macros: AdminStats['macros'] = {
  outOfReach: 0.1,
  diets: Object.fromEntries(
    DietType.options.map((diet) => [
      diet,
      { target: even, reached: { ...even, distance: 0, packsUsed: 0.764 } },
    ]),
  ) as AdminStats['macros']['diets'],
};
// A catalogue with nothing rich in protein, and nothing for a ketogenic day at all.
macros.diets.high_protein = {
  target: { protein: 0.4, fat: 0.3, carbs: 0.3 },
  reached: { protein: 0.274, fat: 0.33, carbs: 0.396, distance: 0.126, packsUsed: null },
};
macros.diets.keto = { target: { protein: 0.25, fat: 0.7, carbs: 0.05 }, reached: null };

function renderCard(waiting: AdminStats['coverageWaiting'] = none) {
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <CoverageCard coverage={coverage} waiting={waiting} target={6} macros={macros} />
    </NextIntlClientProvider>,
  );
}

/** The table of recipes per diet and meal, and the one of protein, fat and carbohydrate. */
const counts = () => within(screen.getByRole('table', { name: messages.admin.coverage.title }));
const split = () =>
  within(screen.getByRole('table', { name: messages.admin.coverage.macrosTitle }));

describe("the administrator's table of recipes per diet and meal", () => {
  it('has the meals in the order of a day and a row for every diet', () => {
    renderCard();

    expect(
      counts()
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Diet', 'Breakfast', 'Second breakfast', 'Lunch', 'Snack', 'Dinner']);
    expect(counts().getAllByRole('rowheader')).toHaveLength(DietType.options.length);
  });

  it('gives each diet its count for each meal', () => {
    renderCard();

    const row = counts().getByRole('row', { name: /^Vegan/ });
    expect(
      within(row)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['4', '0', '2', '3', '7']);
  });

  it('sets apart a meal with no recipe from one with few and one with enough', () => {
    renderCard();

    const [enough, none, few] = within(counts().getByRole('row', { name: /^Vegan/ })).getAllByRole(
      'cell',
    );
    expect(none!.className).toContain('text-destructive');
    expect(few!.className).toContain('text-warning');
    expect(enough!.className).not.toMatch(/text-destructive|text-warning/);
  });

  it('says how many pairs of diet and meal are short of what a release needs', () => {
    renderCard();

    // Vegan: 4, 0, 2 and 3 are under six; 7 is not.
    expect(
      screen.getByText(/^4 of 35 pairs of diet and meal have fewer than 6 recipes\./),
    ).toBeTruthy();
  });

  it('stands in a box of its own that scrolls sideways on a narrow screen, can be reached with the Tab key and says what it is', () => {
    renderCard({
      ...none,
      vegan: { breakfast: 2, second_breakfast: 0, lunch: 0, snack: 0, dinner: 0 },
    });

    const box = screen.getByRole('group', {
      name: 'Recipes per diet and meal: a table that scrolls sideways',
    });
    expect(box).toHaveAttribute('tabindex', '0');
    expect(box.className).toContain('overflow-x-auto');
    // What only a screen reader is given is placed by the box: it stays inside it.
    expect(box.className).toContain('relative');
    expect(
      within(box).getByRole('table', { name: messages.admin.coverage.title }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('group', {
        name: 'Protein, fat and carbohydrate: a table that scrolls sideways',
      }),
    ).toHaveAttribute('tabindex', '0');
  });

  it('says nothing of drafts while none waits', () => {
    renderCard();

    expect(screen.queryByText(/A number after a plus sign/)).not.toBeInTheDocument();
  });

  it('puts the drafts that wait beside the recipes of a meal, in words for those who do not see the sign', () => {
    renderCard({
      ...none,
      vegan: { breakfast: 2, second_breakfast: 1, lunch: 0, snack: 0, dinner: 3 },
    });

    const row = counts().getByRole('row', { name: /^Vegan/ });
    expect(
      within(row)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual([
      '4+2and 2 drafts waiting',
      '0+1and 1 draft waiting',
      '2',
      '3',
      '7+3and 3 drafts waiting',
    ]);
    // A balanced diet has drafts of its own to wait for: none here.
    expect(
      within(counts().getByRole('row', { name: /^Balanced/ })).getAllByRole('cell')[0]!.textContent,
    ).toBe('12');
  });

  it('says how many pairs stay short once the drafts that wait have shipped', () => {
    // Vegan: 4, 0, 2 and 3 are under six. Two drafts bring breakfast to six, one leaves the second breakfast short.
    renderCard({
      ...none,
      vegan: { breakfast: 2, second_breakfast: 1, lunch: 0, snack: 0, dinner: 3 },
    });

    expect(
      screen.getByText(
        /^A number after a plus sign is recipe drafts that wait in the queue for that diet and meal: a recipe run counts them\. Once they ship, 3 pairs still have fewer than 6\.$/,
      ),
    ).toBeInTheDocument();
  });

  it('says so when the drafts that wait fill every pair', () => {
    renderCard({
      ...none,
      vegan: { breakfast: 2, second_breakfast: 6, lunch: 4, snack: 3, dinner: 0 },
    });

    expect(screen.getByText(/Once they ship, every pair has at least 6\.$/)).toBeInTheDocument();
  });
});

describe("the administrator's table of what each diet aims at and what its plans reach", () => {
  const cells = (diet: RegExp) =>
    within(split().getByRole('row', { name: diet })).getAllByRole('cell');

  it("gives protein, fat and carbohydrate as percentages of a day's energy, for every diet with recipes of its own to find", () => {
    renderCard();

    expect(cells(/^Balanced/).map((cell) => cell.textContent)).toEqual([
      '25 / 30 / 45',
      '25 / 30 / 45',
      '76%',
    ]);
    // A diet the user sets up for themselves has no split of its own to be held to.
    expect(split().getAllByRole('rowheader')).toHaveLength(DietType.options.length - 1);
  });

  it('sets apart a diet whose plans are far from what it aims at, and says by how much', () => {
    renderCard();

    const [aim, reached] = cells(/^High protein/);
    expect(aim!.textContent).toBe('40 / 30 / 30');
    expect(reached!.textContent).toBe('27 / 33 / 40' + '13 points off');
    expect(reached!.className).toContain('text-warning');
    expect(cells(/^Balanced/)[1]!.className).not.toMatch(/text-destructive|text-warning/);
  });

  it('says so where no plan can be made for a diet', () => {
    renderCard();

    const [, reached, packs] = cells(/^Keto/);
    expect(reached!.textContent).toBe(messages.admin.coverage.macrosNoPlan);
    expect(reached!.className).toContain('text-destructive');
    expect(packs!.textContent).toBe('–');
  });

  it('says how much of the packs that do not keep the plans of a diet use, and nothing where they buy none', () => {
    renderCard();

    expect(
      split().getByRole('columnheader', { name: messages.admin.coverage.packsUsed }),
    ).toBeInTheDocument();
    expect(cells(/^Vegan/)[2]!.textContent).toBe('76%');
    expect(cells(/^High protein/)[2]!.textContent).toBe('–');
    expect(screen.getByText(messages.admin.coverage.packsExplain)).toBeInTheDocument();
  });
});
