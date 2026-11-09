// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import en from '../../messages/en.json';
import pl from '../../messages/pl.json';
import { SplitCalculator, type SplitPortion } from './split-calculator';

const texts = en.split;

const PLANNED: SplitPortion[] = [
  { key: 'monday', label: 'Monday, lunch', kcal: 640 },
  { key: 'tuesday', label: 'Tuesday, lunch', kcal: 560 },
];

function shown(portions?: SplitPortion[], locale: 'en' | 'pl' = 'en') {
  render(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : pl}>
      <SplitCalculator portions={portions} />
    </NextIntlClientProvider>,
  );
}

/** What a portion's row says it takes, as the reader sees it. */
const amountOf = (label: string): string =>
  within(screen.getByText(label).closest('li')!)
    .getByText(/—|\d/, { selector: 'span.whitespace-nowrap' })
    .textContent!.replace(/\u00a0/g, ' ');

// Testing Library reads a hard space of the page as a plain one; the typography's own tests hold the texts to theirs.
describe('the weighing calculator', () => {
  it('splits a dish of a plan by the energy of its meals, into whole grams that add up to what was weighed', async () => {
    shown(PLANNED);

    expect(amountOf('Monday, lunch')).toBe('—');
    await userEvent.type(screen.getByLabelText(texts.onScale), '1250');

    expect(amountOf('Monday, lunch')).toBe('667 g');
    expect(amountOf('Tuesday, lunch')).toBe('583 g');
    expect(screen.getByText('Share: 53% (640 kcal)')).toBeVisible();
    expect(screen.getByText(texts.tare)).toBeVisible();
  });

  it('takes the empty pot off a dish weighed in it, and says what the food alone weighs', async () => {
    shown(PLANNED);

    await userEvent.type(screen.getByLabelText(texts.onScale), '2660');
    await userEvent.click(screen.getByLabelText(texts.inPot));
    // Until the empty pot is weighed, the scale's weight is not the food's.
    expect(amountOf('Monday, lunch')).toBe('—');
    await userEvent.type(screen.getByLabelText(texts.emptyPot), '1410');

    expect(screen.getByText('The food alone: 1250 g.')).toBeVisible();
    expect(amountOf('Monday, lunch')).toBe('667 g');
    expect(amountOf('Tuesday, lunch')).toBe('583 g');
  });

  it('refuses an empty pot that weighs as much as the full one or more', async () => {
    shown(PLANNED);

    await userEvent.type(screen.getByLabelText(texts.onScale), '1400');
    await userEvent.click(screen.getByLabelText(texts.inPot));
    await userEvent.type(screen.getByLabelText(texts.emptyPot), '1410');

    expect(screen.getByRole('alert')).toHaveTextContent(texts.potTooHeavy);
    expect(amountOf('Monday, lunch')).toBe('—');
  });

  it('splits one part of a dish by the same shares', async () => {
    shown(PLANNED);

    await userEvent.click(screen.getByLabelText(texts.way.part));
    expect(screen.getByText(texts.wayHint.part)).toBeVisible();
    await userEvent.type(screen.getByLabelText(texts.onScale), '300');

    expect(amountOf('Monday, lunch')).toBe('160 g');
    expect(amountOf('Tuesday, lunch')).toBe('140 g');
  });

  it('counts pieces whole, rounded, the last taking what is left', async () => {
    shown([
      { key: 'a', label: 'Monday, breakfast', kcal: 700 },
      { key: 'b', label: 'Tuesday, breakfast', kcal: 450 },
    ]);

    await userEvent.click(screen.getByLabelText(texts.way.pieces));
    await userEvent.type(screen.getByLabelText(texts.pieceCount), '3');

    expect(amountOf('Monday, breakfast')).toBe('2 pieces');
    expect(amountOf('Tuesday, breakfast')).toBe('1 piece');
    // Grams go into a container on the scale; pieces do not.
    expect(screen.queryByText(texts.tare)).toBeNull();
  });

  it('counts no fraction of a piece', async () => {
    shown(PLANNED);

    await userEvent.click(screen.getByLabelText(texts.way.pieces));
    await userEvent.type(screen.getByLabelText(texts.pieceCount), '2.5');

    expect(amountOf('Monday, lunch')).toBe('—');
  });

  it('splits a dish of its own into equal portions, as many as are chosen', async () => {
    shown();

    await userEvent.selectOptions(screen.getByLabelText(texts.portionCount), '3');
    await userEvent.type(screen.getByLabelText(texts.onScale), '1000');

    expect(['Portion 1', 'Portion 2', 'Portion 3'].map(amountOf)).toEqual([
      '333 g',
      '334 g',
      '333 g',
    ]);
    expect(screen.getAllByText('Share: 33%')).toHaveLength(3);
  });

  it('splits a dish of its own by the energy typed for each portion, once every one has it', async () => {
    shown();

    await userEvent.click(screen.getByLabelText(texts.byKcal));
    await userEvent.type(screen.getByLabelText(texts.onScale), '1250');
    await userEvent.type(screen.getByLabelText('Calories of portion 1 (kcal)'), '640');

    expect(screen.getAllByText(texts.shareUnknown)).toHaveLength(2);
    expect(amountOf('Portion 1')).toBe('—');

    await userEvent.type(screen.getByLabelText('Calories of portion 2 (kcal)'), '560');

    expect(amountOf('Portion 1')).toBe('667 g');
    expect(amountOf('Portion 2')).toBe('583 g');
  });

  it('takes a weight with a comma, as it is typed in Polish', async () => {
    shown(PLANNED, 'pl');

    await userEvent.type(screen.getByLabelText(pl.split.onScale), '1250,4');

    expect(amountOf('Monday, lunch')).toBe('667 g');
  });

  it('always says that a pot is never split exactly, and what to do for exact portions', () => {
    shown(PLANNED);

    expect(screen.getByText(texts.risk)).toBeVisible();
  });
});
