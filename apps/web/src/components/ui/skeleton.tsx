// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/** Shimmering placeholder for loading states (see `.skeleton` in globals.css). */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('skeleton h-4 w-full', className)} {...props} />;
}
