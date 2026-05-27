'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import type { Profile } from '@diet-app/shared';
import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ProfileSummary } from '@/components/profile-summary';

/** Dashboard — calorie target, macro split and adherence for every profile. */
export default function DashboardPage() {
  const t = useTranslations('dashboard');
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: () => api.get<Profile[]>('/profiles') });

  if (profiles.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-4 gap-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      </div>
    );
  }

  const list = profiles.data ?? [];

  if (list.length === 0) {
    return (
      <Card className="mx-auto mt-20 max-w-md text-center">
        <CardHeader>
          <CardTitle>{t('welcome')}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{t('createFirstProfile')}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">
          {list.length === 1
            ? t('subheadSingle')
            : t('subheadMultiple', { count: list.length })}
        </p>
      </header>

      {list.map((p) => (
        <ProfileSummary key={p.id} profile={p} />
      ))}
    </div>
  );
}
