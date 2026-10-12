// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useQuery } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import type { SessionUser, WeightUnit } from '@diet-app/shared';
import { api } from './api';

/** One pound in kilograms, as the pound is defined. */
export const KG_PER_LB = 0.45359237;

/** The least and the most a body weight may be, in kilograms: the bounds of the API. */
export const WEIGHT_BOUNDS_KG = { min: 30, max: 400 } as const;

/** A weight the API holds in kilograms, in the unit it is shown in. */
export function shownWeight(kg: number, unit: WeightUnit): number {
  return unit === 'lb' ? kg / KG_PER_LB : kg;
}

/** A weight somebody typed in their unit, in kilograms to the hundredth, as the API takes it. */
export function toKilograms(typed: number, unit: WeightUnit): number {
  return Math.round((unit === 'lb' ? typed * KG_PER_LB : typed) * 100) / 100;
}

/** A weight in the unit it is shown in, to one decimal: what a field for it starts with. */
export function shownToOne(kg: number, unit: WeightUnit): number {
  return Math.round(shownWeight(kg, unit) * 10) / 10;
}

/** The bounds of a weight in the unit it is typed in, the least rounded up and the most down, so that neither is refused. */
export function boundsIn(unit: WeightUnit): { min: number; max: number } {
  return { min: Math.ceil(shownWeight(WEIGHT_BOUNDS_KG.min, unit) * 10) / 10, max: Math.floor(shownWeight(WEIGHT_BOUNDS_KG.max, unit) * 10) / 10 };
}

/** The countries that weigh people in pounds. */
const POUND_REGIONS = ['US', 'LR', 'MM'];

/** The country a language tag names (`en-US`, `zh-Hant-TW`), or none: a part of two letters after the language. */
function countryOf(tag: string): string | undefined {
  const [, ...parts] = tag.split('-');
  return parts.find((part) => /^[A-Za-z]{2}$/.test(part))?.toUpperCase();
}

/**
 * The unit a reader weighs in by where their browser says they are: pounds
 * for a language tag that names one of the countries that use them, and
 * kilograms for every other, a tag without a country included.
 */
export function unitOfRegion(languages: readonly string[]): WeightUnit {
  for (const tag of languages) {
    const country = countryOf(tag);
    if (country) return POUND_REGIONS.includes(country) ? 'lb' : 'kg';
  }
  return 'kg';
}

const never = (): (() => void) => () => undefined;

/**
 * The unit weights are shown and typed in: the account's choice, and until it
 * has made one, the unit of where the reader is. A page the server renders
 * knows no reader and shows kilograms until the browser has it.
 */
export function useWeightUnit(): WeightUnit {
  const session = useQuery({ queryKey: ['session'], queryFn: () => api.get<SessionUser>('/users/me') });
  const byRegion = useSyncExternalStore<WeightUnit>(
    never,
    () => unitOfRegion(navigator.languages ?? [navigator.language]),
    () => 'kg',
  );
  return session.data?.weightUnit ?? byRegion;
}
