// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Undo2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import type { Profile, WaterDay } from '@diet-app/shared';
import { MAX_WATER_ENTRY_ML, WATER_AMOUNTS_ML } from '@diet-app/shared/constants';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { held } from '@/lib/figure-line';
import { localDate } from '@/lib/http';
import { useErrorText } from '@/lib/use-error-text';
import { useFormat } from '@/lib/use-format';
import { waterCardAnchor } from '@/lib/water-card-anchor';

/** As high as the chart of the days, so that the card does not jump when the chart arrives. */
const CHART_HEIGHT = 132;

/** Fetched when a card shows its days: the charting library comes with it, and not before. */
const WaterDaysChart = dynamic(
  () => import('@/components/water-days-chart').then((chart) => chart.WaterDaysChart),
  { ssr: false, loading: () => <Skeleton style={{ height: CHART_HEIGHT }} /> },
);

/** The key a day's water is kept under, read again by whoever changes it. */
const waterKey = (profileId: string, day: string) => ['water', profileId, day] as const;

/**
 * The water of a profile's day: what was drunk against the profile's target,
 * an amount added at a press or typed, the last entry removed, and the seven
 * days up to it. On the dashboard it is today's; in the diary it is the day
 * the diary shows. A page opened at the card's anchor comes to it once the
 * day is shown: a reminder of water links there.
 */
export function WaterCard({ profile, day = localDate() }: { profile: Profile; day?: string }) {
  const t = useTranslations('water');
  const fmt = useFormat();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);

  const water = useQuery({
    queryKey: waterKey(profile.id, day),
    queryFn: () => api.get<WaterDay>(`/water?profileId=${profile.id}&day=${day}`),
  });
  /** The day as the API answers it, and the week in sum, whose water it changes. */
  const settled = (answer: WaterDay) => {
    qc.setQueryData(waterKey(profile.id, day), answer);
    void qc.invalidateQueries({ queryKey: ['week-summary', profile.id] });
  };
  const add = useMutation({
    mutationFn: (ml: number) => api.post<WaterDay>('/water', { profileId: profile.id, day, ml }),
    onMutate: () => setError(null),
    onSuccess: (answer) => {
      settled(answer);
      setTyped('');
    },
    onError: (err) => setError(errorText(err, t('errAdd'))),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete<WaterDay>(`/water/${id}`),
    onMutate: () => setError(null),
    onSuccess: settled,
    onError: (err) => setError(errorText(err, t('errRemove'))),
  });

  const liters = (ml: number): string => fmt.unit(ml / 1000, 'liter', 2);
  const shown = water.data;
  const busy = add.isPending || remove.isPending || !shown;
  const own = Number(typed);
  const ownFits =
    typed.trim() !== '' && Number.isInteger(own) && own > 0 && own <= MAX_WATER_ENTRY_ML;
  const target = shown?.target ?? null;
  const reached = target === null ? [] : (shown?.days ?? []).filter((d) => d.ml >= target);
  const anchor = waterCardAnchor(profile.id);
  const ready = shown !== undefined;
  useEffect(() => {
    if (ready && window.location.hash === `#${anchor}`) {
      document.getElementById(anchor)?.scrollIntoView({ block: 'start' });
    }
  }, [ready, anchor]);

  return (
    <Card id={anchor} className="scroll-mt-4">
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {!shown ? (
          <Skeleton className="h-10" />
        ) : (
          <>
            <p className="text-lg font-semibold tabular-nums">
              {shown.target === null
                ? t('drunkNoTarget', { drunk: liters(shown.ml) })
                : t('drunk', { drunk: liters(shown.ml), target: liters(shown.target) })}
            </p>
            {shown.target !== null && (
              <div
                role="progressbar"
                aria-label={t('title')}
                aria-valuemin={0}
                aria-valuemax={shown.target}
                aria-valuenow={Math.min(shown.ml, shown.target)}
                className="h-2 overflow-hidden rounded-full bg-muted"
              >
                <div
                  className="h-full rounded-full bg-primary transition-[width]"
                  style={{ width: `${Math.min(100, (shown.ml / shown.target) * 100)}%` }}
                />
              </div>
            )}
          </>
        )}
        <div className="flex flex-wrap gap-2">
          {WATER_AMOUNTS_ML.map((ml) => (
            <Button key={ml} type="button" size="sm" disabled={busy} onClick={() => add.mutate(ml)}>
              {t('addMl', { ml })}
            </Button>
          ))}
        </div>
        <form
          className="flex max-w-sm items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (ownFits) add.mutate(own);
          }}
        >
          <div className="min-w-0 flex-1">
            <Field label={t('own')}>
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={MAX_WATER_ENTRY_ML}
                step={1}
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
              />
            </Field>
          </div>
          <Button type="submit" size="md" variant="outline" disabled={busy || !ownFits}>
            {t('add')}
          </Button>
        </form>
        {shown?.last && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => remove.mutate(shown.last!.id)}
            className="text-muted-foreground"
          >
            <Undo2 size={14} aria-hidden />
            <span className="ml-1">{t('removeLast')}</span>
            <span className="ml-1 text-xs">
              (
              {t('removeLastLabel', {
                amount: held(fmt.unit(shown.last.ml, 'milliliter')),
                time: fmt.time(shown.last.at),
              })}
              )
            </span>
          </Button>
        )}
        {shown && (
          <div className="space-y-1">
            <WaterDaysChart days={shown.days} target={target} shown={day} height={CHART_HEIGHT} />
            <ul className="sr-only" aria-label={t('daysLabel', { day: fmt.day(day) })}>
              {shown.days.map((d) => (
                <li key={d.day}>
                  {t(target !== null && d.ml >= target ? 'dayReached' : 'dayLine', {
                    day: fmt.day(d.day),
                    amount: liters(d.ml),
                  })}
                </li>
              ))}
            </ul>
            {target !== null && (
              <p className="text-sm text-muted-foreground">
                {t('inTarget', { reached: reached.length, days: shown.days.length })}
              </p>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
