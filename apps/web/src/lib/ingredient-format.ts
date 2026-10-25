// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { useTranslations } from 'next-intl';
import type { DisplayUnit } from '@diet-app/shared';

/**
 * Spell a quantity in the reader's language: "215 g", "2 slices", "1 handful".
 *
 * The API decides the number and the unit: it rounds grams to kitchen steps
 * and counts eggs, bread and garlic in pieces of their own. Nothing here
 * rounds or converts, so every client shows the same amounts.
 */
export function useAmount(): (quantity: number, unit: DisplayUnit) => string {
  const t = useTranslations('units');
  return (quantity, unit) =>
    unit === 'tsp'
      ? // Teaspoons as a cook writes them; a part of one is singular in English.
        t('amount.tsp', {
          count: quantity,
          shown: spoons(quantity),
          form: quantity < 1 ? 'part' : 'whole',
        })
      : t(`amount.${unit}`, { count: quantity });
}

/** A number of teaspoons as a cook writes it: ¼, ½, 1½, 2. */
function spoons(quantity: number): string {
  const whole = Math.floor(quantity);
  const part = quantity - whole;
  const fraction = part >= 0.75 ? '¾' : part >= 0.5 ? '½' : part >= 0.25 ? '¼' : '';
  return whole === 0 ? fraction || '0' : `${whole}${fraction}`;
}

/** The name of a unit on its own, for the label next to a number field. */
export function useUnitName(): (unit: DisplayUnit) => string {
  const t = useTranslations('units');
  return (unit) => t(`name.${unit}`);
}
