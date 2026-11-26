// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import type { CalorieCalculation } from '@diet-app/shared';
import en from '../../messages/en.json';
import pl from '../../messages/pl.json';
import { TargetNotices } from './target-notices';
import { plain as asRead } from '@/testing/spaces';

const plain: CalorieCalculation = {
  bmr: 1780,
  maintenance: 2759,
  weeklyLossTarget: '0.5',
  requestedDeficit: 550,
  dailyDeficit: 550,
  weeklyLossKg: 0.5,
  dailyTarget: 2209,
  targetMacros: { protein: 138, fat: 74, carbs: 249, carbsFloor: null },
  source: 'calculated',
  safetyFloor: 1500,
  deficitCapped: false,
  safetyFloorApplied: false,
  maintenanceUnderFloor: false,
  goalHeld: false,
  paceHeldForAge: false,
  correctionHeld: false,
  leastTypedTarget: 1200,
  customSplitHeld: false,
  warnings: [],
};

/** The account's session, read once: its weight unit is what a pace is said in. */
function aSession(weightUnit: 'kg' | 'lb' = 'kg'): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  client.setQueryData(['session'], { weightUnit });
  return client;
}

/** What somebody reading `locale` is told about a calculation. */
function told(
  calories: CalorieCalculation,
  locale: 'en' | 'pl' = 'en',
  weightUnit: 'kg' | 'lb' = 'kg',
): string[] {
  const { unmount } = render(
    <QueryClientProvider client={aSession(weightUnit)}>
      <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : pl}>
        <TargetNotices calories={calories} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  const lines = screen.queryAllByRole('listitem').map((item) => asRead(item.textContent));
  unmount();
  return lines;
}

describe('what a user is told about their calorie target', () => {
  it('is nothing when the target is maintenance less the pace they chose', () => {
    expect(told(plain)).toEqual([]);
  });

  it('is that the pace was slowed, with both figures and what it loses at first, said as the paces are', () => {
    // Half a kilogram a week asked, a quarter of maintenance taken: what it loses is not the half a kilogram asked for.
    const slowed = {
      ...plain,
      requestedDeficit: 550,
      dailyDeficit: 492,
      weeklyLossKg: 0.45,
      deficitCapped: true,
    };
    expect(told(slowed)).toEqual([
      'The pace you chose asks for 550 kcal a day less. That is more than a plan allows: a quarter of your maintenance or 1% of your body weight a week. So the plan takes 492 kcal: at first about 0.45 kg a week, and less as time goes on.',
    ]);
    expect(told({ ...slowed, weeklyLossKg: 0.57 }, 'en', 'lb')[0]).toContain(
      'at first about 1.3 lb a week',
    );
  });
  it('is that a faster pace counts as half a kilogram from 65, and that older people are advised against losing', () => {
    expect(
      told({
        ...plain,
        weeklyLossTarget: '1.0',
        requestedDeficit: 1100,
        paceHeldForAge: true,
        warnings: ['older'],
      }),
    ).toEqual([
      'At a body-mass index under 30 the nutrition guidelines for older people advise against losing weight. If you want to lose weight, talk to a doctor about it.',
      'From 65 a pace faster than 0.5 kg a week counts as 0.5 kg.',
    ]);
    // Keeping the weight, the advice has nothing to say.
    expect(told({ ...plain, dailyDeficit: 0, warnings: ['older'] })).toEqual([]);
  });

  it('is that a correction from the real expenditure was held, and why its figure is low', () => {
    expect(told({ ...plain, dailyTarget: 1780, correctionHeld: true })).toEqual([
      'The correction from the real expenditure would lower the target further than the application allows, so the target stops at 1780 kcal. A diary with days written in part gives a figure too low.',
    ]);
  });

  it('is the floor and the deficit it leaves, without the note on the pace', () => {
    expect(
      told({
        ...plain,
        safetyFloor: 1200,
        dailyDeficit: 287,
        deficitCapped: true,
        safetyFloorApplied: true,
      }),
    ).toEqual([
      'The target was raised to 1200 kcal, the lowest a calculated plan goes. The deficit that leaves is 287 kcal a day.',
    ]);
  });

  it('is that no loss is planned where maintenance is under the floor', () => {
    expect(
      told({
        ...plain,
        safetyFloor: 1200,
        maintenance: 992,
        dailyTarget: 992,
        dailyDeficit: 0,
        maintenanceUnderFloor: true,
      })[0],
    ).toMatch(/^Your maintenance is under 1200 kcal/);
  });

  it('is that the goal is on hold and why, for somebody under 18', () => {
    const lines = told({
      ...plain,
      goalHeld: true,
      customSplitHeld: false,
      dailyDeficit: 0,
      dailyTarget: 2759,
      requestedDeficit: 1100,
      deficitCapped: true,
      warnings: ['minor'],
    });

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^Your goal to lose weight is on hold/);
    expect(lines[1]).toMatch(/^You are under 18\./);
  });

  it('is said in Polish to a Polish reader', () => {
    expect(
      told(
        {
          ...plain,
          source: 'manual_override',
          dailyTarget: 1300,
          warnings: ['underweight', 'below_floor', 'below_bmr', 'low_target'],
        },
        'pl',
      ),
    ).toEqual([
      'Twój wskaźnik masy ciała jest poniżej 18,5, czyli w zakresie niedowagi. Dalsza utrata masy może Ci zaszkodzić.',
      'Wpisany cel jest niższy niż 1500 kcal, czyli najniższy, jaki wyliczyłby plan.',
      'Wpisany cel jest niższy niż to, co organizm zużywa w spoczynku (1780 kcal).',
      'Przy tak niskim celu trudno pokryć z jedzenia wszystkie potrzebne witaminy i składniki mineralne, a aplikacja ich nie liczy.',
      'Jeśli kontrola jedzenia stała się sposobem radzenia sobie z emocjami, porozmawiaj z lekarzem.',
    ]);
  });

  it('leaves the warnings of a risk to a form that gives them itself, and still says the rest', () => {
    const held = {
      ...plain,
      goalHeld: true,
      customSplitHeld: false,
      dailyTarget: 2759,
      dailyDeficit: 0,
      warnings: ['minor' as const],
    };
    const floored = {
      ...plain,
      dailyTarget: 1500,
      dailyDeficit: 300,
      safetyFloorApplied: true,
      warnings: ['underweight' as const],
    };
    const inAForm = (calories: CalorieCalculation): string[] => {
      const { unmount } = render(
        <QueryClientProvider client={aSession()}>
          <NextIntlClientProvider locale="en" messages={en}>
            <TargetNotices calories={calories} risk={false} />
          </NextIntlClientProvider>
        </QueryClientProvider>,
      );
      const lines = screen.queryAllByRole('listitem').map((item) => asRead(item.textContent));
      unmount();
      return lines;
    };

    expect(inAForm(held)).toEqual([]);
    expect(inAForm(floored)).toEqual([
      expect.stringMatching(/^The target was raised to 1500 kcal/),
    ]);
  });
});
