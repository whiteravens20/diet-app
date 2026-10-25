// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { Languages, LoaderCircle, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { MOST_TRANSLATIONS_PER_RUN, NON_CANONICAL_LOCALES } from '@diet-app/shared/constants';
import { Button } from '@/components/ui/button';
import { adminApi, type DraftRunnerState } from '@/lib/admin-api';
import { useDraftErrorText } from '@/lib/use-draft-error';

const POLL_INTERVAL_MS = 1500;

/**
 * The run that fills a language recipes lack: which language, how many at
 * most, and where the run stands. What it writes goes into the queue shown
 * below it, so the list is read again when a run ends.
 */
export function MissingLanguage({ onWritten }: { onWritten: () => void | Promise<void> }) {
  const t = useTranslations('admin.curation.missingLanguage');
  const tNotes = useTranslations('admin.curation.runNotes');
  const tCuration = useTranslations('admin.curation');
  const tLanguage = useTranslations('review.locales');
  const errorText = useDraftErrorText();
  const titleId = useId();
  const languageId = useId();
  const limitId = useId();
  const [runner, setRunner] = useState<DraftRunnerState | null>(null);
  const [locale, setLocale] = useState<string>(NON_CANONICAL_LOCALES[0] ?? '');
  // As it is typed: a field that is being emptied to type another number is no number for a moment.
  const [limit, setLimit] = useState('25');
  const [error, setError] = useState<string | null>(null);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const read = useCallback(async (): Promise<DraftRunnerState | null> => {
    try {
      const state = await adminApi.translationsStatus();
      setRunner(state);
      return state;
    } catch (err) {
      setError(errorText(err, String(err)));
      return null;
    }
  }, [errorText]);

  const watch = useCallback(() => {
    if (poll.current) return;
    poll.current = setInterval(async () => {
      const state = await read();
      if (state && state.status === 'running') return;
      if (poll.current) clearInterval(poll.current);
      poll.current = null;
      // A run that could not be asked about is watched no longer; one that ended wrote into the queue.
      if (state) void onWritten();
    }, POLL_INTERVAL_MS);
  }, [read, onWritten]);

  useEffect(() => {
    void (async () => {
      // A run that somebody started before this page was opened is followed too.
      if ((await read())?.status === 'running') watch();
    })();
    return () => {
      if (poll.current) clearInterval(poll.current);
      poll.current = null;
    };
  }, [read, watch]);

  const start = async (): Promise<void> => {
    setError(null);
    try {
      const most = Math.min(MOST_TRANSLATIONS_PER_RUN, Math.max(1, Math.trunc(Number(limit)) || 1));
      setLimit(String(most));
      const state = await adminApi.startTranslations({ locale, limit: most });
      setRunner(state);
      if (state.status === 'running') watch();
    } catch (err) {
      setError(errorText(err, String(err)));
    }
  };

  const stop = async (): Promise<void> => {
    try {
      setRunner(await adminApi.stopTranslations());
    } catch (err) {
      setError(errorText(err, String(err)));
    }
  };

  const running = runner?.status === 'running';
  const configured = runner?.configured ?? false;
  const ended = runner && !running && (runner.status === 'done' || runner.status === 'error');

  return (
    <section aria-labelledby={titleId} className="space-y-2 rounded-md border border-border p-3">
      <h3 id={titleId} className="text-sm font-medium">
        {t('title')}
      </h3>
      <p className="text-xs text-muted-foreground">{t('hint')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={languageId} className="text-xs text-muted-foreground">
          {t('language')}
        </label>
        <select
          id={languageId}
          value={locale}
          onChange={(e) => setLocale(e.target.value)}
          disabled={running}
          className="rounded-md border border-input bg-background px-2 py-1 text-xs"
        >
          {NON_CANONICAL_LOCALES.map((language) => (
            <option key={language} value={language}>
              {tLanguage(language)}
            </option>
          ))}
        </select>
        <label htmlFor={limitId} className="text-xs text-muted-foreground">
          {t('limit')}
        </label>
        <input
          id={limitId}
          type="number"
          min={1}
          max={MOST_TRANSLATIONS_PER_RUN}
          value={limit}
          onChange={(e) => setLimit(e.target.value)}
          disabled={running}
          className="w-20 rounded-md border border-input bg-background px-2 py-1 text-xs"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void start()}
          disabled={!configured || running || locale === ''}
          className="gap-2"
        >
          {running ? (
            <LoaderCircle className="h-4 w-4 animate-spin" />
          ) : (
            <Languages className="h-4 w-4" />
          )}
          {running
            ? t('running', { processed: runner?.processed ?? 0, total: runner?.total ?? 0 })
            : t('start')}
        </Button>
        {running && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void stop()}
            className="gap-2"
          >
            <X className="h-4 w-4" />
            {tCuration('stop')}
          </Button>
        )}
      </div>
      <div role="status" className="space-y-1 text-xs text-muted-foreground">
        {ended && runner.status === 'error' && (
          <p className="text-destructive">{t('failed', { error: runner.error ?? '' })}</p>
        )}
        {ended && runner.status === 'done' && runner.note && (
          <p>{tNotes(runner.note, { skipped: runner.skipped })}</p>
        )}
        {ended && runner.status === 'done' && !runner.note && (
          <p>
            {t('lastRun', {
              written: runner.written,
              failed: runner.failed,
              skipped: runner.skipped,
            })}
          </p>
        )}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </section>
  );
}
