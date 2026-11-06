// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

/**
 * What a change of a plan says before it is made where a shopping list covers
 * a day it changes: the list will say it is out of date, and making it again
 * counts what is at home already. Nothing where no list covers them.
 */
export function ListNote({
  listed,
  days = 'one',
  className,
}: {
  listed: boolean;
  /** Whether the change is of one day or of several. */
  days?: 'one' | 'several';
  className?: string;
}) {
  const t = useTranslations('mealPlans');
  if (!listed) return null;
  return (
    <p className={cn('text-xs text-muted-foreground', className)}>
      {t(days === 'one' ? 'listOutOfDateDay' : 'listOutOfDateDays')}
    </p>
  );
}
