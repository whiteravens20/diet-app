'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Database, RefreshCw } from 'lucide-react';
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
} from '@/lib/admin-api';

type View = 'loading' | 'disabled' | 'login' | 'ready';

const STAGE_LABELS: Record<string, string> = {
  starting: 'Starting…',
  'prune-recipes': 'Removing stale recipes…',
  'prune-ingredients': 'Removing unused ingredients…',
  allergens: 'Seeding allergens…',
  ingredients: 'Seeding ingredients',
  recipes: 'Seeding recipes',
  substitutions: 'Seeding substitution rules…',
  done: 'Done.',
};

function stageLabel(stage: string | null): string {
  if (!stage) return 'Working…';
  return STAGE_LABELS[stage] ?? stage;
}

export function AdminPanel() {
  const [view, setView] = useState<View>('loading');
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [progress, setProgress] = useState<DbUpdateState | null>(null);
  const [lastUpdate, setLastUpdate] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadStats = useCallback(async (): Promise<boolean> => {
    try {
      const s = await adminApi.stats();
      setStats(s);
      setView('ready');
      return true;
    } catch (err) {
      if (err instanceof AdminApiError && err.status === 401) {
        setView('login');
        return false;
      }
      setUpdateError(err instanceof Error ? err.message : 'Failed to load stats.');
      setView('login');
      return false;
    }
  }, []);

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
          `Updated ${new Date(r.seededAt).toLocaleString()} · ` +
            `removed ${r.deletedRecipes} stale recipes + ${r.deletedIngredients} unused ingredients · ` +
            `now ${r.counts.ingredients} ingredients / ${r.counts.recipes} recipes.`,
        );
        await loadStats();
      } else if (state.status === 'error') {
        setUpdateError(state.error ?? 'Update failed.');
      }
    },
    [loadStats, stopPolling],
  );

  const startPolling = useCallback((): void => {
    stopPolling();
    pollRef.current = setInterval(() => {
      void adminApi.dbUpdateStatus().then(handleProgress).catch((err: unknown) => {
        stopPolling();
        setUpdateError(err instanceof Error ? err.message : 'Lost connection to API.');
      });
    }, 1000);
  }, [handleProgress, stopPolling]);

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
    if (!ok) setLoginError('Invalid credentials. Try again.');
  }

  async function onUpdate(): Promise<void> {
    setUpdateError(null);
    setLastUpdate(null);
    try {
      const state = await adminApi.startDbUpdate();
      setProgress(state);
      startPolling();
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : 'Update failed.');
    }
  }

  const updating = progress?.status === 'running';

  if (view === 'loading') {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  if (view === 'disabled') {
    return (
      <Card className="border-amber-500/40 bg-amber-500/5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5" /> Admin panel disabled
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm">
            {status?.message ?? 'Set ADMIN_PASSWORD in .env to enable.'}
          </p>
          <pre className="mt-3 overflow-x-auto rounded bg-muted p-3 text-xs">
            ADMIN_USER=admin{'\n'}ADMIN_PASSWORD=&lt;strong-password&gt;
          </pre>
          <p className="mt-3 text-xs text-muted-foreground">
            Restart the API container after editing .env so the new value is picked up.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (view === 'login') {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={onLogin}>
            <Field label="Admin user">
              <Input name="user" required autoComplete="username" defaultValue="admin" />
            </Field>
            <Field label="Admin password">
              <Input name="password" type="password" required autoComplete="current-password" />
            </Field>
            {loginError && <p className="text-sm text-destructive">{loginError}</p>}
            <Button type="submit" className="w-full">
              Sign in
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              Credentials live in this tab&apos;s sessionStorage only.
            </p>
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
        <StatCard label="Ingredients" value={counts.ingredients} />
        <StatCard label="Recipes" value={counts.recipes} />
        <StatCard label="Substitutions" value={counts.substitutions} />
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="h-5 w-5" /> Curated database
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            <Row label="Last seeded">
              {seed.lastSeededAt
                ? new Date(seed.lastSeededAt).toLocaleString()
                : 'Never — click Update to seed.'}
            </Row>
            <Row label="On-disk hash">
              <code className="text-xs">{seed.currentHash.slice(0, 16)}…</code>
            </Row>
            <Row label="Stored hash">
              {seed.storedHash ? (
                <code className="text-xs">{seed.storedHash.slice(0, 16)}…</code>
              ) : (
                '—'
              )}
            </Row>
            <Row label="Status">
              {seed.updateAvailable ? (
                <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="h-4 w-4" /> Update available
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="h-4 w-4" /> Up to date
                </span>
              )}
            </Row>
          </div>

          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Seed files (data/)
            </p>
            <ul className="text-sm">
              {seed.files.map((f) => (
                <li
                  key={f.name}
                  className="flex items-center justify-between border-t border-border py-1.5 first:border-t-0"
                >
                  <code className="text-xs">{f.name}</code>
                  <span className="text-xs text-muted-foreground">
                    {f.present ? `${(f.bytes / 1024).toFixed(1)} KB` : 'not present'}
                  </span>
                </li>
              ))}
            </ul>
            {generatedFile && !generatedFile.present && (
              <p className="mt-2 text-xs text-muted-foreground">
                <code>ingredients.generated.json</code> is missing — only the hand-curated
                baseline will be seeded. Run{' '}
                <code className="rounded bg-muted px-1">npm run import:usda</code> with an
                FDC_API_KEY first to add USDA whole foods.
              </p>
            )}
          </div>

          <div className="space-y-2 border-t border-border pt-4">
            <Button onClick={onUpdate} disabled={updating}>
              <RefreshCw className={`h-4 w-4 ${updating ? 'animate-spin' : ''}`} />
              {updating ? 'Updating…' : 'Update database'}
            </Button>
            <p className="text-xs text-muted-foreground">
              Wipes seed-origin recipes not referenced by any plan/favorite and any
              ingredient no recipe uses, then re-seeds from <code>data/*.json</code>.
              User profiles, plans, favorites and inventory are preserved.
            </p>
            {updating && progress && <ProgressBar state={progress} />}
            {lastUpdate && <p className="text-xs text-emerald-600 dark:text-emerald-400">{lastUpdate}</p>}
            {updateError && <p className="text-xs text-destructive">{updateError}</p>}
          </div>
        </CardContent>
      </Card>
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

function ProgressBar({ state }: { state: DbUpdateState }) {
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
