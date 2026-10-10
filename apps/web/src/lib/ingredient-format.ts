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
  return (quantity, unit) => t(`amount.${unit}`, { count: quantity });
}

/** The name of a unit on its own, for the label next to a number field. */
export function useUnitName(): (unit: DisplayUnit) => string {
  const t = useTranslations('units');
  return (unit) => t(`name.${unit}`);
}
