// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

/**
 * Said once beside what asks a model, on an account that has no model to
 * ask: that those actions are off, and where that is changed. An action that
 * is off stays in its place, disabled, and names this line as its
 * description, so that it says the same to somebody who does not see it. A
 * disabled button alone says nothing where there is no pointer to hover with.
 */
export function AiOffNote({ id, className }: { id: string; className?: string }) {
  const t = useTranslations('aiOff');
  return (
    <p id={id} className={cn('text-xs text-muted-foreground', className)}>
      {t.rich('note', {
        settings: (chunks) => (
          <Link href="/settings" className="font-medium text-primary underline-offset-2 hover:underline">
            {chunks}
          </Link>
        ),
      })}
    </p>
  );
}
