// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CircleCheck, Database, RefreshCw, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { adminApi, type AdminStats, type DbUpdateState } from '@/lib/admin-api';
import { useErrorText } from '@/lib/use-error-text';
import { useFormat } from '@/lib/use-format';
import { Explain } from './explain';

/** Maps a server stage string to its translation key under admin.stages. */
const STAGE_KEY: Record<string, string> = {
  starting: 'starting',
  ingredients: 'ingredientsStage',
  recipes: 'recipesStage',
  substitutions: 'substitutionsStage',
  retire: 'retire',
  recompute: 'recompute',
  done: 'done',
};

/** The catalogue's data as the database holds it and as the files are now, and the update that loads them. */
export function CatalogueDbCard({
  seed,
  onUpdated,
}: {
  seed: AdminStats['seed'];
  onUpdated: () => Promise<unknown>;
}) {
  const t = useTranslations('admin');
  const tStages = useTranslations('admin.stages');
  const errorText = useErrorText();
  const fmt = useFormat();
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [progress, setProgress] = useState<DbUpdateState | null>(null);
  const [lastUpdate, setLastUpdate] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
            when: fmt.moment(r.seededAt),
            recipes: r.deletedRecipes,
            ingredients: r.deletedIngredients,
            retiredRecipes: r.retiredRecipes,
            retiredIngredients: r.retiredIngredients,
            moved: r.movedToSuccessors,
            newIngredients: r.counts.ingredients,
            newRecipes: r.counts.recipes,
          }),
        );
        await onUpdated();
      } else if (state.status === 'error') {
        setUpdateError(state.error ?? t('updateFailed'));
      }
    },
    [onUpdated, stopPolling, t, fmt],
  );

  const startPolling = useCallback((): void => {
    stopPolling();
    pollRef.current = setInterval(() => {
      void adminApi
        .dbUpdateStatus()
        .then(handleProgress)
        .catch((err: unknown) => {
          stopPolling();
          setUpdateError(errorText(err, t('lostConnection')));
        });
    }, 1000);
  }, [handleProgress, stopPolling, t, errorText]);

  // Stale-job recovery: if the API was already running an update when this
  // part opened (e.g. another browser triggered it), resume the progress
  // display instead of letting the user kick off a second one.
  useEffect(() => {
    void adminApi.dbUpdateStatus().then(
      (state) => {
        if (state.status === 'running') {
          setProgress(state);
          startPolling();
        }
      },
      // No answer says nothing of a running update, and pressing the button will.
      () => undefined,
    );
    return stopPolling;
  }, [startPolling, stopPolling]);

  async function onUpdate(): Promise<void> {
    setUpdateError(null);
    setLastUpdate(null);
    try {
      const state = await adminApi.startDbUpdate();
      setProgress(state);
      startPolling();
    } catch (err) {
      setUpdateError(errorText(err, t('updateFailed')));
    }
  }

  const updating = progress?.status === 'running';

  function stageLabel(stage: string | null): string {
    if (!stage) return tStages('working');
    const key = STAGE_KEY[stage];
    return key ? tStages(key) : stage;
  }

  const generatedFile = seed.files.find((f) => f.name === 'ingredients.generated.json');

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Database className="h-5 w-5" /> {t('curatedDb')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <Row label={t('lastSeeded')}>
            {seed.lastSeededAt ? fmt.moment(seed.lastSeededAt) : t('never')}
          </Row>
          <Row label={t('status')}>
            {seed.updateAvailable ? (
              <span className="inline-flex items-center gap-1 text-warning">
                <TriangleAlert className="h-4 w-4" /> {t('updateAvailable')}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-success">
                <CircleCheck className="h-4 w-4" /> {t('upToDate')}
              </span>
            )}
          </Row>
        </div>

        {generatedFile && !generatedFile.present && (
          <p className="text-xs text-muted-foreground">
            {t.rich('generatedMissing', { code: (chunks) => <code>{chunks}</code> })}
          </p>
        )}

        <details className="text-sm">
          <summary className="min-h-6 w-fit cursor-pointer text-xs leading-6 text-muted-foreground underline-offset-2 hover:underline">
            {t('seedDetails')}
          </summary>
          <div className="mt-2 space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
            </div>
            <div>
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t('seedFiles')}
              </p>
              <ul>
                {seed.files.map((f) => (
                  <li
                    key={f.name}
                    className="flex items-center justify-between gap-3 border-t border-border py-1.5 first:border-t-0"
                  >
                    <code className="min-w-0 break-all text-xs">{f.name}</code>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {f.present ? fmt.unit(f.bytes / 1024, 'kilobyte', 1) : t('notPresent')}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </details>

        <div className="space-y-2 border-t border-border pt-4">
          <Button onClick={onUpdate} disabled={updating}>
            <RefreshCw className={`h-4 w-4 ${updating ? 'animate-spin' : ''}`} />
            {updating ? t('updating') : t('updateDb')}
          </Button>
          <Explain>
            <p>{t.rich('updateExplain', { code: (chunks) => <code>{chunks}</code> })}</p>
          </Explain>
          {updating && progress && <ProgressBar state={progress} stageLabel={stageLabel} />}
          {lastUpdate && <p className="text-xs text-success">{lastUpdate}</p>}
          {updateError && <p className="text-xs text-destructive">{updateError}</p>}
        </div>
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
  const fmt = useFormat();
  const hasTotal = state.total != null && state.total > 0;
  const pct = hasTotal
    ? Math.min(100, Math.round(((state.current ?? 0) / state.total!) * 100))
    : null;
  const label = stageLabel(state.stage);
  return (
    <div className="mt-2 space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span>{label}</span>
        {hasTotal && (
          <span className="tabular-nums text-muted-foreground">
            {fmt.number(state.current ?? 0)} / {fmt.number(state.total ?? 0)} (
            {fmt.percent((pct ?? 0) / 100)})
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
