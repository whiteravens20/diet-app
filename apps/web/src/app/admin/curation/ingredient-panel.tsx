// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

/** The drafts of ingredient names: the run that writes them, the list, and a draft with its approval for each language. */
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { LoaderCircle, Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  adminApi,
  type AdminOverview,
  type DraftRunnerState,
  type IngredientNameDraft,
  type IngredientNameSuggestionMap,
  type PagedDrafts,
} from '@/lib/admin-api';
import { useDraftErrorText } from '@/lib/use-draft-error';
import { FilterStrip, Pagination } from './list-controls';
import { LocaleReviewMatrix } from './locale-review-matrix';
import { useReviewSignature } from './review-signature';
import { PAGE_SIZE, POLL_INTERVAL_MS, type StatusFilter } from './shared';
import { ShipBar } from './ship-bar';

export function IngredientPanel({
  queue,
  onQueueChanged,
}: {
  /** How many names each way of writing them takes on; null until it is read. */
  queue: AdminOverview['names'] | null;
  /** The list was read: what it shows may have changed the counts. */
  onQueueChanged?: () => void | Promise<void>;
}) {
  const t = useTranslations('admin.curation');
  const errorText = useDraftErrorText();
  const signature = useReviewSignature();
  const bulkReasonId = useId();
  const [runner, setRunner] = useState<DraftRunnerState | null>(null);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('PENDING');
  const [data, setData] = useState<PagedDrafts<IngredientNameDraft> | null>(null);
  // How many times the drafts were read: the ship bar reads its counts again with them.
  const [listRead, setListRead] = useState(0);
  const [rejected, setRejected] = useState<{ rejected: number; skipped: number } | null>(null);
  const [bulkReason, setBulkReason] = useState('');
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
      void onQueueChanged?.();
    } catch (err) {
      setError(errorText(err, String(err)));
    }
  }, [page, statusFilter, errorText, onQueueChanged]);

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

  // A run may be going when the panel opens, started here before a reload or in another browser.
  useEffect(() => {
    void (async () => {
      const state = await loadRunner();
      if (state?.status === 'running') startPolling();
    })();
  }, [loadRunner, startPolling]);

  useEffect(() => {
    void (async () => {
      await loadDrafts();
    })();
  }, [loadDrafts]);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  /** The drafts on this page that can still be rejected. */
  const open = (data?.items ?? []).filter(
    (draft) => draft.status === 'PENDING' || draft.status === 'APPROVED',
  );
  // Names nobody will ship, rejected in one go with one reason, so that they can be written again.
  const onRejectShown = async () => {
    const label = signature.take();
    if (!label) return;
    try {
      const res = await adminApi.rejectIngredientNameDrafts(
        open.map((draft) => draft.id),
        label,
        bulkReason.trim() || undefined,
      );
      setRejected({ rejected: res.rejected.length, skipped: res.skipped.length });
      await loadDrafts();
    } catch (err) {
      setError(errorText(err, String(err)));
    }
  };

  /** Start a run of names, and follow it. */
  const startRun = useCallback(
    async (start: () => Promise<DraftRunnerState>) => {
      try {
        const state = await start();
        setRunner(state);
        setError(null);
        if (state.status === 'running') startPolling();
        void loadDrafts();
      } catch (err) {
        setError(errorText(err, String(err)));
      }
    },
    [errorText, loadDrafts, startPolling],
  );

  const onGenerateMissing = () => {
    if (!window.confirm(t('confirmMissing', { count: queue?.missing ?? 0 }))) return;
    void startRun(() => adminApi.startIngredientNamer({ scope: 'all-usda-missing' }));
  };

  const onGenerateRejected = () => {
    if (!window.confirm(t('confirmRejected', { count: queue?.rejected ?? 0 }))) return;
    void startRun(() => adminApi.startIngredientNamer({ scope: 'rejected' }));
  };

  const onGenerateUnapproved = () => {
    const label = signature.take();
    if (!label) return;
    if (!window.confirm(t('confirmUnapproved', { count: queue?.unapproved ?? 0 }))) return;
    void startRun(() =>
      adminApi.regenerateIngredientNames({
        scope: 'unapproved',
        reviewedByLabel: label,
        reason: bulkReason.trim() || undefined,
      }),
    );
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
        <Button
          size="sm"
          onClick={onGenerateMissing}
          disabled={!configured || running || !queue?.missing}
          className="h-auto min-h-8 gap-2 py-1"
        >
          <Sparkles className="h-4 w-4" />
          {t('generateMissing', { count: queue?.missing ?? 0 })}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={onGenerateRejected}
          disabled={!configured || running || !queue?.rejected}
          className="h-auto min-h-8 py-1"
        >
          {t('generateRejected', { count: queue?.rejected ?? 0 })}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={onGenerateUnapproved}
          disabled={!configured || running || !queue?.unapproved}
          className="h-auto min-h-8 py-1"
        >
          {t('generateUnapproved', { count: queue?.unapproved ?? 0 })}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label htmlFor={bulkReasonId} className="text-muted-foreground">
          {t('bulkReason')}
        </label>
        <Input
          id={bulkReasonId}
          value={bulkReason}
          onChange={(e) => setBulkReason(e.target.value)}
          maxLength={500}
          placeholder={t('decisionReasonHint')}
          className="h-8 w-full sm:w-80"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2 empty:hidden" role="status">
        {running && (
          <span className="inline-flex items-center gap-2 text-xs">
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
            {t('running', { processed: runner?.processed ?? 0, total: runner?.total ?? 0 })}
          </span>
        )}
        {running && (
          <Button onClick={onStop} size="sm" variant="outline" className="gap-2">
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
            <IngredientDraftRow
              key={d.id}
              draft={d}
              onChanged={loadDrafts}
              canRun={configured && !running}
              onRun={startRun}
            />
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
  canRun,
  onRun,
}: {
  draft: IngredientNameDraft;
  onChanged: () => void;
  /** Whether a run of names can start now. */
  canRun: boolean;
  onRun: (start: () => Promise<DraftRunnerState>) => Promise<void>;
}) {
  const t = useTranslations('admin.curation');
  const errorText = useDraftErrorText();
  const signature = useReviewSignature();
  const reasonId = useId();
  const [reason, setReason] = useState('');
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
  const given = reason.trim() || undefined;
  const onApprove = (locale: string) => {
    const label = signature.take();
    if (!label) return;
    void handle(() => adminApi.approveIngredientNameDraft(draft.id, locale, label));
  };

  const onReject = (locale: string) => {
    const label = signature.take();
    if (!label) return;
    void handle(() => adminApi.rejectIngredientNameDraft(draft.id, locale, label, given)).then(
      (done) => {
        if (done) setReason('');
      },
    );
  };

  // A proposal that waits is replaced, and one that was rejected has only to be written anew.
  const onRegenerate = () => {
    if (draft.status === 'REJECTED') {
      void onRun(() =>
        adminApi.startIngredientNamer({ scope: 'specific-slugs', slugs: [draft.ingredientSlug] }),
      );
      return;
    }
    const label = signature.take();
    if (!label) return;
    const touched = draft.edited || draft.localeReviews.some((r) => r.action === 'APPROVE');
    if (touched && !window.confirm(t('regenerateTouchedConfirm'))) return;
    void onRun(() =>
      adminApi.regenerateIngredientNames({
        scope: 'named',
        ids: [draft.id],
        reviewedByLabel: label,
        reason: given,
      }),
    );
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

  /** What the model proposed, or a person made of it: the name above all else in the row. */
  const names = (
    <div className="min-w-0 flex-1 space-y-0.5">
      {draft.locales.map((locale) => (
        <p key={locale} className="break-words">
          <span className="mr-1.5 text-xs uppercase text-muted-foreground">{locale}</span>
          <span className="font-medium">{draft.suggestions.name[locale]}</span>
        </p>
      ))}
    </div>
  );
  const source = (
    <p className="mt-1 break-words text-xs text-muted-foreground">
      {t('rawDescription')}: <code className="break-words">{draft.rawDescription}</code> ·{' '}
      {draft.ingredientSlug}
    </p>
  );
  // Who decided what, once anybody has: a draft nobody has touched has its chip beside the name, and no more to say.
  const decisions = (draft.localeReviews.length > 0 || draft.pastReviews.length > 0) && (
    <LocaleReviewMatrix
      expectedLocales={draft.locales}
      localeReviews={draft.localeReviews}
      pastReviews={draft.pastReviews}
      status={draft.status}
    />
  );

  // What stands where this draft stood: it stays as history, and nothing more can be done with it.
  if (draft.replaced) {
    return (
      <li className="rounded-md border border-border p-3 text-sm opacity-70">
        {names}
        {source}
        {decisions}
        <p className="mt-1 text-xs text-muted-foreground">{t('replacedMark')}</p>
      </li>
    );
  }

  const canDecide = draft.status !== 'SHIPPED' && !editing;
  const canRegenerate = draft.status === 'PENDING' || draft.status === 'REJECTED';
  return (
    <li className="rounded-md border border-border p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        {editing ? (
          <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-2">
            {draft.locales.map((locale) => (
              <label key={locale} className="block space-y-1">
                <span className="text-xs text-muted-foreground">
                  {t('suggested')} · {locale}
                </span>
                <Input
                  value={draftSuggestions.name[locale] ?? ''}
                  onChange={(e) => updateName(locale, e.target.value)}
                />
              </label>
            ))}
          </div>
        ) : (
          names
        )}
        {draft.edited && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{t('editedMark')}</span>
        )}
        <LocaleReviewMatrix
          expectedLocales={draft.locales}
          localeReviews={draft.localeReviews}
          status={draft.status}
          compact
        />
      </div>
      {source}
      {decisions}

      {error && (
        <p className="mt-2 rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1 text-xs">
          {error}
        </p>
      )}

      {canDecide && draft.status !== 'REJECTED' && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <label htmlFor={reasonId} className="text-muted-foreground">
            {t('decisionReason')}
          </label>
          <Input
            id={reasonId}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            placeholder={t('decisionReasonHint')}
            className="h-8 w-full sm:w-80"
          />
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
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
              variant="outline"
              disabled={working || draft.status === 'SHIPPED'}
              onClick={() => setEditing(true)}
            >
              {t('edit')}
            </Button>
            {canRegenerate && (
              <Button
                size="sm"
                variant="outline"
                disabled={working || !canRun}
                onClick={onRegenerate}
              >
                {t('regenerate')}
              </Button>
            )}
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
