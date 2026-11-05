// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { LabelLimitNote, LabelTotals } from '@diet-app/shared';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import en from '../../messages/en.json';
import pl from '../../messages/pl.json';
import { LabelGrid, LabelLine, LabelNotes } from './label-figures';

const within = (locale: 'en' | 'pl', node: React.ReactNode) =>
  render(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : pl}>
      {node}
    </NextIntlClientProvider>,
  );

const SOME: LabelTotals = {
  fiber: { grams: 6, atLeast: false },
  sugars: { grams: 13.1, atLeast: true },
  salt: { grams: 0.3, atLeast: false },
  saturatedFat: null,
};

describe('fibre, sugars, salt and saturated fat', () => {
  it('show each figure by its name, at least so much with ≥, and a dash where nothing is known', () => {
    within('pl', <LabelLine totals={SOME} />);
    expect(screen.getByText(/Błonnik/).closest('p')).toHaveTextContent(
      'Błonnik 6 g · Cukry ≥ 13,1 g · Sól 0,3 g · Tłuszcze nasycone —',
    );
  });

  it('say once under a serving what ≥ and the dash stand for, and nothing where every figure is known', () => {
    const { unmount } = within('en', <LabelGrid totals={SOME} />);
    expect(screen.getByText(en.labelFigures.legendAtLeast, { exact: false })).toBeVisible();
    expect(screen.getByText(en.labelFigures.legendUnknown, { exact: false })).toBeVisible();
    unmount();

    const known = { grams: 1, atLeast: false };
    within(
      'en',
      <LabelGrid totals={{ fiber: known, sugars: known, salt: known, saturatedFat: known }} />,
    );
    expect(screen.queryByText(en.labelFigures.legendAtLeast, { exact: false })).toBeNull();
  });

  it('note a limit the day crosses, more than a most and less than a least', () => {
    const notes: LabelLimitNote[] = [
      { nutrient: 'fiber', kind: 'atLeast', limit: 25, figure: { grams: 12, atLeast: false } },
      { nutrient: 'salt', kind: 'atMost', limit: 5, figure: { grams: 6.2, atLeast: true } },
    ];
    within('pl', <LabelNotes notes={notes} />);
    const lines = screen.getAllByRole('listitem').map((item) => item.textContent);
    expect(lines).toEqual([
      'Błonnik: 12 g, mniej niż 25 g z ustawień profilu',
      'Sól: ≥ 6,2 g, więcej niż 5 g z ustawień profilu',
    ]);
  });
});
