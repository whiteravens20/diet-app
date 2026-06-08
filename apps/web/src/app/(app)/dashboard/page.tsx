'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { UserRound } from 'lucide-react';
import type { Profile } from '@diet-app/shared';
import { api } from '@/lib/api';
import { buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/empty-state';
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
      <div className="mt-16">
        <EmptyState
          icon={UserRound}
          title={t('welcome')}
          description={t('createFirstProfile')}
          cta={
            <Link href="/profile" className={buttonVariants({ size: 'md' })}>
              {t('createFirstProfileCta')}
            </Link>
          }
        />
      </div>
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
