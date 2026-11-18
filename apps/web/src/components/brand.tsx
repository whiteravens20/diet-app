// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import Image from 'next/image';
import { cn } from '@/lib/utils';

/**
 * The application's name beside its mark, wherever the product introduces itself: the sidebar, the phone's bar and
 * its drawer, the head of the home page and the pages of signing in.
 */
export function Brand({
  name,
  size,
  className,
}: {
  name: string;
  size: number;
  className: string;
}) {
  return (
    <span className={cn('flex items-center gap-2 font-semibold tracking-tight', className)}>
      <Image src="/icon-192.png" alt="" width={size} height={size} className="rounded-md" />
      {name}
    </span>
  );
}
