// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId } from 'react';
import type { CaloriePreview, CaloriePreviewRequest } from '@diet-app/shared';
import { api } from '@/lib/api';
import { useSettled } from '@/lib/use-settled';
import { TargetNotices } from '@/components/target-notices';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/** How long the typing has to pause before the figures are asked for, in milliseconds. */
const PAUSE = 400;

/**
 * What the figures of a form come to. The calorie maths is the engine's
 * alone, so they are asked of the API: once the typing has paused, and once
 * for the same figures. `asked` is null while the form holds nothing that can
 * be worked out, and then there is no preview.
 *
 * `behind` says that what is shown belongs to what was typed a moment ago,
 * `waiting` that there are figures to work out and no answer to show yet.
 */
export function useCaloriePreview(asked: CaloriePreviewRequest | null): {
  preview: CaloriePreview | undefined;
  behind: boolean;
  waiting: boolean;
  failed: boolean;
} {
  const written = asked ? JSON.stringify(asked) : null;
  const settled = useSettled(written, PAUSE);
  const answer = useQuery({
    queryKey: ['calorie-preview', settled],
    queryFn: () =>
      api.post<CaloriePreview>('/profiles/calories', JSON.parse(settled!) as CaloriePreviewRequest),
    enabled: settled !== null,
    staleTime: Infinity,
    placeholderData: keepPreviousData,
    retry: false,
  });
  // Figures that can no longer be worked out show nothing, not what they came to before.
  const preview = written === null ? undefined : answer.data;
  const failed = written !== null && written === settled && answer.isError;
  return {
    preview,
    behind: written !== settled || answer.isPlaceholderData,
    waiting: written !== null && preview === undefined && !failed,
    failed,
  };
}

/**
 * The figures a form's numbers come to, beside the form: the target of a
 * day, maintenance, what the body uses at rest, the grams of protein, fat
 * and carbohydrate, and what stands behind a target that is not simply
 * maintenance less the pace. The warnings for somebody under 18 or
 * underweight are the form's own to give, with the box that answers them.
 */
export function CaloriePreviewPanel({
  preview,
  behind,
  waiting,
  failed,
  heading: Heading = 'h4',
  className,
}: {
  preview: CaloriePreview | undefined;
  behind: boolean;
  waiting: boolean;
  failed: boolean;
  /** The level of the panel's heading: one under that of what it stands in, which is a card unless it is said. */
  heading?: 'h2' | 'h4';
  className?: string;
}) {
  const t = useTranslations('caloriePreview');
  const title = useId();
  const c = preview?.calculation;
  return (
    <section
      aria-labelledby={title}
      className={cn('space-y-3 rounded-lg border border-border bg-muted/30 p-4', className)}
    >
      <Heading id={title} className="text-sm font-semibold">
        {t('title')}
      </Heading>
      {c ? (
        <div
          className={cn('space-y-3 transition-opacity', behind && 'opacity-60')}
          aria-busy={behind}
        >
          {/* The target has a line of its own: beside the two it is worked out from, a narrow panel would break it in two. */}
          <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
            <div className="col-span-2">
              <dt className="text-xs text-muted-foreground">{t('dailyTarget')}</dt>
              <dd className="text-2xl font-semibold tracking-tight tabular-nums">
                {t('kcal', { value: c.dailyTarget })}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('maintenance')}</dt>
              <dd className="text-sm font-medium tabular-nums">
                {t('kcal', { value: c.maintenance })}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('atRest')}</dt>
              <dd className="text-sm font-medium tabular-nums">{t('kcal', { value: c.bmr })}</dd>
            </div>
          </dl>
          <p className="text-xs text-muted-foreground">
            {c.goalHeld
              ? t('held')
              : c.dailyDeficit === 0
                ? t('atMaintenance')
                : c.dailyDeficit > 0
                  ? t('under', { kcal: c.dailyDeficit })
                  : t('over', { kcal: -c.dailyDeficit })}
          </p>
          <p className="text-sm">{t('macros', c.targetMacros)}</p>
          <TargetNotices calories={c} risk={false} />
        </div>
      ) : waiting ? (
        // There are figures to work out, and the answer is on its way: nothing is asked of the reader.
        <Skeleton className="h-24" aria-label={t('waiting')} role="status" />
      ) : (
        <p className="text-sm text-muted-foreground">{failed ? t('failed') : t('pending')}</p>
      )}
      {/* The target is read out when it changes, the rest is there to be read. */}
      <p className="sr-only" aria-live="polite">
        {c && !behind ? t('said', { kcal: c.dailyTarget }) : ''}
      </p>
    </section>
  );
}
