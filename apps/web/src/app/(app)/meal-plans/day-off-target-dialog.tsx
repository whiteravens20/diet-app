// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import type { MealPlanDay } from '@diet-app/shared';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { useFormat } from '@/lib/use-format';
import { ListNote } from './list-note';

/** What can be done of a day off its target, and where its parts are taken from. */
export interface OffTargetWays {
  day: MealPlanDay;
  /** Another day of the plan, from today on, can take a part of the gap. */
  spreads: boolean;
  /** One of those days is on a shopping list already. */
  listed: boolean;
}

/**
 * The question a day off its target asks, opened from the mark on the day: how far off it is, why, and the ways
 * the plan has to close it, each with what it does said before it is pressed. Sizing the day again is offered where
 * it would move a meal, spreading where another day from today on can take a part.
 */
export function DayOffTargetDialog({
  ways,
  busy,
  onResize,
  onSpread,
  onClose,
}: {
  ways: OffTargetWays;
  busy: boolean;
  onResize: () => void;
  onSpread: () => void;
  onClose: () => void;
}) {
  const t = useTranslations('mealPlans');
  const tCommon = useTranslations('common');
  const fmt = useFormat();
  const { day, spreads, listed } = ways;
  const over = day.offTarget === 'over';
  const question = t(over ? 'offTargetQuestionOver' : 'offTargetQuestionUnder', {
    kcal: Math.abs(Math.round(day.calorieDelta)),
  });
  const hint = t(
    day.diary
      ? over
        ? 'dayOverDiaryHint'
        : 'dayUnderDiaryHint'
      : over
        ? 'dayOverHint'
        : 'dayUnderHint',
  );

  return (
    <Dialog open onClose={onClose} label={question} className="max-w-lg">
      <div className="flex items-center justify-between gap-2 border-b border-border p-4">
        <div>
          <h2 className="font-semibold">{question}</h2>
          <p className="text-xs text-muted-foreground">{fmt.day(day.date)}</p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {tCommon('close')}
        </Button>
      </div>
      <div className="space-y-4 p-4 text-sm">
        <p className="text-muted-foreground">{hint}</p>
        {day.resizes && (
          <div className="space-y-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onResize}
              disabled={busy}
              aria-describedby={`${day.id}-resize`}
            >
              {t('resizeDay')}
            </Button>
            <p id={`${day.id}-resize`} className="text-xs text-muted-foreground">
              {t(day.diary ? 'resizeDayNote' : 'resizeDayNotePlain')}
            </p>
          </div>
        )}
        {spreads && (
          <div className="space-y-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onSpread}
              disabled={busy}
              aria-describedby={`${day.id}-spread`}
            >
              {t('spread')}
            </Button>
            <p id={`${day.id}-spread`} className="text-xs text-muted-foreground">
              {t(over ? 'spreadNoteOver' : 'spreadNoteUnder')}
            </p>
            <ListNote days="several" listed={listed} />
          </div>
        )}
      </div>
    </Dialog>
  );
}
