// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import type { DisplayAmount, DisplayUnit } from '@diet-app/shared';
import en from '../../messages/en.json';
import pl from '../../messages/pl.json';
import { useAmount, useShownAmount } from './ingredient-format';

function Shown({ quantity, unit }: { quantity: number; unit: DisplayUnit }) {
  return <p>{useAmount()(quantity, unit)}</p>;
}

/** What somebody reading `locale` sees of an amount. */
function shown(quantity: number, unit: DisplayUnit, locale: 'en' | 'pl'): string {
  const { unmount } = render(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : pl}>
      <Shown quantity={quantity} unit={unit} />
    </NextIntlClientProvider>,
  );
  const text = screen.getByRole('paragraph').textContent ?? '';
  unmount();
  return text;
}

describe('an amount measured with a spoon', () => {
  it('is written in teaspoons as a cook writes them, a part of one with the noun that follows a fraction', () => {
    expect(shown(0.25, 'tsp', 'pl')).toBe('¼ łyżeczki');
    expect(shown(0.5, 'tsp', 'pl')).toBe('½ łyżeczki');
    expect(shown(1, 'tsp', 'pl')).toBe('1 łyżeczka');
    expect(shown(1.5, 'tsp', 'pl')).toBe('1½ łyżeczki');
    expect(shown(4, 'tsp', 'pl')).toBe('4 łyżeczki');
    expect(shown(0.5, 'tsp', 'en')).toBe('½ teaspoon');
    expect(shown(1, 'tsp', 'en')).toBe('1 teaspoon');
    expect(shown(2.5, 'tsp', 'en')).toBe('2½ teaspoons');
  });

  it('is written in pinches below a quarter of a teaspoon', () => {
    expect(shown(1, 'pinch', 'pl')).toBe('1 szczypta');
    expect(shown(3, 'pinch', 'pl')).toBe('3 szczypty');
    expect(shown(2, 'pinch', 'en')).toBe('2 pinches');
  });
});

function WithWeight({ amount }: { amount: DisplayAmount }) {
  return <p>{useShownAmount()(amount)}</p>;
}

describe('an amount shown in pieces', () => {
  const read = (amount: DisplayAmount, locale: 'en' | 'pl'): string => {
    const { unmount } = render(
      <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : pl}>
        <WithWeight amount={amount} />
      </NextIntlClientProvider>,
    );
    const text = screen.getByRole('paragraph').textContent ?? '';
    unmount();
    return text;
  };

  it('has what its pieces weigh beside it, where the API gives it', () => {
    expect(read({ quantity: 2, unit: 'piece', grams: 110 }, 'pl')).toBe('2 sztuki (110 g)');
    expect(read({ quantity: 2, unit: 'slice', grams: 80 }, 'en')).toBe('2 slices (80 g)');
  });

  it('stays as it is by weight, and where a piece has no weight', () => {
    expect(read({ quantity: 120, unit: 'g' }, 'en')).toBe('120 g');
    expect(read({ quantity: 1, unit: 'piece' }, 'en')).toBe('1 piece');
  });
});
