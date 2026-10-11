// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import type { CalorieCalculation } from '@diet-app/shared';
import en from '../../messages/en.json';
import pl from '../../messages/pl.json';
import { TargetNotices } from './profile-summary';

const plain: CalorieCalculation = {
  bmr: 1780,
  maintenance: 2759,
  weeklyLossTarget: '0.5',
  requestedDeficit: 550,
  dailyDeficit: 550,
  dailyTarget: 2209,
  targetMacros: { protein: 138, fat: 74, carbs: 249 },
  source: 'calculated',
  safetyFloor: 1500,
  deficitCapped: false,
  safetyFloorApplied: false,
  maintenanceUnderFloor: false,
  warnings: [],
};

/** What somebody reading `locale` is told about a calculation. */
function told(calories: CalorieCalculation, locale: 'en' | 'pl' = 'en'): string[] {
  const { unmount } = render(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : pl}>
      <TargetNotices calories={calories} />
    </NextIntlClientProvider>,
  );
  const lines = screen.queryAllByRole('listitem').map((item) => item.textContent ?? '');
  unmount();
  return lines;
}

describe('what a user is told about their calorie target', () => {
  it('is nothing when the target is maintenance less the pace they chose', () => {
    expect(told(plain)).toEqual([]);
  });

  it('is that the pace was slowed, with both figures', () => {
    expect(told({ ...plain, requestedDeficit: 1100, dailyDeficit: 627, deficitCapped: true })).toEqual([
      'The pace you chose asks for 1100 kcal a day less. That is more than a quarter of your maintenance, so the plan takes 627.',
    ]);
  });

  it('is the floor and the deficit it leaves, without the note on the pace', () => {
    expect(told({ ...plain, safetyFloor: 1200, dailyDeficit: 287, deficitCapped: true, safetyFloorApplied: true })).toEqual([
      'The target was raised to 1200 kcal, the lowest a calculated plan goes. The deficit that leaves is 287 kcal a day.',
    ]);
  });

  it('is that no loss is planned where maintenance is under the floor', () => {
    expect(told({ ...plain, safetyFloor: 1200, maintenance: 992, dailyTarget: 992, dailyDeficit: 0, maintenanceUnderFloor: true })[0]).toMatch(/^Your maintenance is under 1200 kcal/);
  });

  it('is said in Polish to a Polish reader', () => {
    expect(told({ ...plain, source: 'manual_override', dailyTarget: 900, warnings: ['below_floor', 'below_bmr'] }, 'pl')).toEqual([
      'Wpisany cel jest niższy niż 1500 kcal, czyli najniższy, jaki wyliczyłby plan.',
      'Wpisany cel jest niższy niż to, co organizm zużywa w spoczynku (1780 kcal).',
    ]);
  });
});
