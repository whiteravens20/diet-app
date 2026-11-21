// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.
'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import type {
  CreateDiaryEntryRequest,
  DiaryDay,
  MealType,
  Profile,
  WrittenDiaryEntry,
} from '@diet-app/shared';
import { MEAL_SLOTS_BY_COUNT } from '@diet-app/shared/constants';
import { api } from '@/lib/api';
import { localDate } from '@/lib/http';
import { useErrorText } from '@/lib/use-error-text';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ReadsFailed, unread } from '@/components/load-failed';
import { Skeleton } from '@/components/ui/skeleton';

/** The diary's window that adds an entry: fetched when it is first opened, not with the dashboard. */
const AddEntryDialog = dynamic(
  () => import('@/app/(app)/diary/add-entry-dialog').then((dialog) => dialog.AddEntryDialog),
  { ssr: false, loading: () => null },
);

/**
 * What a profile ate today against the day's target, first on the dashboard as on the phone: the
 * diary's window that adds an entry opens over the dashboard, and the diary of the day is one press
 * away. `children` stands under what was eaten: the target's own figures.
 */
export function TodayCard({ profile, children }: { profile: Profile; children?: ReactNode }) {
  const t = useTranslations('diary');
  const tPlans = useTranslations('mealPlans');
  const errorText = useErrorText();
  const qc = useQueryClient();
  const today = localDate();
  const day = useQuery({
    queryKey: ['diary', profile.id, today],
    queryFn: () => api.get<DiaryDay>(`/diary/day?profileId=${profile.id}&date=${today}`),
  });
  const [adding, setAdding] = useState<MealType | null>(null);
  const [error, setError] = useState<string | null>(null);
  // An entry of today sizes the day of its plan again: said here in a word, the plan shows how.
  const [resized, setResized] = useState(false);
  const add = useMutation({
    mutationFn: (body: CreateDiaryEntryRequest) =>
      api.post<WrittenDiaryEntry>('/diary/entries', body),
    onMutate: () => {
      setError(null);
      setResized(false);
    },
    onSuccess: async (written) => {
      setAdding(null);
      setResized((written.planChange?.rebalance?.changes.length ?? 0) > 0);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['diary'] }),
        qc.invalidateQueries({ queryKey: ['plan-overview'] }),
        qc.invalidateQueries({ queryKey: ['week-summary', profile.id] }),
        qc.invalidateQueries({ queryKey: ['meal-plans'] }),
        qc.invalidateQueries({ queryKey: ['meal-plan'] }),
      ]);
    },
    onError: (e) => setError(errorText(e, t('errAdd'))),
  });
  const shown = day.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('today')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {unread(day) ? (
          <ReadsFailed reads={[day]} unanswered />
        ) : !shown ? (
          <Skeleton className="h-8" />
        ) : (
          <p className="text-2xl font-semibold tabular-nums">
            {shown.estimated && '≈ '}
            {t('eatenLine', { eaten: shown.eaten.calories, target: shown.target.calories })}
          </p>
        )}
        {children}
        {resized && (
          <p role="status" className="text-sm text-muted-foreground">
            {tPlans('rebalanceTitle')}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {/* The window opens on the first meal of a day: it says which one it is written for. */}
          <Button type="button" onClick={() => setAdding(MEAL_SLOTS_BY_COUNT[5]![0]!)}>
            <Plus className="h-4 w-4" aria-hidden />
            {t('addTitle')}
          </Button>
          <Link
            href={`/diary?profile=${profile.id}`}
            className={buttonVariants({ variant: 'outline' })}
          >
            {t('openDiary')}
          </Link>
        </div>
      </CardContent>
      {adding && (
        <AddEntryDialog
          meal={adding}
          date={today}
          busy={add.isPending}
          error={error}
          onClose={() => setAdding(null)}
          onSubmit={(entry) => add.mutate({ ...entry, profileId: profile.id, date: today })}
        />
      )}
    </Card>
  );
}
