// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { UserRound } from 'lucide-react';
import type { Profile } from '@diet-app/shared';
import { api } from '@/lib/api';
import { buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/empty-state';
import { ProfileChips } from '@/components/profile-chips';
import { ProfileSummary } from '@/components/profile-summary';
import { PageBanner } from '@/components/page-banner';
import { IMAGERY } from '@/lib/imagery';
import { LoadFailed, ReadsFailed, unread } from '@/components/load-failed';

/** Dashboard: a profile's day, target, plan, water and weight, one profile at a time, chosen by its chip. */
export default function DashboardPage() {
  return (
    <Suspense fallback={<DashboardLoading />}>
      <Dashboard />
    </Suspense>
  );
}

function DashboardLoading() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-40" />
    </div>
  );
}

function Dashboard() {
  const t = useTranslations('dashboard');
  const router = useRouter();
  const params = useSearchParams();
  const profiles = useQuery({
    queryKey: ['profiles'],
    queryFn: () => api.get<Profile[]>('/profiles'),
  });

  if (profiles.isLoading) return <DashboardLoading />;

  if (unread(profiles))
    return <LoadFailed error={profiles.error} onRetry={() => void profiles.refetch()} />;

  const list = profiles.data ?? [];

  if (list.length === 0) {
    return (
      <div className="mt-16">
        <EmptyState
          icon={UserRound}
          image={IMAGERY.emptyDashboard}
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

  // The profile shown is the one the address names: its chip writes it there, a reminder links to it, and a reload
  // keeps it. The first profile where the address names none, or one the account no longer has.
  const active = list.find((profile) => profile.id === params.get('profile')) ?? list[0]!;

  return (
    <div className="space-y-8">
      <PageBanner
        image={IMAGERY.dashboard}
        title={t('title')}
        subtitle={
          list.length === 1 ? t('subheadSingle') : t('subheadMultiple', { count: list.length })
        }
      />
      <ReadsFailed reads={[profiles]} />
      <ProfileChips
        profiles={list}
        active={active.id}
        onPick={(id) => router.replace(`/dashboard?profile=${id}`, { scroll: false })}
      />
      <ProfileSummary key={active.id} profile={active} />
    </div>
  );
}
