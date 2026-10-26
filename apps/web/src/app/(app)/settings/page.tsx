// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { type SessionUser } from '@diet-app/shared';
import { api } from '@/lib/api';
import { SecondFactorCard } from './second-factor-card';
import { DataExportCard } from './data-export-card';
import { SessionsCard } from './sessions-card';
import { LoadFailed } from '@/components/load-failed';
import { DangerZoneCard, EmailCard, PasswordCard } from './account-cards';
import { AiAssistantCard, AiProvidersCard } from './ai-cards';
import { LanguageCard, PaletteCard, ThemeCard, WeightUnitCard } from './appearance-cards';
import { ProfileCard } from './profile-card';

export default function SettingsPage() {
  const t = useTranslations('settings');
  const qc = useQueryClient();
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

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subhead')}</p>
      </header>

      <ProfileCard me={me} onSaved={() => qc.invalidateQueries({ queryKey: ['session'] })} />
      <LanguageCard />
      <ThemeCard initial={me.theme} />
      <PaletteCard initial={me.palette} />
      <WeightUnitCard me={me} onSaved={() => qc.invalidateQueries({ queryKey: ['session'] })} />
      <AiAssistantCard me={me} />
      <AiProvidersCard />
      <PasswordCard />
      <SecondFactorCard />
      <SessionsCard />
      <EmailCard me={me} />
      <DataExportCard />
      <DangerZoneCard me={me} />
    </div>
  );
}
