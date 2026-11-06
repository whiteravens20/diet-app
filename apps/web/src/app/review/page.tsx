// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { ReviewSurface } from './review-surface';
import { DOT } from '@/lib/figure-line';

export const metadata = { title: `Review${DOT}Diet App` };

export default function ReviewPage() {
  return <ReviewSurface />;
}
