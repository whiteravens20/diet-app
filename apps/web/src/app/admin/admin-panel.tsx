// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { Tabs, type TabItem } from '@/components/ui/tabs';
import { ApiClientError } from '@/lib/http';
import { useErrorText } from '@/lib/use-error-text';
import { AccountSecondFactorCard } from './account-second-factor-card';
import { AdminSecondFactorCard } from './admin-second-factor-card';
import { CatalogueDbCard } from './catalogue-db-card';
import { ConnectionCard } from './connection-card';
import { CoverageCard } from './coverage-card';
import { CurationCard } from './curation-card';
import type { Kind } from './curation/shared';
import { InstanceFilesCard, mirrorNeedsAttention } from './instance-files-card';
import { OperatorAiCard } from './operator-ai-card';
import { OverviewTab } from './overview-tab';
import { RetiredIngredientsCard } from './retired-ingredients-card';
import { ReviewerConfigCard } from './reviewer-config-card';
import { UsdaImportCard } from './usda-import-card';
import { adminApi, type AdminHealth, type AdminOverview, type AdminStats } from '@/lib/admin-api';

type View = 'loading' | 'disabled' | 'unreachable' | 'login' | 'ready';

export function AdminPanel() {
  const t = useTranslations('admin');
  const errorText = useErrorText();
  const [view, setView] = useState<View>('loading');
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  // Whether signing in takes a code from an authenticator app as well.
  const [needsCode, setNeedsCode] = useState(false);
  const [unreachableDetail, setUnreachableDetail] = useState<string | null>(null);

  /** Load the first numbers. Resolves to null when that worked, else to what went wrong. */
  const loadStats = useCallback(async (): Promise<unknown> => {
    try {
      const s = await adminApi.stats();
      setStats(s);
      setView('ready');
      return null;
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 401) {
        setView('login');
        return err;
      }
      setLoginError(errorText(err, t('loadStatsFailed')));
      setView('login');
      return err;
    }
  }, [t, errorText]);

  // Probe `/admin/status`, then either show the disabled banner, the login
  // form, or fetch stats. Wrapped in try/catch so a proxy / network error
  // surfaces an actionable card instead of leaving the user on "Loading…".
  const probe = useCallback(async (): Promise<void> => {
    try {
      const s = await adminApi.status();
      if (!s.enabled) {
        setView('disabled');
        return;
      }
      // Whether this browser holds an administrator's session, as far as the API says.
      const session = await adminApi.session();
      setNeedsCode(session.secondFactor);
      if (session.signedIn) {
        await loadStats();
      } else {
        setView('login');
      }
    } catch (err) {
      setUnreachableDetail(errorText(err));
      setView('unreachable');
    }
  }, [loadStats, errorText]);

  useEffect(() => {
    void (async () => {
      await probe();
    })();
  }, [probe]);

  const onRetry = (): void => {
    setView('loading');
    setUnreachableDetail(null);
    void probe();
  };

  async function onLogin(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setLoginError(null);
    const form = new FormData(event.currentTarget);
    // The values are given once, for a session; the page keeps none of them.
    const code = form.get('code');
    const failure = await adminApi
      .signIn(
        String(form.get('user')),
        String(form.get('password')),
        code ? String(code) : undefined,
      )
      .then(loadStats, (err: unknown) => err);
    if (failure === null) return;
    if (failure instanceof ApiClientError && failure.status === 401) {
      // A second factor that was set up since this page was loaded: the form then shows its field.
      const takesCode = await adminApi.session().then(
        (session) => session.secondFactor,
        () => needsCode,
      );
      setNeedsCode(takesCode);
      setLoginError(t(takesCode ? 'invalidCredsOrCode' : 'invalidCreds'));
    } else {
      // Held up after wrong passwords or wrong codes, this says for how long.
      setLoginError(errorText(failure, t('loadStatsFailed')));
    }
  }

  /** End the session, here or everywhere, and show the sign-in form: what the panel had loaded is not shown any more. */
  async function leave(end: () => Promise<void>): Promise<void> {
    await end().catch(() => undefined);
    setStats(null);
    setView('login');
    // What signing in takes now, for the form.
    await adminApi.session().then(
      (session) => setNeedsCode(session.secondFactor),
      () => undefined,
    );
  }

  if (view === 'loading') {
    return <p className="text-sm text-muted-foreground">{t('loading')}</p>;
  }

  if (view === 'unreachable') {
    return (
      <Card className="border-destructive/40 bg-destructive/5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TriangleAlert className="h-5 w-5" /> {t('unreachable')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm">{t('unreachableHint')}</p>
          {unreachableDetail ? (
            <pre className="overflow-x-auto rounded bg-muted p-3 text-xs">{unreachableDetail}</pre>
          ) : null}
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RefreshCw className="mr-2 h-4 w-4" /> {t('retry')}
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (view === 'disabled') {
    return (
      <Card className="border-warning/40 bg-warning/5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TriangleAlert className="h-5 w-5" /> {t('disabled')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm">{t('disabledHint')}</p>
          <pre className="mt-3 overflow-x-auto rounded bg-muted p-3 text-xs">
            ADMIN_USER=admin{'\n'}ADMIN_PASSWORD=&lt;strong-password&gt;
          </pre>
          <p className="mt-3 text-xs text-muted-foreground">{t('restartHint')}</p>
        </CardContent>
      </Card>
    );
  }

  if (view === 'login') {
    return (
      <Card className="mx-auto max-w-md">
        <CardHeader>
          <CardTitle>{t('signIn')}</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={onLogin}>
            <Field label={t('adminUser')}>
              <Input name="user" required autoComplete="username" defaultValue="admin" />
            </Field>
            <Field label={t('adminPassword')}>
              <Input name="password" type="password" required autoComplete="current-password" />
            </Field>
            {needsCode && (
              <Field label={t('code')}>
                <Input
                  name="code"
                  required
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={12}
                />
              </Field>
            )}
            {loginError && <p className="text-sm text-destructive">{loginError}</p>}
            <Button type="submit" className="w-full">
              {t('signIn')}
            </Button>
            <p className="text-center text-xs text-muted-foreground">{t('credsHint')}</p>
          </form>
        </CardContent>
      </Card>
    );
  }

  // view === 'ready'
  if (!stats) return null;
  return (
    <ReadyPanel
      stats={stats}
      onReload={loadStats}
      needsCode={needsCode}
      onSecondFactor={setNeedsCode}
      onLeave={(end) => void leave(end)}
    />
  );
}

const TAB_IDS = ['overview', 'queue', 'catalogue', 'access', 'security'] as const;
type TabId = (typeof TAB_IDS)[number];

/** The part of the panel the address names, and the kind of drafts: the first of each when it names none. */
function fromAddress(): { tab: TabId; kind: Kind } {
  const params = new URLSearchParams(window.location.search);
  const tab = params.get('tab') as TabId;
  return {
    tab: TAB_IDS.includes(tab) ? tab : 'overview',
    kind: params.get('kind') === 'recipes' ? 'recipes' : 'ingredient-names',
  };
}

function toAddress(tab: TabId, kind: Kind): void {
  const url = new URL(window.location.href);
  url.searchParams.delete('tab');
  url.searchParams.delete('kind');
  if (tab !== 'overview') url.searchParams.set('tab', tab);
  if (tab === 'queue' && kind === 'recipes') url.searchParams.set('kind', kind);
  window.history.replaceState(null, '', url);
}

/**
 * The panel of a signed-in administrator, in parts. It is rendered once the
 * panel has asked for its session and never on the server, so it reads the
 * address at once.
 */
function ReadyPanel({
  stats,
  onReload,
  needsCode,
  onSecondFactor,
  onLeave,
}: {
  stats: AdminStats;
  onReload: () => Promise<unknown>;
  needsCode: boolean;
  onSecondFactor: (on: boolean) => void;
  onLeave: (end: () => Promise<void>) => void;
}) {
  const t = useTranslations('admin');
  const [{ tab, kind }, setPlace] = useState(fromAddress);
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [retired, setRetired] = useState(0);
  const [health, setHealth] = useState<AdminHealth | null>(null);
  const [healthFailed, setHealthFailed] = useState(false);

  const go = (next: { tab: TabId; kind?: Kind }): void => {
    const place = { tab: next.tab, kind: next.kind ?? kind };
    setPlace(place);
    toAddress(place.tab, place.kind);
  };

  // What the tabs and the overview count. Should it fail, a part that is opened says so itself.
  const loadOverview = useCallback(async (): Promise<void> => {
    await adminApi.overview().then(setOverview, () => undefined);
    await adminApi.retiredIngredients().then(
      (ingredients) => setRetired(ingredients.length),
      () => undefined,
    );
  }, []);

  useEffect(() => {
    void (async () => {
      await loadOverview();
    })();
  }, [loadOverview]);

  const loadHealth = useCallback(async (): Promise<void> => {
    await adminApi.health().then(
      (read) => {
        setHealth(read);
        setHealthFailed(false);
      },
      () => setHealthFailed(true),
    );
  }, []);

  // Read each time the overview is opened: it says how the instance stands now.
  useEffect(() => {
    if (tab !== 'overview') return;
    void (async () => {
      await loadHealth();
    })();
  }, [tab, loadHealth]);

  const reload = useCallback(async (): Promise<void> => {
    await onReload();
    await loadOverview();
  }, [onReload, loadOverview]);

  const waiting = overview
    ? overview.names.pending +
      overview.names.rejected +
      overview.names.approved +
      overview.recipes.pending +
      overview.recipes.approved
    : 0;
  const catalogueAttention =
    stats.seed.updateAvailable || retired > 0 || mirrorNeedsAttention(overview?.mirror);

  const tabs: TabItem<TabId>[] = [
    {
      id: 'overview',
      title: t('tabs.overview'),
      content: () => (
        <OverviewTab
          stats={stats}
          overview={overview}
          retired={retired}
          health={health}
          healthFailed={healthFailed}
          onRefresh={() => {
            void loadHealth();
            void loadOverview();
          }}
          onGo={go}
        />
      ),
    },
    {
      id: 'queue',
      title: t('tabs.queue'),
      mark:
        waiting > 0
          ? { shown: String(waiting), said: t('tabs.waiting', { count: waiting }) }
          : undefined,
      content: () => (
        <CurationCard
          kind={kind}
          onKindChange={(next) => go({ tab: 'queue', kind: next })}
          overview={overview}
          onQueueChanged={loadOverview}
        />
      ),
    },
    {
      id: 'catalogue',
      title: t('tabs.catalogue'),
      mark: catalogueAttention ? { shown: '!', said: t('tabs.attention') } : undefined,
      content: () => (
        <>
          <CatalogueDbCard seed={stats.seed} onUpdated={reload} />
          <InstanceFilesCard
            mirror={overview?.mirror ?? null}
            readAgain={overview}
            onRestored={reload}
          />
          <UsdaImportCard onFinished={onReload} />
          <RetiredIngredientsCard onChanged={loadOverview} />
          <CoverageCard
            coverage={stats.coverage}
            waiting={stats.coverageWaiting}
            target={stats.coverageTarget}
            macros={stats.macros}
          />
        </>
      ),
    },
    {
      id: 'access',
      title: t('tabs.access'),
      content: () => (
        <>
          <ReviewerConfigCard />
          <OperatorAiCard />
          <AccountSecondFactorCard />
        </>
      ),
    },
    {
      id: 'security',
      title: t('tabs.security'),
      content: () => (
        <>
          <AdminSecondFactorCard on={needsCode} onChanged={onSecondFactor} />
          <Card>
            <CardHeader>
              <CardTitle>{t('sessionsTitle')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">{t('endAllSessionsHint')}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onLeave(adminApi.endAllSessions)}
              >
                {t('endAllSessions')}
              </Button>
            </CardContent>
          </Card>
          <ConnectionCard />
        </>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button type="button" variant="outline" size="sm" onClick={() => onLeave(adminApi.signOut)}>
          {t('signOut')}
        </Button>
      </div>
      <Tabs label={t('tabs.label')} tabs={tabs} active={tab} onSelect={(id) => go({ tab: id })} />
    </div>
  );
}
