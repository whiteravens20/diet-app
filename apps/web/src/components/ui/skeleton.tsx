import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/** Shimmering placeholder for loading states (see `.skeleton` in globals.css). */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('skeleton h-4 w-full', className)} {...props} />;
}
