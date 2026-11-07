// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { Expenditure, Profile } from '@diet-app/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';
import { useErrorText } from '@/lib/use-error-text';

const expenditureKey = (profileId: string) => ['expenditure', profileId] as const;

/** What a decision on the correction changes: the profile's target, and the profile that keeps it. */
function useDecision(profile: Profile) {
  const qc = useQueryClient();
  const errorText = useErrorText();
  const t = useTranslations('expenditure');
  const [error, setError] = useState<string | null>(null);
  const decide = useMutation({
    mutationFn: (what: 'accept' | 'later' | 'drop') =>
      api.post<Expenditure>(`/diary/expenditure/${what}`, { profileId: profile.id }),
    onMutate: () => setError(null),
    onSuccess: (answer) => {
      qc.setQueryData(expenditureKey(profile.id), answer);
      qc.invalidateQueries({ queryKey: ['calories', profile.id] });
      qc.invalidateQueries({ queryKey: ['profiles'] });
      qc.invalidateQueries({ queryKey: ['diary', profile.id] });
    },
    onError: (err) => setError(errorText(err, t('errAct'))),
  });
  return { decide, error };
}

/**
 * A corrected target the diary and the weights propose, on the dashboard:
 * what the body seems to use against what the formula says, and the target
 * that would come of it, to accept or put off. Nothing where nothing is
 * proposed: too little to go by, an expenditure near the formula's, a
 * proposal put off, or a correction already kept (the profile's page says that).
 */
export function ExpenditureCard({ profile }: { profile: Profile }) {
  const t = useTranslations('expenditure');
  const { decide, error } = useDecision(profile);
  const asked = useQuery({
    queryKey: expenditureKey(profile.id),
    queryFn: () => api.get<Expenditure>(`/diary/expenditure?profileId=${profile.id}`),
  });
  const shown = asked.data;
  if (!shown || shown.state !== 'proposed' || shown.estimate === null || shown.correction === null)
    return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p>
          {t('proposed', {
            estimate: shown.estimate,
            difference: Math.abs(shown.correction),
            more: String(shown.correction > 0),
            corrected: shown.targetCorrected ?? shown.target,
            target: shown.target,
          })}
        </p>
        <p className="text-muted-foreground">{t('note')}</p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            disabled={decide.isPending}
            onClick={() => decide.mutate('accept')}
          >
            {t('accept')}
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

/** The correction a profile keeps, on its page, with the way to take it away. */
export function KeptCorrection({ profile }: { profile: Profile }) {
  const t = useTranslations('expenditure');
  const { decide, error } = useDecision(profile);
  if (profile.expenditureCorrectionKcal === null) return null;
  const correction = profile.expenditureCorrectionKcal;
  return (
    <div className="space-y-2 rounded-md border border-border p-3 text-sm sm:col-span-2">
      <p>{t('kept', { correction: `${correction > 0 ? '+' : '−'}${Math.abs(correction)}` })}</p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={decide.isPending}
        onClick={() => decide.mutate('drop')}
      >
        {t('drop')}
      </Button>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
