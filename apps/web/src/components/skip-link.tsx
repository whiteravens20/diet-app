// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';

/**
 * The first stop of the Tab key on a page of the application: past the bell and the eleven links of the sidebar,
 * straight to what the page is about. Seen only while it has the focus.
 */
export function SkipLink({ to }: { to: string }) {
  const t = useTranslations('common');
  return (
    <a
      href={`#${to}`}
      className="sr-only rounded-md bg-background px-3 py-2 text-sm font-medium text-foreground shadow-md focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50"
    >
      {t('skipToContent')}
    </a>
  );
}
