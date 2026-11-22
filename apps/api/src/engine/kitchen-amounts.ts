// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Unit } from '@diet-app/shared';

/**
 * An amount as a cook measures it: grams and millilitres in fives from 20 up and whole ones below it,
 * never under one; pieces in halves, never under a half. For the amounts a model writes, which it may
 * work out to a hundredth of a gram to meet a number of kilocalories.
 */
export function kitchenAmount(quantity: number, unit: Unit): number {
  if (unit === 'piece') return Math.max(0.5, Math.round(quantity * 2) / 2);
  return quantity >= 20 ? Math.round(quantity / 5) * 5 : Math.max(1, Math.round(quantity));
}
