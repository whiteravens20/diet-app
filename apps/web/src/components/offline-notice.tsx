// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import { WifiOff } from 'lucide-react';
import type { Replayed } from '@/lib/offline';
import { Button } from '@/components/ui/button';

/**
 * Said over the pages of an account while the server cannot be reached and
 * they are shown from what the browser kept: what the reader is looking at,
 * what can still be done, and how many ticks wait to be sent.
 */
export function OfflineNotice({
  waiting,
  trying,
  onRetry,
}: {
  waiting: number;
  trying: boolean;
  onRetry: () => void;
}) {
  const t = useTranslations('offline');
  const tCommon = useTranslations('common');
  return (
    <div
      role="status"
      className="mb-6 flex flex-wrap items-start gap-3 rounded-lg border border-warning/40 bg-warning/5 px-4 py-3 text-sm"
    >
      <WifiOff size={18} aria-hidden className="mt-0.5 shrink-0 text-warning" />
      <div className="min-w-0 flex-1 space-y-1">
        <p>{t('notice')}</p>
        {waiting > 0 && <p className="text-muted-foreground">{t('waiting', { count: waiting })}</p>}
      </div>
      <Button type="button" variant="outline" size="sm" disabled={trying} onClick={onRetry}>
        {tCommon('retry')}
      </Button>
    </div>
  );
}

/** What became of the ticks that waited, said once they were sent. */
export function ReplayedNotice({ result, onClose }: { result: Replayed; onClose: () => void }) {
  const t = useTranslations('offline');
  const tCommon = useTranslations('common');
  return (
    <div
      role="status"
      className="mb-6 flex flex-wrap items-start gap-3 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm"
    >
      <div className="min-w-0 flex-1 space-y-1">
        {result.sent > 0 && <p>{t('sent', { sent: result.sent })}</p>}
        {result.refused > 0 && (
          <p className="text-warning">{t('refused', { refused: result.refused })}</p>
        )}
      </div>
      <Button type="button" variant="ghost" size="sm" onClick={onClose}>
        {tCommon('close')}
      </Button>
    </div>
  );
}
