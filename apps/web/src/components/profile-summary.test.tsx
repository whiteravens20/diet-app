// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import type { CalorieCalculation } from '@diet-app/shared';
import messages from '../../messages/en.json';
import pl from '../../messages/pl.json';
import { TargetLine } from './profile-summary';

const NBSP = ' ';

/** A target of 1633 kcal, 545 kcal under an expenditure of 2178. */
const calories = (over: Partial<CalorieCalculation> = {}): CalorieCalculation =>
  ({
    dailyTarget: 1633,
    maintenance: 2178,
    dailyDeficit: 545,
    source: 'calculated',
    ...over,
  }) as CalorieCalculation;

/** The line under the day's figure, as a reader of `locale` gets it. */
function line(c: CalorieCalculation, meals = 4, locale: 'en' | 'pl' = 'en'): string {
  const { container } = render(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? messages : pl}>
      <TargetLine calories={c} meals={meals} />
    </NextIntlClientProvider>,
  );
  return container.textContent ?? '';
}

describe("the line under the day's figure", () => {
  it('says what the target comes from, and not the target, which the figure above says once', () => {
    expect(line(calories())).toBe(
      `Maintenance${NBSP}2178${NBSP}kcal${NBSP}· deficit${NBSP}545${NBSP}kcal${NBSP}· 4${NBSP}meals${NBSP}a${NBSP}day`,
    );
    expect(line(calories())).not.toContain('1633');
  });

  it('opens with a target set by hand', () => {
    expect(line(calories({ source: 'manual_override' }))).toBe(
      `Target${NBSP}set${NBSP}by${NBSP}hand${NBSP}· maintenance${NBSP}2178${NBSP}kcal${NBSP}· deficit${NBSP}545${NBSP}kcal${NBSP}· 4${NBSP}meals${NBSP}a${NBSP}day`,
    );
  });

  it('says a surplus where the target stands over the expenditure, and a meal in the singular', () => {
    expect(line(calories({ dailyDeficit: -300 }), 1)).toBe(
      `Maintenance${NBSP}2178${NBSP}kcal${NBSP}· surplus${NBSP}300${NBSP}kcal${NBSP}· 1${NBSP}meal${NBSP}a${NBSP}day`,
    );
  });

  it('reads the same in Polish', () => {
    expect(line(calories({ source: 'manual_override' }), 3, 'pl')).toBe(
      `Cel${NBSP}ustawiony${NBSP}ręcznie${NBSP}· zapotrzebowanie${NBSP}2178${NBSP}kcal${NBSP}· deficyt${NBSP}545${NBSP}kcal${NBSP}· 3${NBSP}posiłki${NBSP}dziennie`,
    );
  });
});
