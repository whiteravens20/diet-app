// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import type { AccountSession } from '@diet-app/shared';
import { api, ApiClientError } from '@/lib/api';
import { session as browserSession } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Where the account is signed in: every session that is open, with what it
 * was opened from and when it was last used. Any of them can be signed out,
 * or all at once. Signing out the session of this browser, alone or with the
 * others, leaves the page: `onSignedOut` says where to.
 */
export function SessionsCard({ onSignedOut }: { onSignedOut: () => void }) {
  const t = useTranslations('settings');
  const tErrors = useTranslations('errors');
  const format = useFormatter();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => api.get<AccountSession[]>('/users/me/sessions') });
  const worded = (err: unknown): string => (err instanceof ApiClientError && tErrors.has(err.code) ? tErrors(err.code) : t('sessionEndFailed'));
  const leave = (): void => {
    browserSession.forget();
    onSignedOut();
  };

  const end = useMutation({
    mutationFn: (id: string) => api.delete<void>(`/users/me/sessions/${id}`),
    onMutate: () => setError(null),
    onSuccess: (_, id) => (id === browserSession.id ? leave() : queryClient.invalidateQueries({ queryKey: ['sessions'] })),
    onError: (err) => {
      setError(worded(err));
      // A session that was gone already is no longer in the list either.
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
  const endAll = useMutation({
    mutationFn: () => api.delete<void>('/users/me/sessions'),
    onMutate: () => setError(null),
    onSuccess: leave,
    onError: (err) => setError(worded(err)),
  });

  const when = (iso: string): string => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });
  const busy = end.isPending || endAll.isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('sessions')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{t('sessionsBody')}</p>
        {sessions.isError && (
          <p role="alert" className="text-sm text-destructive">
            {t('sessionsFailed')}
          </p>
        )}
        {sessions.data && (
          <ul className="divide-y divide-border rounded-md border border-border">
            {sessions.data.map((open) => {
              const name = open.label ?? t('sessionUnknown');
              return (
                <li key={open.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {name}
                      {open.id === browserSession.id && (
                        <span className="ml-2 rounded bg-primary/10 px-1.5 py-0.5 text-xs font-normal text-primary">{t('sessionCurrent')}</span>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground">{t('sessionTimes', { started: when(open.startedAt), used: when(open.lastUsedAt) })}</p>
                  </div>
                  <Button type="button" variant="outline" size="sm" disabled={busy} aria-label={t('sessionEndNamed', { name })} onClick={() => end.mutate(open.id)}>
                    {t('sessionEnd')}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div>
          <Button type="button" variant="outline" disabled={busy} onClick={() => endAll.mutate()}>
            {t('sessionEndAll')}
          </Button>
          <p className="mt-1 text-xs text-muted-foreground">{t('sessionEndAllBody')}</p>
        </div>
      </CardContent>
    </Card>
  );
}
