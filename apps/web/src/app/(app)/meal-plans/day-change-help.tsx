// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { useFormat } from '@/lib/use-format';

/**
 * How a day of a plan is changed with the user's own meals kept: what stays, which way to choose when, from when, and
 * what a change takes with it; with the two ways that give the day other dishes, opened for the day at hand.
 */
export function DayChangeHelp({
  date,
  joint,
  busy,
  onVariants,
  onReroll,
  onClose,
}: {
  date: string;
  /** The plan is one of a joint plan: a day is made again for both, or for one. */
  joint: boolean;
  busy: boolean;
  onVariants: () => void;
  onReroll: () => void;
  onClose: () => void;
}) {
  const t = useTranslations('mealPlans');
  const tHelp = useTranslations('mealPlans.dayHelp');
  const tCommon = useTranslations('common');
  const fmt = useFormat();

  return (
    <Dialog open onClose={onClose} label={tHelp('title')} className="max-w-lg">
      <div className="flex items-center justify-between gap-2 border-b border-border p-4">
        <div>
          <h2 className="font-semibold">{tHelp('title')}</h2>
          <p className="text-xs text-muted-foreground">{fmt.day(date)}</p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {tCommon('close')}
        </Button>
      </div>
      <div className="space-y-4 p-4 text-sm">
        <section className="space-y-1">
          <h3 className="font-medium">{tHelp('keptTitle')}</h3>
          <p className="text-muted-foreground">{tHelp('kept')}</p>
        </section>
        <section className="space-y-1">
          <h3 className="font-medium">{tHelp('waysTitle')}</h3>
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            <li>{tHelp('wayResize')}</li>
            <li>{tHelp('waySwap')}</li>
            <li>{tHelp('wayVariants')}</li>
            <li>{tHelp('wayReroll')}</li>
          </ul>
        </section>
        <section className="space-y-1">
          <h3 className="font-medium">{tHelp('whenTitle')}</h3>
          <p className="text-muted-foreground">{tHelp('when')}</p>
        </section>
        <section className="space-y-1">
          <h3 className="font-medium">{tHelp('affectsTitle')}</h3>
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            <li>{tHelp('affectsList')}</li>
            <li>{tHelp('affectsDiary')}</li>
            <li>{tHelp('affectsCooking')}</li>
            {joint && <li>{tHelp('affectsJoint')}</li>}
            <li>{tHelp('affectsUndo')}</li>
          </ul>
        </section>
        <div className="flex flex-wrap gap-2 border-t border-border pt-4">
          <Button type="button" variant="outline" size="sm" onClick={onVariants} disabled={busy}>
            {t('otherWays')}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onReroll} disabled={busy}>
            {t('changeDay')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
