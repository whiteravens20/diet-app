// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/** What the two kinds of draft share: how a list is narrowed, how much of it a page holds, and how often a run is asked how far it is. */
export type StatusFilter = 'ALL' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'SHIPPED';

export type Kind = 'ingredient-names' | 'recipes';

export const PAGE_SIZE = 25;

export const POLL_INTERVAL_MS = 1500;
