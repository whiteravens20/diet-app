// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { MacroSplit } from '@diet-app/shared';

/** The split a row keeps as JSON, as the contract has it; null where the row keeps none, or keeps something that is no split. */
export function storedSplit(kept: unknown): MacroSplit | null {
  return MacroSplit.safeParse(kept).data ?? null;
}
