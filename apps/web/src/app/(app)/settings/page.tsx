// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Suspense } from 'react';
import { type SessionUser } from '@diet-app/shared';
import { api } from '@/lib/api';
import { IMAGERY } from '@/lib/imagery';
import { SecondFactorCard } from './second-factor-card';
import { DataExportCard } from './data-export-card';
import { SessionsCard } from './sessions-card';
import { LoadFailed } from '@/components/load-failed';
import { PageBanner } from '@/components/page-banner';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, type TabItem } from '@/components/ui/tabs';
import { DangerZoneCard, EmailCard, PasswordCard } from './account-cards';
import { AiAssistantCard, AiProvidersCard } from './ai-cards';
import { LanguageCard, PaletteCard, ThemeCard, WeightUnitCard } from './appearance-cards';
import { ProfileCard } from './profile-card';

const TAB_IDS = ['general', 'ai', 'security', 'account'] as const;
type TabId = (typeof TAB_IDS)[number];

export default function SettingsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-40" />}>
      <SettingsContent />
    </Suspense>
  );
}

/** The account's settings, in parts: the address says which is open (`?tab=`), so that a link can lead to it. */
function SettingsContent() {
  const t = useTranslations('settings');
  const qc = useQueryClient();
  const asked = useSearchParams().get('tab') as TabId;
  const active = TAB_IDS.includes(asked) ? asked : 'general';
  const session = useQuery({
    queryKey: ['session'],
    queryFn: () => api.get<SessionUser>('/users/me'),
  });

  if (session.isLoading) {
    return <p className="text-sm text-muted-foreground">{t('subhead')}</p>;
  }
  if (session.isError)
    return <LoadFailed error={session.error} onRetry={() => void session.refetch()} />;
  if (!session.data) return null;
  const me = session.data;
  const saved = () => qc.invalidateQueries({ queryKey: ['session'] });

  const select = (id: TabId): void => {
    const url = new URL(window.location.href);
    if (id === 'general') url.searchParams.delete('tab');
    else url.searchParams.set('tab', id);
    window.history.replaceState(null, '', url);
  };

  const tabs: TabItem<TabId>[] = [
    {
      id: 'general',
      title: t('tabs.general'),
      content: () => (
        <>
          <ProfileCard me={me} onSaved={saved} />
          <LanguageCard />
          <ThemeCard />
          <PaletteCard />
          <WeightUnitCard me={me} onSaved={saved} />
        </>
      ),
    },
    {
      id: 'ai',
      title: t('tabs.ai'),
      content: () => (
        <>
          <AiAssistantCard me={me} />
          <AiProvidersCard />
        </>
      ),
    },
    {
      id: 'security',
      title: t('tabs.security'),
      content: () => (
        <>
          <PasswordCard />
          <SecondFactorCard />
          <SessionsCard />
        </>
      ),
    },
    {
      id: 'account',
      title: t('tabs.account'),
      content: () => (
        <>
          <EmailCard me={me} />
          <DataExportCard />
          <DangerZoneCard me={me} />
        </>
      ),
    },
  ];

  return (
    <div className="space-y-8">
      <PageBanner image={IMAGERY.settings} title={t('title')} subtitle={t('subhead')} />
      <Tabs label={t('tabs.label')} tabs={tabs} active={active} onSelect={select} />
    </div>
  );
}
