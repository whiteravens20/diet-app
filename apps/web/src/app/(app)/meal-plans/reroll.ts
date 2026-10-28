// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { PlanRelaxation } from '@diet-app/shared';

/** A re-roll of a plan, or of one of its days. */
export interface Reroll {
  planId: string;
  dayId?: string;
  /** The first and the last day to fill again, for a part of the plan. */
  from?: string;
  to?: string;
  includePast?: boolean;
  replaceEaten?: boolean;
  replaceCustom?: boolean;
  dropIneligibleLocks?: boolean;
  /** Left out: the limits the plan may let give way already. */
  allowRelaxations?: PlanRelaxation[];
}

/** What a re-roll sends: nothing at all when it asks for nothing of its own. */
export function rerollBody(v: Reroll): Record<string, unknown> | undefined {
  const body = {
    ...(v.from ? { from: v.from } : {}),
    ...(v.to ? { to: v.to } : {}),
    ...(v.includePast ? { includePast: true } : {}),
    ...(v.replaceEaten ? { replaceEaten: true } : {}),
    ...(v.replaceCustom ? { replaceCustom: true } : {}),
    ...(v.dropIneligibleLocks ? { dropIneligibleLocks: true } : {}),
    ...(v.allowRelaxations ? { allowRelaxations: v.allowRelaxations } : {}),
  };
  return Object.keys(body).length > 0 ? body : undefined;
}

/** How much of a plan is asked for: all of it, what is left of it from today, the days from one to another, or one day. */
export type RerollScope = 'whole' | 'from_today' | 'range' | 'day';
