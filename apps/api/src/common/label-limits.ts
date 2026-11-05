// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { NO_LABEL_LIMITS, type LabelLimits } from '@diet-app/shared';

/** The columns of a profile's preferences that keep its limits of a label. */
export interface LabelLimitColumns {
  saltAtMost: number | null;
  fiberAtLeast: number | null;
  saturatedFatAtMost: number | null;
  sugarsAtMost: number | null;
}

/** The limits a profile sets, from its preferences; none where it has no preferences yet. */
export function labelLimitsOf(preferences: LabelLimitColumns | null | undefined): LabelLimits {
  if (!preferences) return NO_LABEL_LIMITS;
  return {
    saltAtMost: preferences.saltAtMost,
    fiberAtLeast: preferences.fiberAtLeast,
    saturatedFatAtMost: preferences.saturatedFatAtMost,
    sugarsAtMost: preferences.sugarsAtMost,
  };
}
