// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

/** A longer explanation of a part of the panel, closed until it is asked for. */
export function Explain({ children }: { children: ReactNode }) {
  const t = useTranslations('admin');
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="min-h-6 w-fit cursor-pointer leading-6 underline-offset-2 hover:underline">
        {t('explainMore')}
      </summary>
      <div className="mt-1 space-y-2">{children}</div>
    </details>
  );
}
