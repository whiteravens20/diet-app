// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { DisplayUnit, ShoppingList } from '@diet-app/shared';

type Row = Pick<ShoppingList['groups'][number]['items'][number], 'displayUnit' | 'gramsPerPiece'>;

/**
 * A quantity of a row as it is shown, with what its pieces weigh beside it for a row in pieces:
 * "3 bananas (360 g)". A piece is the API's average, to the gram; nothing weighs nothing.
 */
export function rowAmount(
  quantity: number,
  row: Row,
  formatQty: (qty: number, unit: DisplayUnit) => string,
): string {
  const shown = formatQty(quantity, row.displayUnit);
  return row.gramsPerPiece === null || quantity <= 0
    ? shown
    : `${shown} (${formatQty(Math.round(quantity * row.gramsPerPiece), 'g')})`;
}
