'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Database, Languages, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import {
  AdminApiError,
  adminApi,
  adminCreds,
  type AdminStats,
  type AdminStatus,
  type DbUpdateState,
  type SourceBreakdown,
  type TranslationStatusEntry,
} from '@/lib/admin-api';

type View = 'loading' | 'disabled' | 'login' | 'ready';

/** Maps a server stage string to its translation key under admin.stages. */
const STAGE_KEY: Record<string, string> = {
  starting: 'starting',
  'prune-recipes': 'pruneRecipes',
  'prune-ingredients': 'pruneIngredients',
  allergens: 'allergens',
  ingredients: 'ingredientsStage',
  recipes: 'recipesStage',
  substitutions: 'substitutionsStage',
  done: 'done',
};

export function AdminPanel() {
  const t = useTranslations('admin');
  const tStages = useTranslations('admin.stages');
  const [view, setView] = useState<View>('loading');
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [translations, setTranslations] = useState<TranslationStatusEntry[] | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [progress, setProgress] = useState<DbUpdateState | null>(null);
  const [lastUpdate, setLastUpdate] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadStats = useCallback(async (): Promise<boolean> => {
    try {
      const [s, tr] = await Promise.all([adminApi.stats(), adminApi.translationsStatus()]);
      setStats(s);
      setTranslations(tr);
      setView('ready');
      return true;
    } catch (err) {
      if (err instanceof AdminApiError && err.status === 401) {
        setView('login');
        return false;
      }
      setUpdateError(err instanceof Error ? err.message : t('loadStatsFailed'));
      setView('login');
      return false;
    }
  }, [t]);

  const stopPolling = useCallback((): void => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const handleProgress = useCallback(
    async (state: DbUpdateState): Promise<void> => {
      setProgress(state);
      if (state.status === 'running') return;
      stopPolling();
      if (state.status === 'done' && state.result) {
        const r = state.result;
        setLastUpdate(
          t('updatedSummary', {
            when: new Date(r.seededAt).toLocaleString(),
            recipes: r.deletedRecipes,
            ingredients: r.deletedIngredients,
            newIngredients: r.counts.ingredients,
            newRecipes: r.counts.recipes,
          }),
        );
        await loadStats();
      } else if (state.status === 'error') {
        setUpdateError(state.error ?? t('updateFailed'));
      }
    },
    [loadStats, stopPolling, t],
  );

  const startPolling = useCallback((): void => {
    stopPolling();
    pollRef.current = setInterval(() => {
      void adminApi.dbUpdateStatus().then(handleProgress).catch((err: unknown) => {
        stopPolling();
        setUpdateError(err instanceof Error ? err.message : t('lostConnection'));
      });
    }, 1000);
  }, [handleProgress, stopPolling, t]);

  useEffect(() => {
    void (async () => {
      const s = await adminApi.status();
      setStatus(s);
      if (!s.enabled) {
        setView('disabled');
        return;
      }
      if (adminCreds.get()) {
        await loadStats();
      } else {
        setView('login');
      }
    })();
  }, [loadStats]);

  // Stale-job recovery: if the API was already running an update when this
  // tab opened (e.g. another browser triggered it), resume the progress
  // display instead of letting the user kick off a second one.
  useEffect(() => {
    if (view !== 'ready') return;
    void adminApi.dbUpdateStatus().then((state) => {
      if (state.status === 'running') {
        setProgress(state);
        startPolling();
      }
    });
    return stopPolling;
  }, [view, startPolling, stopPolling]);

  async function onLogin(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setLoginError(null);
    const form = new FormData(event.currentTarget);
    adminCreds.set(String(form.get('user')), String(form.get('password')));
    const ok = await loadStats();
    if (!ok) setLoginError(t('invalidCreds'));
  }

  async function onUpdate(): Promise<void> {
    setUpdateError(null);
    setLastUpdate(null);
    try {
      const state = await adminApi.startDbUpdate();
      setProgress(state);
      startPolling();
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : t('updateFailed'));
    }
  }

  const updating = progress?.status === 'running';

  function stageLabel(stage: string | null): string {
    if (!stage) return tStages('working');
    const key = STAGE_KEY[stage];
    return key ? tStages(key) : stage;
  }

  if (view === 'loading') {
    return <p className="text-sm text-muted-foreground">{t('loading')}</p>;
  }

  if (view === 'disabled') {
    return (
      <Card className="border-amber-500/40 bg-amber-500/5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5" /> {t('disabled')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm">{status?.message ?? t('disabledHint')}</p>
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
      <Card className="w-full max-w-sm">
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
  const { counts, seed } = stats;
  const generatedFile = seed.files.find((f) => f.name === 'ingredients.generated.json');

  return (
    <div className="space-y-6">
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label={t('ingredients')} value={counts.ingredients} />
        <StatCard label={t('recipes')} value={counts.recipes} />
        <StatCard label={t('substitutions')} value={counts.substitutions} />
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="h-5 w-5" /> {t('curatedDb')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <Row label={t('lastSeeded')}>
              {seed.lastSeededAt ? new Date(seed.lastSeededAt).toLocaleString() : t('never')}
            </Row>
            <Row label={t('onDiskHash')}>
              <code className="text-xs">{seed.currentHash.slice(0, 16)}…</code>
            </Row>
            <Row label={t('storedHash')}>
              {seed.storedHash ? (
                <code className="text-xs">{seed.storedHash.slice(0, 16)}…</code>
              ) : (
                '—'
              )}
            </Row>
            <Row label={t('status')}>
              {seed.updateAvailable ? (
                <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="h-4 w-4" /> {t('updateAvailable')}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="h-4 w-4" /> {t('upToDate')}
                </span>
              )}
            </Row>
          </div>

          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t('seedFiles')}
            </p>
            <ul className="text-sm">
              {seed.files.map((f) => (
                <li
                  key={f.name}
                  className="flex items-center justify-between border-t border-border py-1.5 first:border-t-0"
                >
                  <code className="text-xs">{f.name}</code>
                  <span className="text-xs text-muted-foreground">
                    {f.present ? `${(f.bytes / 1024).toFixed(1)} KB` : t('notPresent')}
                  </span>
                </li>
              ))}
            </ul>
            {generatedFile && !generatedFile.present && (
              <p
                className="mt-2 text-xs text-muted-foreground"
                dangerouslySetInnerHTML={{ __html: t('generatedMissing') }}
              />
            )}
          </div>

          <div className="space-y-2 border-t border-border pt-4">
            <Button onClick={onUpdate} disabled={updating}>
              <RefreshCw className={`h-4 w-4 ${updating ? 'animate-spin' : ''}`} />
              {updating ? t('updating') : t('updateDb')}
            </Button>
            <p
              className="text-xs text-muted-foreground"
              dangerouslySetInnerHTML={{ __html: t('updateExplain') }}
            />
            {updating && progress && <ProgressBar state={progress} stageLabel={stageLabel} />}
            {lastUpdate && <p className="text-xs text-emerald-600 dark:text-emerald-400">{lastUpdate}</p>}
            {updateError && <p className="text-xs text-destructive">{updateError}</p>}
          </div>
        </CardContent>
      </Card>

      <TranslationsCard entries={translations} />
    </div>
  );
}

function TranslationsCard({ entries }: { entries: TranslationStatusEntry[] | null }) {
  const t = useTranslations('admin.translations');
  if (!entries) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Languages className="h-5 w-5" /> {t('title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noNonCanonical')}</p>
        ) : (
          entries.map((entry) => <TranslationsRow key={entry.locale} entry={entry} />)
        )}
      </CardContent>
    </Card>
  );
}

function TranslationsRow({ entry }: { entry: TranslationStatusEntry }) {
  const t = useTranslations('admin.translations');
  const tLocales = useTranslations('locales');
  const localeLabel = (() => {
    try {
      return tLocales(entry.locale);
    } catch {
      return entry.locale;
    }
  })();
  return (
    <section className="space-y-2 border-t border-border pt-3 first:border-t-0 first:pt-0">
      <h3 className="text-sm font-semibold">
        {localeLabel}{' '}
        <span className="text-xs font-normal uppercase text-muted-foreground">{entry.locale}</span>
      </h3>
      <SourceLine
        partition={t('curated')}
        kind={t('ingredients')}
        breakdown={entry.curated.ingredients}
        missing={entry.missingSamples.curatedIngredients}
      />
      <SourceLine
        partition={t('curated')}
        kind={t('recipes')}
        breakdown={entry.curated.recipes}
        missing={entry.missingSamples.curatedRecipes}
      />
      <SourceLine
        partition={t('imported')}
        kind={t('ingredients')}
        breakdown={entry.imported.ingredients}
        missing={entry.missingSamples.importedIngredients}
      />
    </section>
  );
}

function SourceLine({
  partition,
  kind,
  breakdown,
  missing,
}: {
  partition: string;
  kind: string;
  breakdown: SourceBreakdown;
  missing: string[];
}) {
  const t = useTranslations('admin.translations');
  const [showMissing, setShowMissing] = useState(false);
  const [copied, setCopied] = useState(false);
  const total =
    breakdown.curated_json + breakdown.ai + breakdown.manual + breakdown.missing;
  if (total === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      <span className="w-20 text-muted-foreground">{partition}</span>
      <span className="w-24 font-medium">{kind}</span>
      <span className="tabular-nums">
        {breakdown.curated_json} {t('sourceCuratedJson')}
      </span>
      {breakdown.ai > 0 && (
        <span className="tabular-nums">
          · {breakdown.ai} {t('sourceAi')}
        </span>
      )}
      {breakdown.manual > 0 && (
        <span className="tabular-nums">
          · {breakdown.manual} {t('sourceManual')}
        </span>
      )}
      {breakdown.missing > 0 && (
        <>
          <span className="tabular-nums text-amber-600 dark:text-amber-400">
            · {breakdown.missing} {t('missing')}
          </span>
          {missing.length > 0 && (
            <>
              <button
                type="button"
                className="text-xs text-muted-foreground hover:underline"
                onClick={() => setShowMissing((v) => !v)}
              >
                {showMissing
                  ? t('hideMissing')
                  : t('showMissing', { count: breakdown.missing })}
              </button>
              <button
                type="button"
                className="text-xs text-primary hover:underline"
                onClick={async () => {
                  await navigator.clipboard.writeText(missing.join('\n'));
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? t('copied') : t('copyMissing')}
              </button>
            </>
          )}
        </>
      )}
      {showMissing && missing.length > 0 && (
        <ul className="mt-1 w-full pl-24">
          {missing.map((slug) => (
            <li key={slug} className="font-mono text-[11px] text-muted-foreground">
              {slug}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="pt-5">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="mt-1 text-3xl font-semibold tabular-nums">{value.toLocaleString()}</p>
      </CardContent>
    </Card>
  );
}

function ProgressBar({
  state,
  stageLabel,
}: {
  state: DbUpdateState;
  stageLabel: (stage: string | null) => string;
}) {
  const hasTotal = state.total != null && state.total > 0;
  const pct = hasTotal ? Math.min(100, Math.round(((state.current ?? 0) / state.total!) * 100)) : null;
  const label = stageLabel(state.stage);
  return (
    <div className="mt-2 space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span>{label}</span>
        {hasTotal && (
          <span className="tabular-nums text-muted-foreground">
            {state.current?.toLocaleString()} / {state.total?.toLocaleString()} ({pct}%)
          </span>
        )}
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        {hasTotal ? (
          <div
            className="h-full bg-primary transition-[width] duration-500"
            style={{ width: `${pct ?? 0}%` }}
          />
        ) : (
          <div className="h-full w-1/3 animate-pulse rounded-full bg-primary/60" />
        )}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5">{children}</p>
    </div>
  );
}
