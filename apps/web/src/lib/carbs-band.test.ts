// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';
import { plain } from '@/testing/spaces';
import { bandValues, carbsBandOf, carbsStandingOf } from './carbs-band';

describe("how a day's carbohydrate reads against what it aims at", () => {
  it('is a band from its floor on low-carb, a ceiling alone on keto, and a target elsewhere', () => {
    expect(carbsBandOf({ carbsFloor: 54 })).toBe('range');
    expect(carbsBandOf({ carbsFloor: 0 })).toBe('ceiling');
    expect(carbsBandOf({ carbsFloor: null })).toBe('none');
  });

  it('says an amount is over the ceiling, under the floor or in the band, in the whole grams it is shown in', () => {
    const lowCarb = { carbs: 120, carbsFloor: 60 };
    expect(carbsStandingOf(140, lowCarb)).toBe('over');
    expect(carbsStandingOf(120.4, lowCarb)).toBe('in');
    expect(carbsStandingOf(120.6, lowCarb)).toBe('over');
    expect(carbsStandingOf(59.6, lowCarb)).toBe('in');
    expect(carbsStandingOf(59.4, lowCarb)).toBe('under');
    expect(carbsStandingOf(90, lowCarb)).toBe('in');
    // Keto's band is a ceiling alone: nothing is under it.
    const keto = { carbs: 30, carbsFloor: 0 };
    expect(carbsStandingOf(0, keto)).toBe('in');
    expect(carbsStandingOf(31, keto)).toBe('over');
    // A diet without a band says the target, not a standing.
    expect(carbsStandingOf(400, { carbs: 250, carbsFloor: null })).toBe('in');
  });

  it('gives a message its band and a floor of none where there is no band', () => {
    expect(bandValues({ carbsFloor: 54 })).toEqual({ band: 'range', carbsFloor: 54 });
    expect(bandValues({ carbsFloor: null })).toEqual({ band: 'none', carbsFloor: 0 });
  });
});

describe("every text that says a day's carbohydrate against its band", () => {
  type Say = (key: string, values: Record<string, string | number>) => string;
  const say = (locale: 'pl' | 'en'): Say =>
    createTranslator({
      locale,
      messages: JSON.parse(
        readFileSync(path.resolve(process.cwd(), 'messages', `${locale}.json`), 'utf8'),
      ),
    }) as unknown as Say;
  const figures = { protein: 150, proteinTarget: 176, fat: 120, fatTarget: 130 };
  /** Each text, with a day's carbohydrate and its band, as the place that shows it gives them. */
  const said = (locale: 'pl' | 'en', band: 'range' | 'ceiling', standing: string) => {
    const of = {
      carbs: 140,
      carbsTarget: 118,
      carbsFloor: band === 'range' ? 59 : 0,
      band,
      standing,
    };
    const t = say(locale);
    return [
      t('diary.inBand', { band, standing, floor: of.carbsFloor, ceiling: of.carbsTarget }),
      t('mealPlans.dayMacros', { ...figures, ...of }),
      t('mealPlans.planMacros', { ...figures, ...of }),
      t('weekSummary.macros', { ...figures, ...of }),
      t('planOverview.macroCarbsBand', {
        band,
        standing,
        planned: of.carbs,
        floor: of.carbsFloor,
        ceiling: of.carbsTarget,
      }),
    ].map(plain);
  };

  it.each([
    ['pl', 'range', 'over', 'ponad normę 59–118 g'],
    ['pl', 'range', 'in', 'w normie 59–118 g'],
    ['pl', 'range', 'under', 'poniżej normy 59–118 g'],
    ['pl', 'ceiling', 'over', 'ponad normę do 118 g'],
    ['pl', 'ceiling', 'in', 'w normie do 118 g'],
    ['en', 'range', 'over', 'above the range 59–118 g'],
    ['en', 'range', 'in', 'in range 59–118 g'],
    ['en', 'range', 'under', 'below the range 59–118 g'],
    ['en', 'ceiling', 'over', 'above the limit of 118 g'],
    ['en', 'ceiling', 'in', 'at most 118 g'],
  ] as const)('says in %s, on a %s band, %s it: "%s"', (locale, band, standing, words) => {
    for (const text of said(locale, band, standing)) expect(text).toContain(words);
  });
});
