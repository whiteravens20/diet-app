// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import type { DiaryEntry } from '@diet-app/shared';
import { useAmount, useUnitName } from '@/lib/ingredient-format';
import { useFormat } from '@/lib/use-format';

/** Servings as a person reads them: a meal of a plan copied here holds whatever its plan resized it to. */
export const shownServings = (servings: number | null): number =>
  Math.round((servings ?? 1) * 100) / 100;

/**
 * How much of something an entry of the diary is, as the diary writes it:
 * weights and volumes as they were written, a part of a gram in the reader's
 * own numbers, what is counted with its plurals, and servings otherwise.
 */
export function useEntryAmount(): (entry: Pick<DiaryEntry, 'amount' | 'servings'>) => string {
  const t = useTranslations('diary');
  const amount = useAmount();
  const unitName = useUnitName();
  const fmt = useFormat();
  return (entry) => {
    if (!entry.amount) return t('servingsShown', { count: shownServings(entry.servings) });
    const { quantity, unit } = entry.amount.shown;
    return unit === 'g' || unit === 'ml'
      ? `${fmt.number(quantity, 2)} ${unitName(unit)}`
      : amount(quantity, unit);
  };
}
