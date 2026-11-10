// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';

/**
 * A text the page could not put on the clipboard, shown in a window to be
 * selected and copied by hand: over plain http a browser gives a page no
 * clipboard. Open while `text` is set.
 */
export function CopyByHand({
  text,
  label,
  onClose,
}: {
  text: string | null;
  /** What is to be copied, as the window's title: "Copy the list". */
  label: string;
  onClose: () => void;
}) {
  const t = useTranslations('common');
  return (
    <Dialog open={text !== null} onClose={onClose} label={label} className="max-w-md">
      <div className="space-y-3 p-4">
        <h2 className="font-semibold">{label}</h2>
        <p className="text-sm text-muted-foreground">{t('copyByHandHint')}</p>
        <textarea
          readOnly
          rows={12}
          aria-label={label}
          className="w-full rounded-md border border-input bg-background p-2 font-mono text-xs"
          value={text ?? ''}
          onFocus={(event) => event.currentTarget.select()}
        />
        <div className="flex justify-end">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            {t('close')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
