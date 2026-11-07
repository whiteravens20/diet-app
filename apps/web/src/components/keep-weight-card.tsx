// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { Profile } from '@diet-app/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';
import { localDate } from '@/lib/http';
import { useErrorText } from '@/lib/use-error-text';
import { useFormat } from '@/lib/use-format';
import { shownWeight, useWeightUnit } from '@/lib/weight-unit';

/**
 * The weight worked towards is reached, on the dashboard: the offer to keep
 * it from now on (`POST /profiles/:id/keep-weight`), or to be asked again in
 * two weeks ("Nie teraz"). Nothing until the newest weight comes down to the
 * target weight while the pace still loses, nor while the offer is put off.
 */
export function KeepWeightCard({ profile }: { profile: Profile }) {
  const t = useTranslations('keepWeight');
  const fmt = useFormat();
  const unit = useWeightUnit();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const decide = useMutation({
    mutationFn: (what: 'keep' | 'later') =>
      api.post<Profile>(
        `/profiles/${profile.id}/${what === 'keep' ? 'keep-weight' : 'keep-weight/later'}`,
      ),
    onMutate: () => setError(null),
    onSuccess: () => {
      // The pace sets the target of the profile, of its diary and of a plan's offer to take it.
      qc.invalidateQueries({ queryKey: ['profiles'] });
      qc.invalidateQueries({ queryKey: ['calories', profile.id] });
      qc.invalidateQueries({ queryKey: ['diary', profile.id] });
      qc.invalidateQueries({ queryKey: ['meal-plans'] });
      qc.invalidateQueries({ queryKey: ['meal-plan'] });
    },
    onError: (err) => setError(errorText(err, t('errAct'))),
  });

  const putOff = profile.targetReachedLaterUntil;
  if (!profile.targetWeightReached || profile.targetWeightKg === null) return null;
  if (putOff !== null && putOff > localDate()) return null;
  const target = fmt.unit(
    shownWeight(profile.targetWeightKg, unit),
    unit === 'lb' ? 'pound' : 'kilogram',
    1,
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p>{t('reached', { target })}</p>
        <p className="text-muted-foreground">{t('note')}</p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            disabled={decide.isPending}
            onClick={() => decide.mutate('keep')}
          >
            {t('keep')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={decide.isPending}
            onClick={() => decide.mutate('later')}
          >
            {t('later')}
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
