// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { DisplayUnit, ShoppingListItem } from '@diet-app/shared';

type RowPacks = NonNullable<ShoppingListItem['packs']>;

/** What a row comes to in packs, as a shelf label says it: "2 × 250 g". */
export const packsText = (
  packs: RowPacks,
  amount: (quantity: number, unit: DisplayUnit) => string,
): string => `${packs.count} × ${amount(packs.size, packs.sizeUnit)}`;

/**
 * Whether the packs of a row are what is still to be bought of it: they are
 * counted from the need less what is at home, so they say nothing once a part
 * of the rest was bought.
 */
export const packsStand = (
  item: ShoppingListItem,
): item is ShoppingListItem & { packs: RowPacks } =>
  item.packs !== null &&
  !item.checked &&
  (item.purchasedQuantity ?? item.alreadyHaveQuantity) === item.alreadyHaveQuantity;

/** The day of the week of a calendar day, as a message's select names it. */
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const weekdayOf = (day: string): (typeof WEEKDAYS)[number] =>
  WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()]!;

/**
 * Of a row of fresh meat or fish, which of its packs to buy later than the
 * list's first day and from which day, one sentence each (`buyLater`): empty
 * for any other row, and once the row is ticked.
 */
export const laterLines = (
  item: ShoppingListItem,
  say: (values: { packs: number; weekday: string; date: string }) => string,
  dayShort: (day: string) => string,
): string[] =>
  item.checked
    ? []
    : item.buyLater.map(({ packs, from }) =>
        say({ packs, weekday: weekdayOf(from), date: dayShort(from) }),
      );
