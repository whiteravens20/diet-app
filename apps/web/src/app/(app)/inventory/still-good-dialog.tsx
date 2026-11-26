// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import type { InventoryItem } from '@diet-app/shared';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { localDate } from '@/lib/http';
import { useFormat } from '@/lib/use-format';

/**
 * "Nadal dobre": fresh stock past its best-before day is still good. A new day, today or later, may be given; left
 * empty, the stock counts at home again as it is until its day or amount changes (`InventoryItem.keptPastDate`).
 */
export function StillGoodDialog({
  item,
  busy,
  error,
  onSave,
  onClose,
}: {
  item: InventoryItem;
  busy: boolean;
  /** Why the last try did not go through, in the reader's words. */
  error: string | null;
  /** The new day, or null for none. */
  onSave: (bestBefore: string | null) => void;
  onClose: () => void;
}) {
  const t = useTranslations('inventory');
  const tCommon = useTranslations('common');
  const fmt = useFormat();
  const [day, setDay] = useState('');
  const fieldId = useId();
  const today = localDate();
  // A day before today would be past again: the field takes none.
  const fits = day === '' || day >= today;
  return (
    <Dialog open onClose={onClose} label={t('stillGoodTitle')} className="max-w-md">
      <div className="flex items-center justify-between border-b border-border p-4">
        <div className="min-w-0">
          <h2 className="font-semibold">{t('stillGoodTitle')}</h2>
          <p className="break-words text-xs text-muted-foreground">
            {fmt.text(item.ingredient.name)}
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {tCommon('close')}
        </Button>
      </div>
      <form
        className="space-y-4 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (fits) onSave(day === '' ? null : day);
        }}
      >
        <p className="text-sm text-muted-foreground">{t('stillGoodIntro')}</p>
        <div className="space-y-1.5">
          <label htmlFor={fieldId} className="block text-xs font-medium text-muted-foreground">
            {t('stillGoodDate')}
          </label>
          <Input
            id={fieldId}
            type="date"
            min={today}
            value={day}
            onChange={(e) => setDay(e.target.value)}
            aria-invalid={!fits || undefined}
            className="w-44"
          />
        </div>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            {tCommon('cancel')}
          </Button>
          <Button type="submit" size="sm" disabled={busy || !fits}>
            {t('stillGood')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
