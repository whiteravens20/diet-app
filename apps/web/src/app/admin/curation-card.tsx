'use client';

/**
 * Curation queue card.
 *
 * Top-level tab strip switches between two pipelines that share the same
 * card chrome:
 *   - Ingredient-name drafts (Phase C). One-line raw-FDC → friendly name
 *     editor with per-locale approve/reject.
 *   - Recipe drafts (Phase D). Title / description / ingredient editor
 *     with live engine-recomputed nutrition + complexity chip.
 *
 * Both kinds use the single-flight runner pattern shared with `translate/`,
 * so the polling + state shape is identical apart from the recipe runner's
 * extra `complexityCounts` + `mixDrift` fields.
 */
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ClipboardCheck, Loader2, Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  adminApi,
  type DraftRunnerState,
  type IngredientNameDraft,
  type IngredientNameSuggestionMap,
  type PagedDrafts,
  type RecipeDraft,
  type RecipeDraftIngredientLine,
  type RecipeDraftPatch,
  type RecipeRunnerState,
} from '@/lib/admin-api';

type StatusFilter = 'ALL' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'SHIPPED';
type Kind = 'ingredient-names' | 'recipes';

const PAGE_SIZE = 25;
const POLL_INTERVAL_MS = 1500;

export function CurationCard() {
  const t = useTranslations('admin.curation');
  const [kind, setKind] = useState<Kind>('ingredient-names');
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            <ClipboardCheck className="h-5 w-5" />
            {t('title')}
          </CardTitle>
          <KindTabs kind={kind} onChange={setKind} />
        </div>
        <p className="text-sm text-muted-foreground">
          {kind === 'ingredient-names' ? t('explain') : t('explainRecipes')}
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {kind === 'ingredient-names' ? <IngredientPanel /> : <RecipePanel />}
      </CardContent>
    </Card>
  );
}

function KindTabs({ kind, onChange }: { kind: Kind; onChange: (k: Kind) => void }) {
  const t = useTranslations('admin.curation');
  const opts: { value: Kind; label: string }[] = [
    { value: 'ingredient-names', label: t('kindIngredients') },
    { value: 'recipes', label: t('kindRecipes') },
  ];
  return (
    <div className="flex gap-1 text-xs">
      {opts.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={
            o.value === kind
              ? 'rounded-full bg-primary px-3 py-1 text-primary-foreground'
              : 'rounded-full border border-border px-3 py-1 hover:bg-muted'
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── Ingredient-name pipeline ────────────────────────────────────────────────

function IngredientPanel() {
  const t = useTranslations('admin.curation');
  const [runner, setRunner] = useState<DraftRunnerState | null>(null);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('PENDING');
  const [data, setData] = useState<PagedDrafts<IngredientNameDraft> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadDrafts = useCallback(async () => {
    try {
      const res = await adminApi.listIngredientNameDrafts({
        status: statusFilter === 'ALL' ? undefined : statusFilter,
        page,
        pageSize: PAGE_SIZE,
      });
      setData(res);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [page, statusFilter]);

  const loadRunner = useCallback(async () => {
    try {
      const state = await adminApi.ingredientNamerStatus();
      setRunner(state);
      return state;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, []);

  useEffect(() => {
    void (async () => { await loadRunner(); })();
  }, [loadRunner]);

  useEffect(() => {
    void (async () => { await loadDrafts(); })();
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
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  const onGenerate = async () => {
    try {
      const state = await adminApi.startIngredientNamer({ scope: 'all-usda-missing' });
      setRunner(state);
      if (state.status === 'running') startPolling();
      void loadDrafts();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onStop = async () => {
    try {
      const state = await adminApi.stopIngredientNamer();
      setRunner(state);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const running = runner?.status === 'running';
  const configured = runner?.configured ?? false;

  return (
    <>
      {!configured && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs">
          {t('notConfigured')}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={onGenerate} disabled={!configured || running} className="gap-2">
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          {running
            ? t('running', { processed: runner?.processed ?? 0, total: runner?.total ?? 0 })
            : t('generate')}
        </Button>
        {running && (
          <Button onClick={onStop} variant="outline" className="gap-2">
            <X className="h-4 w-4" />
            {t('stop')}
          </Button>
        )}
        {!running && runner && (runner.processed > 0 || runner.failed > 0) && (
          <span className="text-xs text-muted-foreground">
            {t('lastRun', { written: runner.written, failed: runner.failed })}
          </span>
        )}
        {runner?.provider && runner.model && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {t('providerChip', { provider: runner.provider, model: runner.model })}
          </span>
        )}
      </div>

      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs">
          {error}
        </p>
      )}

      <FilterStrip
        status={statusFilter}
        onStatusChange={(s) => { setStatusFilter(s); setPage(1); }}
      />

      {data === null ? (
        <p className="text-sm text-muted-foreground">…</p>
      ) : data.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="space-y-2">
          {data.items.map((d) => (
            <IngredientDraftRow key={d.id} draft={d} onChanged={loadDrafts} />
          ))}
        </ul>
      )}

      {data && data.total > PAGE_SIZE && (
        <Pagination page={page} pageSize={PAGE_SIZE} total={data.total} onPage={setPage} />
      )}
    </>
  );
}

// ── Recipe pipeline ─────────────────────────────────────────────────────────

function RecipePanel() {
  const t = useTranslations('admin.curation');
  const [runner, setRunner] = useState<RecipeRunnerState | null>(null);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('PENDING');
  const [data, setData] = useState<PagedDrafts<RecipeDraft> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [genCount, setGenCount] = useState(5);
  const [scope, setScope] = useState<'curated' | 'all'>('curated');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadDrafts = useCallback(async () => {
    try {
      const res = await adminApi.listRecipeDrafts({
        status: statusFilter === 'ALL' ? undefined : statusFilter,
        page,
        pageSize: PAGE_SIZE,
      });
      setData(res);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [page, statusFilter]);

  const loadRunner = useCallback(async () => {
    try {
      const state = await adminApi.recipeGeneratorStatus();
      setRunner(state);
      return state;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, []);

  useEffect(() => {
    void (async () => { await loadRunner(); })();
  }, [loadRunner]);
  useEffect(() => {
    void (async () => { await loadDrafts(); })();
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
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  const onGenerate = async () => {
    try {
      const state = await adminApi.startRecipeGenerator({
        count: genCount,
        catalogueScope: scope,
      });
      setRunner(state);
      if (state.status === 'running') startPolling();
      void loadDrafts();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onStop = async () => {
    try {
      const state = await adminApi.stopRecipeGenerator();
      setRunner(state);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const running = runner?.status === 'running';
  const configured = runner?.configured ?? false;

  return (
    <>
      {!configured && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs">
          {t('notConfigured')}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs text-muted-foreground">{t('recipeCount')}</label>
        <Input
          type="number"
          min={1}
          max={25}
          value={genCount}
          onChange={(e) => setGenCount(Math.max(1, Math.min(25, Number(e.target.value) || 1)))}
          className="w-20"
          disabled={running}
        />
        <label className="text-xs text-muted-foreground">{t('scopeLabel')}</label>
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value as 'curated' | 'all')}
          disabled={running}
          className="rounded-md border border-border bg-background px-2 py-1 text-xs"
        >
          <option value="curated">{t('scopeCurated')}</option>
          <option value="all">{t('scopeAll')}</option>
        </select>
        <Button onClick={onGenerate} disabled={!configured || running} className="gap-2">
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
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
        {runner?.mixDrift && !running && (
          <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-300">
            {t('mixDriftWarning')}
          </span>
        )}
      </div>

      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs">
          {error}
        </p>
      )}

      {runner && runner.lastRejectReason && !running && runner.written === 0 && (
        <div className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs">
          <p className="font-medium">
            {t('rejectReasonLabel', {
              reason: runner.lastRejectReason,
              key: runner.lastRejectKey ?? '',
            })}
          </p>
          {runner.lastRejectHead && (
            <p className="break-all font-mono text-[10px] text-muted-foreground">
              {runner.lastRejectHead}…
            </p>
          )}
          <p className="text-muted-foreground">{t('rejectReasonHint')}</p>
        </div>
      )}

      <FilterStrip
        status={statusFilter}
        onStatusChange={(s) => { setStatusFilter(s); setPage(1); }}
      />

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

function FilterStrip({
  status,
  onStatusChange,
}: {
  status: StatusFilter;
  onStatusChange: (s: StatusFilter) => void;
}) {
  const t = useTranslations('admin.curation');
  const options: StatusFilter[] = ['ALL', 'PENDING', 'APPROVED', 'REJECTED', 'SHIPPED'];
  const labelKey: Record<StatusFilter, string> = {
    ALL: 'statusAll',
    PENDING: 'statusPending',
    APPROVED: 'statusApproved',
    REJECTED: 'statusRejected',
    SHIPPED: 'statusShipped',
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted-foreground">{t('filterStatus')}:</span>
      {options.map((o) => (
        <button
          key={o}
          onClick={() => onStatusChange(o)}
          className={
            o === status
              ? 'rounded-full bg-primary px-2 py-0.5 text-primary-foreground'
              : 'rounded-full border border-border px-2 py-0.5 hover:bg-muted'
          }
        >
          {t(labelKey[o])}
        </button>
      ))}
    </div>
  );
}

function Pagination({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
}) {
  const t = useTranslations('admin.curation');
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const last = Math.ceil(total / pageSize);
  return (
    <div className="flex items-center justify-between text-xs text-muted-foreground">
      <span>{t('showing', { from, to, total })}</span>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          {t('prev')}
        </Button>
        <Button variant="outline" size="sm" disabled={page >= last} onClick={() => onPage(page + 1)}>
          {t('next')}
        </Button>
      </div>
    </div>
  );
}

// ── Ingredient draft row ────────────────────────────────────────────────────

function IngredientDraftRow({
  draft,
  onChanged,
}: {
  draft: IngredientNameDraft;
  onChanged: () => void;
}) {
  const t = useTranslations('admin.curation');
  const [editing, setEditing] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftSuggestions, setDraftSuggestions] = useState<IngredientNameSuggestionMap>(
    draft.suggestions,
  );

  const handle = async (fn: () => Promise<unknown>) => {
    setWorking(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  };

  const onApprove = (locale: string) => {
    const label = window.prompt(t('reviewLabelPrompt'));
    if (!label) return;
    void handle(() => adminApi.approveIngredientNameDraft(draft.id, locale, label));
  };

  const onReject = (locale: string) => {
    const label = window.prompt(t('reviewLabelPrompt'));
    if (!label) return;
    const reason = window.prompt(t('rejectReasonPrompt')) ?? undefined;
    void handle(() => adminApi.rejectIngredientNameDraft(draft.id, locale, label, reason));
  };

  const onDelete = () => {
    if (!window.confirm(t('deleteConfirm'))) return;
    void handle(() => adminApi.deleteIngredientNameDraft(draft.id));
  };

  const onSave = () => {
    void handle(() => adminApi.patchIngredientNameDraft(draft.id, draftSuggestions)).then(() =>
      setEditing(false),
    );
  };

  const onCancelEdit = () => {
    setDraftSuggestions(draft.suggestions);
    setEditing(false);
  };

  const updateName = (locale: string, value: string) => {
    setDraftSuggestions((s) => ({
      ...s,
      name: { ...s.name, [locale]: value },
    }));
  };

  return (
    <li className="rounded-md border border-border p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground">
            {t('rawDescription')}: <code className="break-words">{draft.rawDescription}</code>
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">{draft.ingredientSlug}</p>
        </div>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{draft.status}</span>
      </div>

      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {draft.locales.map((locale) => (
          <div key={locale} className="space-y-1">
            <label className="text-xs text-muted-foreground">
              {t('suggested')} · {locale}
            </label>
            {editing ? (
              <Input
                value={draftSuggestions.name[locale] ?? ''}
                onChange={(e) => updateName(locale, e.target.value)}
              />
            ) : (
              <p className="font-medium">{draft.suggestions.name[locale]}</p>
            )}
          </div>
        ))}
      </div>

      <LocaleReviewList localeReviews={draft.localeReviews} />

      {error && (
        <p className="mt-2 rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1 text-xs">
          {error}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {editing ? (
          <>
            <Button size="sm" disabled={working} onClick={onSave}>
              {t('save')}
            </Button>
            <Button size="sm" variant="outline" disabled={working} onClick={onCancelEdit}>
              {t('cancel')}
            </Button>
          </>
        ) : (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={working || draft.status === 'SHIPPED'}
              onClick={() => setEditing(true)}
            >
              {t('edit')}
            </Button>
            {draft.status !== 'SHIPPED' &&
              draft.locales.map((locale) => (
                <span key={locale} className="flex items-center gap-1">
                  <Button size="sm" disabled={working} onClick={() => onApprove(locale)}>
                    {t('approve')} · {locale}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={working}
                    onClick={() => onReject(locale)}
                  >
                    {t('reject')} · {locale}
                  </Button>
                </span>
              ))}
            <Button
              size="sm"
              variant="ghost"
              disabled={working || draft.status === 'SHIPPED'}
              onClick={onDelete}
            >
              {t('deleteAction')}
            </Button>
          </>
        )}
      </div>
    </li>
  );
}

// ── Recipe draft row ────────────────────────────────────────────────────────

function RecipeDraftRow({
  draft,
  onChanged,
}: {
  draft: RecipeDraft;
  onChanged: () => void;
}) {
  const t = useTranslations('admin.curation');
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<{
    titles: Record<string, string>;
    descriptions: Record<string, string>;
    steps: Record<string, string[]>;
    servings: number;
    prepMinutes: number;
    cookMinutes: number;
    ingredients: RecipeDraftIngredientLine[];
  }>({
    titles: draft.titles,
    descriptions: draft.descriptions,
    steps: draft.steps,
    servings: draft.servings,
    prepMinutes: draft.prepMinutes,
    cookMinutes: draft.cookMinutes,
    ingredients: draft.ingredients,
  });
  const [preview, setPreview] = useState<{
    caloriesPerServing: number;
    proteinPerServing: number;
    fatPerServing: number;
    carbsPerServing: number;
    allergens: string[];
    complexity: string;
  } | null>(null);

  const handle = async (fn: () => Promise<unknown>) => {
    setWorking(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  };

  const buildPatch = (): RecipeDraftPatch => ({
    titles: edit.titles,
    descriptions: edit.descriptions,
    steps: edit.steps,
    servings: edit.servings,
    prepMinutes: edit.prepMinutes,
    cookMinutes: edit.cookMinutes,
    ingredients: edit.ingredients,
  });

  const runDryRun = async () => {
    setError(null);
    try {
      const next = await adminApi.patchRecipeDraft(draft.id, buildPatch(), true);
      setPreview({
        caloriesPerServing: next.caloriesPerServing,
        proteinPerServing: next.proteinPerServing,
        fatPerServing: next.fatPerServing,
        carbsPerServing: next.carbsPerServing,
        allergens: next.allergens,
        complexity: next.complexity,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onSave = () => {
    void handle(() => adminApi.patchRecipeDraft(draft.id, buildPatch(), false)).then(() => {
      setEditing(false);
      setPreview(null);
    });
  };

  const onCancelEdit = () => {
    setEdit({
      titles: draft.titles,
      descriptions: draft.descriptions,
      steps: draft.steps,
      servings: draft.servings,
      prepMinutes: draft.prepMinutes,
      cookMinutes: draft.cookMinutes,
      ingredients: draft.ingredients,
    });
    setPreview(null);
    setEditing(false);
  };

  const onApprove = (locale: string) => {
    const label = window.prompt(t('reviewLabelPrompt'));
    if (!label) return;
    void handle(() => adminApi.approveRecipeDraft(draft.id, locale, label));
  };
  const onReject = (locale: string) => {
    const label = window.prompt(t('reviewLabelPrompt'));
    if (!label) return;
    const reason = window.prompt(t('rejectReasonPrompt')) ?? undefined;
    void handle(() => adminApi.rejectRecipeDraft(draft.id, locale, label, reason));
  };
  const onDelete = () => {
    if (!window.confirm(t('deleteConfirm'))) return;
    void handle(() => adminApi.deleteRecipeDraft(draft.id));
  };

  const nutr = preview ?? draft;

  return (
    <li className="rounded-md border border-border p-3 text-sm">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full flex-wrap items-start justify-between gap-2 text-left"
      >
        <div className="min-w-0 flex-1">
          <p className="font-medium">{draft.titles.en}</p>
          <p className="text-xs text-muted-foreground">
            {draft.descriptions.en}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs">
            {t(`complexity_${draft.complexity}`)}
          </span>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{draft.status}</span>
        </div>
      </button>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          {t('nutritionStrip', {
            kcal: nutr.caloriesPerServing,
            protein: nutr.proteinPerServing,
            fat: nutr.fatPerServing,
            carbs: nutr.carbsPerServing,
          })}
        </span>
        <span>{t('servings', { count: draft.servings })}</span>
        <span>{t('timeStrip', { prep: draft.prepMinutes, cook: draft.cookMinutes })}</span>
        {draft.allergens.length > 0 && (
          <span>{t('allergensLabel', { list: draft.allergens.join(', ') })}</span>
        )}
      </div>

      {expanded && (
        <div className="mt-3 space-y-3 border-t border-border pt-3">
          {editing ? (
            <RecipeEditor
              edit={edit}
              locales={draft.locales}
              onChange={setEdit}
              onDryRun={runDryRun}
            />
          ) : (
            <RecipePreview draft={draft} />
          )}

          {error && (
            <p className="rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1 text-xs">
              {error}
            </p>
          )}

          <LocaleReviewList localeReviews={draft.localeReviews} />

          <div className="flex flex-wrap items-center gap-2">
            {editing ? (
              <>
                <Button size="sm" disabled={working} onClick={onSave}>
                  {t('save')}
                </Button>
                <Button size="sm" variant="outline" disabled={working} onClick={onCancelEdit}>
                  {t('cancel')}
                </Button>
              </>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={working || draft.status === 'SHIPPED'}
                  onClick={() => setEditing(true)}
                >
                  {t('edit')}
                </Button>
                {draft.status !== 'SHIPPED' &&
                  draft.locales.map((locale) => (
                    <span key={locale} className="flex items-center gap-1">
                      <Button size="sm" disabled={working} onClick={() => onApprove(locale)}>
                        {t('approve')} · {locale}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={working}
                        onClick={() => onReject(locale)}
                      >
                        {t('reject')} · {locale}
                      </Button>
                    </span>
                  ))}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={working || draft.status === 'SHIPPED'}
                  onClick={onDelete}
                >
                  {t('deleteAction')}
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

function RecipePreview({ draft }: { draft: RecipeDraft }) {
  const t = useTranslations('admin.curation');
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {draft.locales.map((locale) => (
        <div key={locale} className="space-y-1">
          <p className="text-xs text-muted-foreground">{locale}</p>
          <p className="font-medium">{draft.titles[locale] ?? '—'}</p>
          <p className="text-xs">{draft.descriptions[locale] ?? '—'}</p>
          <ol className="ml-4 list-decimal text-xs">
            {(draft.steps[locale] ?? []).map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </div>
      ))}
      <div className="md:col-span-2">
        <p className="text-xs text-muted-foreground">{t('ingredientsLabel')}</p>
        <ul className="ml-4 list-disc text-xs">
          {draft.ingredients.map((ing, i) => (
            <li key={`${ing.slug}-${i}`}>
              <code>{ing.slug}</code> — {ing.quantity} {ing.unit}
              {ing.note ? ` (${ing.note})` : ''}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function RecipeEditor({
  edit,
  locales,
  onChange,
  onDryRun,
}: {
  edit: {
    titles: Record<string, string>;
    descriptions: Record<string, string>;
    steps: Record<string, string[]>;
    servings: number;
    prepMinutes: number;
    cookMinutes: number;
    ingredients: RecipeDraftIngredientLine[];
  };
  locales: string[];
  onChange: (next: typeof edit) => void;
  onDryRun: () => void;
}) {
  const t = useTranslations('admin.curation');

  const updateTitle = (locale: string, v: string) =>
    onChange({ ...edit, titles: { ...edit.titles, [locale]: v } });
  const updateDescription = (locale: string, v: string) =>
    onChange({ ...edit, descriptions: { ...edit.descriptions, [locale]: v } });
  const updateStep = (locale: string, idx: number, v: string) => {
    const next = [...(edit.steps[locale] ?? [])];
    next[idx] = v;
    onChange({ ...edit, steps: { ...edit.steps, [locale]: next } });
  };
  const updateIngredient = (idx: number, patch: Partial<RecipeDraftIngredientLine>) => {
    const next = edit.ingredients.map((line, i) => (i === idx ? { ...line, ...patch } : line));
    onChange({ ...edit, ingredients: next });
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        {locales.map((locale) => (
          <div key={locale} className="space-y-1">
            <label className="text-xs text-muted-foreground">{t('title')} · {locale}</label>
            <Input value={edit.titles[locale] ?? ''} onChange={(e) => updateTitle(locale, e.target.value)} />
            <label className="text-xs text-muted-foreground">{t('descriptionLabel')} · {locale}</label>
            <Input
              value={edit.descriptions[locale] ?? ''}
              onChange={(e) => updateDescription(locale, e.target.value)}
            />
            <label className="text-xs text-muted-foreground">{t('stepsLabel')} · {locale}</label>
            {(edit.steps[locale] ?? []).map((step, i) => (
              <Input
                key={i}
                value={step}
                onChange={(e) => updateStep(locale, i, e.target.value)}
              />
            ))}
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-2 text-xs">
        <span className="text-muted-foreground">{t('servings', { count: edit.servings })}</span>
        <Input
          type="number"
          min={1}
          value={edit.servings}
          onChange={(e) => onChange({ ...edit, servings: Number(e.target.value) || 1 })}
          className="w-16"
        />
        <span className="text-muted-foreground">{t('prepMinutesLabel')}</span>
        <Input
          type="number"
          min={0}
          value={edit.prepMinutes}
          onChange={(e) => onChange({ ...edit, prepMinutes: Number(e.target.value) || 0 })}
          className="w-16"
        />
        <span className="text-muted-foreground">{t('cookMinutesLabel')}</span>
        <Input
          type="number"
          min={0}
          value={edit.cookMinutes}
          onChange={(e) => onChange({ ...edit, cookMinutes: Number(e.target.value) || 0 })}
          className="w-16"
        />
      </div>

      <div>
        <p className="text-xs text-muted-foreground">{t('ingredientsLabel')}</p>
        <ul className="space-y-1">
          {edit.ingredients.map((line, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2 text-xs">
              <code className="flex-1">{line.slug}</code>
              <Input
                type="number"
                min={0}
                step="any"
                value={line.quantity}
                onChange={(e) =>
                  updateIngredient(i, { quantity: Number(e.target.value) || 0 })
                }
                className="w-20"
              />
              <span className="text-muted-foreground">{line.unit}</span>
            </li>
          ))}
        </ul>
      </div>

      <Button size="sm" variant="outline" onClick={onDryRun}>
        {t('recompute')}
      </Button>
    </div>
  );
}

function LocaleReviewList({
  localeReviews,
}: {
  localeReviews: { locale: string; action: 'APPROVE' | 'REJECT'; reviewedByLabel: string; reason: string | null; reviewedAt: string }[];
}) {
  const t = useTranslations('admin.curation');
  if (localeReviews.length === 0) return null;
  return (
    <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
      {localeReviews.map((r) => (
        <li key={`${r.locale}-${r.reviewedAt}`}>
          {t('approvalState', {
            locale: r.locale.toUpperCase(),
            action: r.action,
            label: r.reviewedByLabel,
          })}
          {r.reason ? ` — ${r.reason}` : ''}
        </li>
      ))}
    </ul>
  );
}
