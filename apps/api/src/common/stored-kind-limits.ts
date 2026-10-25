// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { ProfilePreferences, type KindLimit } from '@diet-app/shared';

/** The kinds of protein a profile holds to numbers of their own, as the row keeps them as JSON; none where it keeps something else. */
export function storedKindLimits(kept: unknown): KindLimit[] {
  return ProfilePreferences.shape.kindLimits.safeParse(kept).data ?? [];
}
