// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { useTranslations } from 'next-intl';

/**
 * The first stop of the Tab key on a page of the application: past the bell and the eleven links of the sidebar,
 * straight to what the page is about. Seen only while it has the focus. Drawn on the server: it brings the page no
 * script.
 */
export function SkipLink({ to }: { to: string }) {
  const t = useTranslations('common');
  return (
    <a
      href={`#${to}`}
      // Its box only while it shows: what `not-sr-only` puts back (no padding, no margin) comes before these.
      className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-md"
    >
      {t('skipToContent')}
    </a>
  );
}
