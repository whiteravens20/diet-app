// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { partsOf, SplitCalculator, type SplitPortion } from '@/components/split-calculator';

/**
 * The window a dish cooked ahead, or a pot both people cook, is split in, into the portions of the plan, by the
 * plan's shares: their energy, or what each takes of a part weighed alone.
 */
export function SplitDialog({
  portions,
  onClose,
}: {
  portions: SplitPortion[];
  onClose: () => void;
}) {
  const t = useTranslations('split');
  const tCommon = useTranslations('common');
  return (
    <Dialog open onClose={onClose} label={t('title')} className="max-w-lg">
      <div className="flex items-center justify-between border-b border-border p-4">
        <h2 className="font-semibold">{t('title')}</h2>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {tCommon('close')}
        </Button>
      </div>
      <div className="space-y-4 p-4">
        <p className="text-sm text-muted-foreground">
          {t(partsOf(portions).length > 0 ? 'planIntroParts' : 'planIntro')}
        </p>
        <SplitCalculator portions={portions} />
      </div>
    </Dialog>
  );
}
