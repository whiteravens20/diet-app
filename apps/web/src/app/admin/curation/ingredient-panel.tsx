// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

/** The drafts of ingredient names: the run that writes them, the list, and a draft with its approval for each language. */
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { LoaderCircle, Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  adminApi,
  type DraftRunnerState,
  type IngredientNameDraft,
  type IngredientNameSuggestionMap,
  type PagedDrafts,
} from '@/lib/admin-api';
import { useDraftErrorText } from '@/lib/use-draft-error';
import { FilterStrip, Pagination } from './list-controls';
import { LocaleReviewMatrix } from './locale-review-matrix';
import { PAGE_SIZE, POLL_INTERVAL_MS, type StatusFilter } from './shared';
import { ShipBar } from './ship-bar';

export function IngredientPanel() {
  const t = useTranslations('admin.curation');
  const errorText = useDraftErrorText();
  const [runner, setRunner] = useState<DraftRunnerState | null>(null);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('PENDING');
  const [data, setData] = useState<PagedDrafts<IngredientNameDraft> | null>(null);
  // How many times the drafts were read: the ship bar reads its counts again with them.
  const [listRead, setListRead] = useState(0);
  const [rejected, setRejected] = useState<{ rejected: number; skipped: number } | null>(null);
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
      setListRead((n) => n + 1);
      setError(null);
    } catch (err) {
      setError(errorText(err, String(err)));
    }
  }, [page, statusFilter, errorText]);

  const loadRunner = useCallback(async () => {
    try {
      const state = await adminApi.ingredientNamerStatus();
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

  /** The drafts on this page that can still be rejected. */
  const open = (data?.items ?? []).filter(
    (draft) => draft.status === 'PENDING' || draft.status === 'APPROVED',
  );
  // Names nobody will ship, rejected in one go with one reason, so that the next run writes them again.
  const onRejectShown = async () => {
    const label = window.prompt(t('reviewLabelPrompt'));
    if (!label) return;
    const reason = window.prompt(t('rejectReasonPrompt')) ?? undefined;
    try {
      const res = await adminApi.rejectIngredientNameDrafts(
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

  const onGenerate = async () => {
    try {
      const state = await adminApi.startIngredientNamer({ scope: 'all-usda-missing' });
      setRunner(state);
      if (state.status === 'running') startPolling();
      void loadDrafts();
    } catch (err) {
      setError(errorText(err, String(err)));
    }
  };

  const onStop = async () => {
    try {
      const state = await adminApi.stopIngredientNamer();
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
        <Button onClick={onGenerate} disabled={!configured || running} className="gap-2">
          {running ? (
            <LoaderCircle className="h-4 w-4 animate-spin" />
          ) : (
            <Sparkles className="h-4 w-4" />
          )}
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
        {!running && runner?.note && (
          <span className="text-xs text-muted-foreground">
            {t(`runNotes.${runner.note}`, { skipped: runner.skipped })}
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

      <ShipBar kind="ingredient-name" onShipped={loadDrafts} listRead={listRead} />

      <FilterStrip
        status={statusFilter}
        onStatusChange={(s) => {
          setStatusFilter(s);
          setPage(1);
          setRejected(null);
        }}
      />
      {(open.length > 0 || rejected) && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {open.length > 0 && (
            <Button size="sm" variant="outline" onClick={onRejectShown}>
              {t('rejectShown', { count: open.length })}
            </Button>
          )}
          {rejected && (
            <span className="text-muted-foreground">{t('rejectShownDone', rejected)}</span>
          )}
        </div>
      )}

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

function IngredientDraftRow({
  draft,
  onChanged,
}: {
  draft: IngredientNameDraft;
  onChanged: () => void;
}) {
  const t = useTranslations('admin.curation');
  const errorText = useDraftErrorText();
  const [editing, setEditing] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftSuggestions, setDraftSuggestions] = useState<IngredientNameSuggestionMap>(
    draft.suggestions,
  );

  /** Run a change to the draft; true when it went through. */
  const handle = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setWorking(true);
    setError(null);
    try {
      await fn();
      onChanged();
      return true;
    } catch (err) {
      setError(errorText(err, String(err)));
      return false;
    } finally {
      setWorking(false);
    }
  };

  // What each language was last decided: taking the same decision again would only ask for a name and say it twice.
  const decided = new Map(draft.localeReviews.map((review) => [review.locale, review.action]));
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
    // A refused edit stays in the form: what was typed is not thrown away.
    void handle(() => adminApi.patchIngredientNameDraft(draft.id, draftSuggestions)).then(
      (saved) => {
        if (saved) setEditing(false);
      },
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
        <LocaleReviewMatrix
          expectedLocales={draft.locales}
          localeReviews={draft.localeReviews}
          status={draft.status}
          compact
        />
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

      <LocaleReviewMatrix
        expectedLocales={draft.locales}
        localeReviews={draft.localeReviews}
        pastReviews={draft.pastReviews}
        status={draft.status}
      />

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
                  <Button
                    size="sm"
                    disabled={working || decided.get(locale) === 'APPROVE'}
                    onClick={() => onApprove(locale)}
                  >
                    {t('approve')} · {locale}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={working || decided.get(locale) === 'REJECT'}
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
