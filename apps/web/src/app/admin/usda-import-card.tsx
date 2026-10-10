// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { Download } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { adminApi, type UsdaImportRunnerState } from '@/lib/admin-api';

/**
 * Fetching foods from USDA FoodData Central into the instance's data
 * directory: start a run, follow it, and read what it kept, what it left out
 * and, when it failed, what to do about it.
 */
export function UsdaImportCard({ onFinished }: { onFinished: () => Promise<unknown> }) {
  const t = useTranslations('admin.usda');
  const [run, setRun] = useState<UsdaImportRunnerState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dataTypes, setDataTypes] = useState<string>('Foundation');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    void adminApi
      .usdaImportStatus()
      .then((s) => {
        setRun(s);
        if (s.dataTypes) setDataTypes(s.dataTypes);
        if (s.status === 'running') startPolling();
      })
      .catch(() => undefined);
    return () => stopPolling();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run-once on mount; the polling helpers are stable and re-running would restart polling
  }, []);

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }
  function startPolling() {
    stopPolling();
    pollRef.current = setInterval(() => {
      void adminApi
        .usdaImportStatus()
        .then((s) => {
          setRun(s);
          if (s.status !== 'running') {
            stopPolling();
            if (s.status === 'done') void onFinished();
          }
        })
        .catch(() => stopPolling());
    }, 1500);
  }

  async function start() {
    setError(null);
    try {
      const s = await adminApi.startUsdaImport(dataTypes);
      setRun(s);
      startPolling();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  /** A failed run in words that say what to do; the source's own wording follows as detail. */
  function failureText(failed: UsdaImportRunnerState): string {
    switch (failed.errorReason) {
      case 'over_limit':
        return failed.retryAfterSeconds
          ? t('overLimitWait', { minutes: Math.ceil(failed.retryAfterSeconds / 60) })
          : t('overLimit');
      case 'key_refused':
        return t('keyRefused');
      case 'unavailable':
        return t('unavailable');
      case 'not_writable':
        return t('notWritable');
      default:
        return t('failed', { error: failed.error ?? '' });
    }
  }

  const running = run?.status === 'running';
  const progressPct =
    running && run?.page && run?.totalPages
      ? Math.round((run.page / run.totalPages) * 100)
      : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Download className="h-5 w-5" /> {t('title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">{t('explain')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={dataTypes}
            onChange={(e) => setDataTypes(e.target.value)}
            disabled={running}
            className="rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          >
            <option value="Foundation">{t('foundationOnly')}</option>
            <option value="Foundation,SR Legacy">{t('foundationPlusSr')}</option>
          </select>
          <Button type="button" size="sm" onClick={start} disabled={running}>
            <Download className={`h-4 w-4 ${running ? 'animate-pulse' : ''}`} />
            {running ? t('running') : t('runImport')}
          </Button>
        </div>

        {run?.demoKey && (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs">
            {t('demoKeyHint')}
          </p>
        )}

        {running && (
          <div className="space-y-1">
            <div className="h-2 w-full overflow-hidden rounded bg-muted">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${progressPct ?? 5}%` }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {t('progress', {
                page: run.page ?? 0,
                total: run.totalPages ?? '?',
                kept: run.kept,
              })}
            </p>
          </div>
        )}

        {run?.status === 'done' && run.result && (
          <>
            <p className="text-xs text-emerald-600 dark:text-emerald-400">
              {t('doneSummary', {
                kept: run.result.kept,
                skipped: run.result.skipped,
                excluded: run.result.excluded,
              })}
            </p>
            {run.result.refused > 0 && (
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">{t('refusedSummary', { count: run.result.refused })}</summary>
                <ul className="mt-1 max-h-48 space-y-0.5 overflow-y-auto">
                  {/* The source lists some foods more than once: a name is no key. */}
                  {run.result.refusals.map((refusal, index) => (
                    <li key={index}>
                      {refusal.name}: {refusal.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}

        {run?.status === 'error' && (
          <div className="text-xs">
            <p className="text-destructive">{failureText(run)}</p>
            {run.errorReason && run.errorReason !== 'failed' && run.error && (
              <p className="mt-0.5 text-muted-foreground">{run.error}</p>
            )}
          </div>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
