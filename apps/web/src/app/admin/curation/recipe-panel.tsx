// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

/** The drafts of recipes: the run that writes them, taking recipes in from elsewhere, filling a language, and the list. */
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { LoaderCircle, Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  adminApi,
  type PagedDrafts,
  type RecipeDraft,
  type RecipeRunnerState,
} from '@/lib/admin-api';
import { useDraftErrorText } from '@/lib/use-draft-error';
import { MissingLanguage } from '../missing-language';
import { RecipeImport } from '../recipe-import';
import { FilterStrip, Pagination } from './list-controls';
import { RecipeDraftRow } from './recipe-draft-row';
import { PAGE_SIZE, POLL_INTERVAL_MS, type StatusFilter } from './shared';
import { ShipBar } from './ship-bar';

/** Where the drafts of the list came from: all of them, those users sent, or those a batch run wrote. */
export type SourceFilter = 'ALL' | 'AI_USER' | 'AI';

const SOURCE_FILTERS: readonly SourceFilter[] = ['ALL', 'AI_USER', 'AI'];

export function RecipePanel() {
  const t = useTranslations('admin.curation');
  const countId = useId();
  const scopeId = useId();
  const tDiet = useTranslations('enums.dietType');
  const tMeal = useTranslations('enums.mealType');
  const errorText = useDraftErrorText();
  const [runner, setRunner] = useState<RecipeRunnerState | null>(null);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('PENDING');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('ALL');
  const [rejected, setRejected] = useState<{ rejected: number; skipped: number } | null>(null);
  const [data, setData] = useState<PagedDrafts<RecipeDraft> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [genCount, setGenCount] = useState(5);
  const [scope, setScope] = useState<'curated' | 'all'>('curated');
  const [fillCoverage, setFillCoverage] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadDrafts = useCallback(async () => {
    try {
      const res = await adminApi.listRecipeDrafts({
        status: statusFilter === 'ALL' ? undefined : statusFilter,
        source: sourceFilter === 'ALL' ? undefined : sourceFilter,
        page,
        pageSize: PAGE_SIZE,
      });
      setData(res);
      setError(null);
    } catch (err) {
      setError(errorText(err, String(err)));
    }
  }, [page, statusFilter, sourceFilter, errorText]);

  const loadRunner = useCallback(async () => {
    try {
      const state = await adminApi.recipeGeneratorStatus();
      setRunner(state);
      return state;
    } catch (err) {
      setError(errorText(err, String(err)));
      return null;
    }
  }, [errorText]);

  useEffect(() => {
    void (async () => {
      await loadRunner();
    })();
  }, [loadRunner]);
  useEffect(() => {
    void (async () => {
      await loadDrafts();
    })();
  }, [loadDrafts]);

  const startPolling = useCallback(() => {
    if (pollRef.current) return;
    pollRef.current = setInterval(async () => {
      const state = await loadRunner();
      if (state && state.status !== 'running') {
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
        void loadDrafts();
      }
    }, POLL_INTERVAL_MS);
  }, [loadDrafts, loadRunner]);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const onGenerate = async () => {
    try {
      const state = await adminApi.startRecipeGenerator({
        count: genCount,
        catalogueScope: scope,
        ...(fillCoverage ? { fillCoverage: true } : {}),
      });
      setRunner(state);
      if (state.status === 'running') startPolling();
      void loadDrafts();
    } catch (err) {
      setError(errorText(err, String(err)));
    }
  };

  /** The drafts on this page that can still be rejected. */
  const open = (data?.items ?? []).filter(
    (draft) => draft.status === 'PENDING' || draft.status === 'APPROVED',
  );
  // What users sent and nobody will ship, rejected in one go with one reason.
  const onRejectShown = async () => {
    const label = window.prompt(t('reviewLabelPrompt'));
    if (!label) return;
    const reason = window.prompt(t('rejectReasonPrompt')) ?? undefined;
    try {
      const res = await adminApi.rejectRecipeDrafts(
        open.map((draft) => draft.id),
        label,
        reason,
      );
      setRejected({ rejected: res.rejected.length, skipped: res.skipped.length });
      await loadDrafts();
    } catch (err) {
      setError(errorText(err, String(err)));
    }
  };

  const onStop = async () => {
    try {
      const state = await adminApi.stopRecipeGenerator();
      setRunner(state);
    } catch (err) {
      setError(errorText(err, String(err)));
    }
  };

  const running = runner?.status === 'running';
  const configured = runner?.configured ?? false;

  return (
    <>
      {!configured && (
        <p className="rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs">
          {t('notConfigured')}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={countId} className="text-xs text-muted-foreground">
          {t('recipeCount')}
        </label>
        <Input
          id={countId}
          type="number"
          min={1}
          max={25}
          value={genCount}
          onChange={(e) => setGenCount(Math.max(1, Math.min(25, Number(e.target.value) || 1)))}
          className="w-20"
          disabled={running}
        />
        <label htmlFor={scopeId} className="text-xs text-muted-foreground">
          {t('scopeLabel')}
        </label>
        <select
          id={scopeId}
          value={scope}
          onChange={(e) => setScope(e.target.value as 'curated' | 'all')}
          disabled={running}
          className="rounded-md border border-input bg-background px-2 py-1 text-xs"
        >
          <option value="curated">{t('scopeCurated')}</option>
          <option value="all">{t('scopeAll')}</option>
        </select>
        <label className="flex items-center gap-1.5 text-xs" title={t('fillCoverageHint')}>
          <input
            type="checkbox"
            checked={fillCoverage}
            onChange={(e) => setFillCoverage(e.target.checked)}
            disabled={running}
          />
          {t('fillCoverage')}
        </label>
        <Button onClick={onGenerate} disabled={!configured || running} className="gap-2">
          {running ? (
            <LoaderCircle className="h-4 w-4 animate-spin" />
          ) : (
            <Sparkles className="h-4 w-4" />
          )}
          {running
            ? t('runningRecipes', { processed: runner?.processed ?? 0, total: runner?.total ?? 0 })
            : t('generateRecipes')}
        </Button>
        {running && (
          <Button onClick={onStop} variant="outline" className="gap-2">
            <X className="h-4 w-4" />
            {t('stop')}
          </Button>
        )}
        {!running && runner && (runner.processed > 0 || runner.failed > 0) && (
          <span className="text-xs text-muted-foreground">
            {t('lastRunRecipes', {
              written: runner.written,
              failed: runner.failed,
              simple: runner.complexityCounts.simple,
              medium: runner.complexityCounts.medium,
              complex: runner.complexityCounts.complex,
            })}
          </span>
        )}
        {runner?.provider && runner.model && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {t('providerChip', { provider: runner.provider, model: runner.model })}
          </span>
        )}
        {runner?.target && (
          <span className="text-xs text-muted-foreground">
            {t('runTarget', { diet: tDiet(runner.target.diet), meal: tMeal(runner.target.meal) })}
          </span>
        )}
        {!running && runner?.note && (
          <span className="text-xs text-muted-foreground">
            {t(`runNotes.${runner.note}`, { skipped: runner.skipped })}
          </span>
        )}
        {runner?.mixDrift && !running && (
          <span className="rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-xs text-warning">
            {t('mixDriftWarning')}
          </span>
        )}
      </div>

      <RecipeImport onImported={loadDrafts} />

      <MissingLanguage onWritten={loadDrafts} />

      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs">
          {error}
        </p>
      )}

      {runner && runner.lastRejectReason && !running && runner.written === 0 && (
        <div className="space-y-1 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs">
          <p className="font-medium">
            {t('rejectReasonLabel', {
              reason: runner.lastRejectReason,
              key: runner.lastRejectKey ?? '',
            })}
          </p>
          {runner.lastRejectHead && (
            <p className="break-all font-mono text-2xs text-muted-foreground">
              {runner.lastRejectHead}…
            </p>
          )}
          <p className="text-muted-foreground">{t('rejectReasonHint')}</p>
        </div>
      )}

      <ShipBar kind="recipe" onShipped={loadDrafts} />

      <FilterStrip
        status={statusFilter}
        onStatusChange={(s) => {
          setStatusFilter(s);
          setPage(1);
        }}
      />
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">{t('filterSource')}:</span>
        {SOURCE_FILTERS.map((source) => (
          <button
            key={source}
            onClick={() => {
              setSourceFilter(source);
              setPage(1);
              setRejected(null);
            }}
            className={
              source === sourceFilter
                ? 'rounded-full bg-primary px-2 py-0.5 text-primary-foreground'
                : 'rounded-full border border-border px-2 py-0.5 hover:bg-muted'
            }
          >
            {t(`source_${source}`)}
          </button>
        ))}
        {sourceFilter === 'AI_USER' && open.length > 0 && (
          <Button size="sm" variant="outline" onClick={onRejectShown}>
            {t('rejectShown', { count: open.length })}
          </Button>
        )}
        {rejected && (
          <span className="text-muted-foreground">{t('rejectShownDone', rejected)}</span>
        )}
      </div>

      {data === null ? (
        <p className="text-sm text-muted-foreground">…</p>
      ) : data.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('emptyRecipes')}</p>
      ) : (
        <ul className="space-y-2">
          {data.items.map((d) => (
            <RecipeDraftRow key={d.id} draft={d} onChanged={loadDrafts} />
          ))}
        </ul>
      )}

      {data && data.total > PAGE_SIZE && (
        <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onPage={setPage} />
      )}
    </>
  );
}

// ── Shared chrome ───────────────────────────────────────────────────────────
