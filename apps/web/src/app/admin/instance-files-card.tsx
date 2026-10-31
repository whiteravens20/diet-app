// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

/** What the instance keeps in its own files, and how their copy in a git repository stands. */
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useId, useState } from 'react';
import {
  CircleCheck,
  CircleDashed,
  FolderSync,
  LoaderCircle,
  RotateCcwClock,
  TriangleAlert,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  adminApi,
  type InstanceDataState,
  type InstanceMirror,
  type RestoreResponse,
} from '@/lib/admin-api';
import { useDraftErrorText, useSkipReasonText } from '@/lib/use-draft-error';
import { useFormat } from '@/lib/use-format';
import { cn } from '@/lib/utils';
import { Explain } from './explain';

/** Whether the copy is out of order: the service is optional, so one that does not run is no fault. */
export function mirrorNeedsAttention(mirror: InstanceMirror | null | undefined): boolean {
  return mirror?.state === 'failed' || mirror?.state === 'silent' || mirror?.state === 'unreadable';
}

export function InstanceFilesCard({
  mirror,
  readAgain,
  onRestored,
}: {
  /** Null until it is read. */
  mirror: InstanceMirror | null;
  /** Anything that changes when the files may have: a ship changes them. */
  readAgain: unknown;
  onRestored: () => void | Promise<void>;
}) {
  const t = useTranslations('admin.curation');
  const errorText = useDraftErrorText();
  const [state, setState] = useState<InstanceDataState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState((await adminApi.shipConfig()).instanceData);
      setError(null);
    } catch (err) {
      setError(errorText(err, String(err)));
    }
  }, [errorText]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load, readAgain]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FolderSync className="h-5 w-5" /> {t('instanceDataHeader')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <p className="text-xs text-destructive">{error}</p>}
        {state && (
          <InstanceData
            state={state}
            onRestored={async () => {
              await load();
              await onRestored();
            }}
          />
        )}
        {mirror && <MirrorCopy mirror={mirror} />}
      </CardContent>
    </Card>
  );
}

/** The copy in a git repository, as its service last reported it. The repository's address stays with the service. */
function MirrorCopy({ mirror }: { mirror: InstanceMirror }) {
  const t = useTranslations('admin.mirror');
  const fmt = useFormat();
  const faulty = mirrorNeedsAttention(mirror);
  const Icon = faulty ? TriangleAlert : mirror.state === 'current' ? CircleCheck : CircleDashed;
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="space-y-2 border-t border-border pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id={titleId} className="text-sm font-medium">
          {t('title')}
        </h4>
        <span
          className={cn(
            'inline-flex items-center gap-1 text-sm',
            faulty && 'text-warning',
            mirror.state === 'current' && 'text-success',
            !faulty && mirror.state !== 'current' && 'text-muted-foreground',
          )}
        >
          <Icon className="h-4 w-4" aria-hidden />
          {t(`state.${mirror.state}`)}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {mirror.failure ? t(`failure.${mirror.failure}`) : t(`explain.${mirror.state}`)}
      </p>
      {faulty && <p className="text-xs text-muted-foreground">{t('logs')}</p>}
      {mirror.checkedAt && (
        <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-muted-foreground">{t('checkedAt')}</dt>
          <dd>{fmt.moment(mirror.checkedAt)}</dd>
          <dt className="text-muted-foreground">{t('pushedAt')}</dt>
          <dd>{mirror.pushedAt ? fmt.moment(mirror.pushedAt) : t('none')}</dd>
          {mirror.copy && (
            <>
              <dt className="text-muted-foreground">{t('contents')}</dt>
              <dd>{t('held', mirror.copy)}</dd>
            </>
          )}
        </dl>
      )}
    </section>
  );
}

/**
 * The instance's own data directory: what the database wrote there and which
 * version wrote it, a warning when the API cannot write to it or when files
 * of the earlier layout wait to be restored, and the restore that reads the
 * files back.
 */
function InstanceData({
  state,
  onRestored,
}: {
  state: InstanceDataState;
  onRestored: () => void | Promise<void>;
}) {
  const t = useTranslations('admin.curation');
  const errorText = useDraftErrorText();
  const reasonText = useSkipReasonText();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RestoreResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const restore = async () => {
    if (!window.confirm(t('restoreConfirm'))) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await adminApi.restoreInstanceData());
      await onRestored();
    } catch (err) {
      setError(errorText(err, String(err)));
    } finally {
      setBusy(false);
    }
  };

  const nothingToRestore = state.recipes === 0 && state.names === 0;
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm">
          {t('instanceDataState', {
            recipes: state.recipes,
            files: state.recipeFiles,
            names: state.names,
          })}
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || nothingToRestore}
          onClick={restore}
          className="gap-2"
        >
          {busy ? (
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RotateCcwClock className="h-3.5 w-3.5" />
          )}
          {t('restoreButton')}
        </Button>
      </div>
      {state.version && (
        <p className="mt-1 text-xs text-muted-foreground">
          {t('instanceDataVersion', { version: state.version })}
        </p>
      )}
      {state.notRestored > 0 && (
        <p className="mt-1 text-xs text-warning">
          {t('instanceDataNotRestored', { count: state.notRestored })}
        </p>
      )}
      {!state.writable && (
        <p className="mt-1 text-xs text-warning">{t('instanceDataNotWritable')}</p>
      )}
      <div className="mt-1">
        <Explain>
          <p>{t('instanceDataExplain')}</p>
        </Explain>
      </div>
      {error && (
        <p className="mt-2 rounded border border-destructive/40 bg-destructive/5 px-2 py-1 text-xs">
          {error}
        </p>
      )}
      {result && (
        <div className="mt-2 rounded border border-success/40 bg-success/5 px-2 py-1 text-xs">
          <p>
            {t('restoreDone', {
              added: result.recipes.added,
              rewritten: result.recipes.rewritten,
              names: result.names.applied,
            })}
          </p>
          {result.recipes.skipped.length > 0 && (
            <div className="mt-1 text-warning">
              <p>{t('restoreSkipped', { count: result.recipes.skipped.length })}</p>
              <ul className="list-disc pl-4">
                {result.recipes.skipped.map((entry, index) => (
                  <li key={`${entry.file}:${index}`}>
                    <span className="font-mono">{entry.slug}</span> ({entry.file}) —{' '}
                    {reasonText(entry.reason)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.names.skippedSlugs.length > 0 && (
            <p className="mt-1 text-warning">
              {t('namesSkipped', {
                count: result.names.skippedSlugs.length,
                slugs: result.names.skippedSlugs.slice(0, 8).join(', '),
              })}
            </p>
          )}
          {result.names.refused.length > 0 && (
            <div className="mt-1 text-warning">
              <p>{t('namesRefused', { count: result.names.refused.length })}</p>
              <ul className="list-disc pl-4">
                {result.names.refused.slice(0, 8).map((entry) => (
                  <li key={entry.slug}>
                    <span className="font-mono">{entry.slug}</span> — {reasonText(entry.reason)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.unreadable.length > 0 && (
            <div className="mt-1 text-warning">
              <p>{t('restoreUnreadable', { count: result.unreadable.length })}</p>
              <ul className="list-disc pl-4">
                {result.unreadable.map((entry) => (
                  <li key={entry.file}>
                    <span className="font-mono">{entry.file}</span> —{' '}
                    {t.has(`restoreUnreadableReasons.${entry.reason}`)
                      ? t(`restoreUnreadableReasons.${entry.reason}`)
                      : entry.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
