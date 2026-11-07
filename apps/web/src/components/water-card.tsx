// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { GLASS_ML, MAX_WATER_ENTRY_ML, type Profile, type WaterDay } from '@diet-app/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { localDate } from '@/lib/http';
import { useErrorText } from '@/lib/use-error-text';
import { useFormat } from '@/lib/use-format';

/** The key a day's water is kept under, read again by whoever changes it. */
const waterKey = (profileId: string, day: string) => ['water', profileId, day] as const;

/**
 * The water of a profile's day: what was drunk against the profile's target,
 * a glass added or taken back at a press, or an amount of one's own. On the
 * dashboard it is today's; in the diary it is the day the diary shows.
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
  const add = useMutation({
    mutationFn: (ml: number) => api.post<WaterDay>('/water', { profileId: profile.id, day, ml }),
    onMutate: () => setError(null),
    onSuccess: (answer) => {
      qc.setQueryData(waterKey(profile.id, day), answer);
      setTyped('');
    },
    onError: (err) => setError(errorText(err, t('errAdd'))),
  });

  const liters = (ml: number): string => fmt.unit(ml / 1000, 'liter', 2);
  const shown = water.data;
  const own = Number(typed);
  const ownFits =
    typed.trim() !== '' && Number.isInteger(own) && own > 0 && own <= MAX_WATER_ENTRY_ML;

  return (
    <Card>
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
          <Button
            type="button"
            size="sm"
            disabled={add.isPending || !shown}
            onClick={() => add.mutate(GLASS_ML)}
          >
            {t('addGlass')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label={t('takeBackLabel')}
            disabled={add.isPending || !shown || shown.ml < GLASS_ML}
            onClick={() => add.mutate(-GLASS_ML)}
          >
            {t('takeBack')}
          </Button>
        </div>
        <form
          className="flex max-w-sm items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (ownFits) add.mutate(own);
          }}
        >
          <div className="min-w-0 flex-1">
            <Field label={t('own')} hint={t('glassNote')}>
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
          <Button
            type="submit"
            size="md"
            variant="outline"
            disabled={add.isPending || !ownFits}
            className="mb-5"
          >
            {t('add')}
          </Button>
        </form>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
