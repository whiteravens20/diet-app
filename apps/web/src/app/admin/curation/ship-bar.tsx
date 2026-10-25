// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

/** Shipping what was approved: into this instance or as a file for a repository, with what the instance keeps in its own files. */
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import {
  CloudDownload,
  Download,
  LoaderCircle,
  RotateCcwClock,
  Send,
  ServerCog,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ApiClientError } from '@/lib/http';
import {
  adminApi,
  saveJsonFile,
  type CurrentOverridesPullResponse,
  type ShipConfigDto,
  type ShipKind,
  type ShipMode,
  type InstanceDataState,
  type RestoreResponse,
  type ShipResponse,
  type ShipSkipped,
} from '@/lib/admin-api';
import { useDraftErrorText, useSkipReasonText } from '@/lib/use-draft-error';

export function ShipBar({
  kind,
  onShipped,
}: {
  kind: ShipKind;
  onShipped: () => void | Promise<void>;
}) {
  const t = useTranslations('admin.curation');
  const errorText = useDraftErrorText();
  const skipReasonText = useSkipReasonText();
  const [config, setConfig] = useState<ShipConfigDto | null>(null);
  const [busyMode, setBusyMode] = useState<ShipMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<ShipResponse | null>(null);
  const [heldBack, setHeldBack] = useState<ShipSkipped[]>([]);
  const [currentBusy, setCurrentBusy] = useState<'download' | 'pull' | null>(null);
  const [pullResult, setPullResult] = useState<CurrentOverridesPullResponse | null>(null);
  const [pullSource, setPullSource] = useState('');

  const refresh = useCallback(async () => {
    try {
      const c = await adminApi.shipConfig();
      setConfig(c);
      setPullSource((prev) => prev || c.pull.defaultSource);
    } catch (err) {
      setError(errorText(err, String(err)));
    }
  }, [errorText]);

  useEffect(() => {
    void (async () => {
      await refresh();
    })();
  }, [refresh]);

  const approvedCount =
    kind === 'recipe'
      ? (config?.approvedCounts.recipe ?? 0)
      : (config?.approvedCounts.ingredientName ?? 0);

  const run = async (mode: ShipMode) => {
    setBusyMode(mode);
    setError(null);
    setHeldBack([]);
    setSuccess(null);
    try {
      const res = await adminApi.ship({ kind, mode });
      setSuccess(res);
      await refresh();
      await onShipped();
    } catch (err) {
      setError(errorText(err, String(err)));
      // A ship that ships nothing names the drafts it held back.
      const skipped = err instanceof ApiClientError ? err.details?.skipped : undefined;
      if (Array.isArray(skipped)) setHeldBack(skipped as ShipSkipped[]);
    } finally {
      setBusyMode(null);
    }
  };

  const onMarkShipped = async (draftIds: string[]) => {
    try {
      await adminApi.shipMarkShipped({ kind, draftIds });
      setSuccess(null);
      await refresh();
      await onShipped();
    } catch (err) {
      setError(errorText(err, String(err)));
    }
  };

  const downloadCurrent = async () => {
    setCurrentBusy('download');
    setError(null);
    try {
      await adminApi.downloadCurrentOverrides();
    } catch (err) {
      setError(errorText(err, String(err)));
    } finally {
      setCurrentBusy(null);
    }
  };

  const pullCurrent = async () => {
    setCurrentBusy('pull');
    setError(null);
    setPullResult(null);
    try {
      const res = await adminApi.pullCurrentOverrides(pullSource.trim() || undefined);
      setPullResult(res);
      await onShipped();
    } catch (err) {
      setError(errorText(err, String(err)));
    } finally {
      setCurrentBusy(null);
    }
  };

  if (!config) return null;
  const disabled = approvedCount === 0 || busyMode !== null;
  const currentDisabled = busyMode !== null || currentBusy !== null;

  return (
    <div className="rounded-md border border-border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('shipHeader')}
        </span>
        <span className="rounded-full bg-background px-2 py-0.5 text-xs">
          {t('shipApprovedCount', { count: approvedCount })}
        </span>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="primary"
          disabled={disabled}
          onClick={() => run('local')}
          className="gap-2"
        >
          {busyMode === 'local' ? (
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ServerCog className="h-3.5 w-3.5" />
          )}
          {t('shipModeLocal')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => run('bundle')}
          className="gap-2"
        >
          {busyMode === 'bundle' ? (
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
          {t('shipModeBundle')}
        </Button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{t('shipExplain')}</p>

      {kind === 'ingredient-name' && (
        <div className="mt-3 border-t border-border pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t('shipCurrentHeader')}
            </span>
            <span className="flex-1" />
            <Button
              size="sm"
              variant="outline"
              disabled={currentDisabled}
              onClick={downloadCurrent}
              className="gap-2"
            >
              {currentBusy === 'download' ? (
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              {t('shipCurrentDownload')}
            </Button>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{t('shipCurrentExplain')}</p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t('shipPullHeader')}
            </span>
            <Input
              value={pullSource}
              onChange={(e) => setPullSource(e.target.value)}
              placeholder="owner/repo"
              className="h-8 max-w-xs flex-1 text-xs"
              disabled={currentDisabled}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={currentDisabled || pullSource.trim().length === 0}
              onClick={pullCurrent}
              className="gap-2"
            >
              {currentBusy === 'pull' ? (
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <CloudDownload className="h-3.5 w-3.5" />
              )}
              {t('shipCurrentPull')}
            </Button>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {config.pull.tokenSet ? t('shipPullExplainToken') : t('shipPullExplainNoToken')}
          </p>
          {pullResult && (
            <div className="mt-2 rounded border border-success/40 bg-success/5 px-2 py-1 text-xs">
              <p>
                {t('shipPullSuccess', { applied: pullResult.applied, total: pullResult.total })}
              </p>
              {pullResult.skippedSlugs.length > 0 && (
                <p className="mt-1 text-warning">
                  {t('shipPullSkipped', {
                    count: pullResult.skippedSlugs.length,
                    slugs: pullResult.skippedSlugs.slice(0, 8).join(', '),
                  })}
                </p>
              )}
              {pullResult.refused.length > 0 && (
                <div className="mt-1 text-warning">
                  <p>{t('shipPullRefused', { count: pullResult.refused.length })}</p>
                  <ul className="list-disc pl-4">
                    {pullResult.refused.slice(0, 8).map((entry) => (
                      <li key={entry.slug}>
                        <span className="font-mono">{entry.slug}</span> —{' '}
                        {skipReasonText(entry.reason)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <InstanceData
        state={config.instanceData}
        disabled={currentDisabled}
        onRestored={async () => {
          await refresh();
          await onShipped();
        }}
      />

      {error && (
        <p className="mt-2 rounded border border-destructive/40 bg-destructive/5 px-2 py-1 text-xs">
          {error}
        </p>
      )}
      {error && (
        <div className="text-xs">
          <SkippedDrafts skipped={heldBack} heading="shipSkipped" />
        </div>
      )}
      {success && (
        <ShipSuccess
          result={success}
          onMarkShipped={onMarkShipped}
          onDismiss={() => setSuccess(null)}
        />
      )}
    </div>
  );
}

/**
 * The instance's own data directory: what local ships copied there, a warning
 * when the API cannot write to it, and the restore that reads the files back.
 */
function InstanceData({
  state,
  disabled,
  onRestored,
}: {
  state: InstanceDataState;
  disabled: boolean;
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
    <div className="mt-3 border-t border-border pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('instanceDataHeader')}
        </span>
        <span className="text-xs">
          {t('instanceDataState', {
            recipes: state.recipes,
            files: state.recipeFiles,
            names: state.names,
          })}
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || busy || nothingToRestore}
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
      <p className="mt-1 text-xs text-muted-foreground">{t('instanceDataExplain')}</p>
      {!state.writable && (
        <p className="mt-1 text-xs text-warning">{t('instanceDataNotWritable')}</p>
      )}
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
              {t('shipPullSkipped', {
                count: result.names.skippedSlugs.length,
                slugs: result.names.skippedSlugs.slice(0, 8).join(', '),
              })}
            </p>
          )}
          {result.names.refused.length > 0 && (
            <div className="mt-1 text-warning">
              <p>{t('shipPullRefused', { count: result.names.refused.length })}</p>
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

/** The approved drafts a ship left where they were, each by its slug, with the reason in words. */
function SkippedDrafts({
  skipped,
  heading,
}: {
  skipped: ShipSkipped[];
  heading: 'shipSkipped' | 'shipBundleSkipped';
}) {
  const t = useTranslations('admin.curation');
  const reasonText = useSkipReasonText();
  if (skipped.length === 0) return null;
  return (
    <div className="mt-1 text-warning">
      <p>{t(heading, { count: skipped.length })}</p>
      <ul className="list-disc pl-4">
        {skipped.map((entry) => (
          <li key={entry.draftId}>
            <span className="font-mono">{entry.slug}</span> — {reasonText(entry.reason)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ShipSuccess({
  result,
  onMarkShipped,
  onDismiss,
}: {
  result: ShipResponse;
  onMarkShipped: (draftIds: string[]) => void | Promise<void>;
  onDismiss: () => void;
}) {
  const t = useTranslations('admin.curation');
  if (result.mode === 'local') {
    return (
      <div className="mt-2 rounded border border-success/40 bg-success/5 px-3 py-2 text-xs">
        <div className="flex items-center gap-2">
          <Send className="h-3.5 w-3.5" />
          <strong>{t('shipSuccessLocal', { count: result.shippedDraftIds.length })}</strong>
          <span className="flex-1" />
          <button onClick={onDismiss} className="text-muted-foreground hover:underline">
            {t('shipDismiss')}
          </button>
        </div>
        {result.sidecarPaths.length > 0 && (
          <p className="mt-1 text-muted-foreground">
            {t('shipSidecarPath', { path: result.sidecarPaths[0] })}
          </p>
        )}
        {result.sidecarError && (
          <p className="mt-1 text-warning">
            {t('shipSidecarWarning', { error: result.sidecarError })}
          </p>
        )}
        <SkippedDrafts skipped={result.skipped} heading="shipSkipped" />
      </div>
    );
  }
  // bundle
  return (
    <div className="mt-2 rounded border border-warning/40 bg-warning/5 px-3 py-2 text-xs space-y-1">
      <div className="flex items-center gap-2">
        <Download className="h-3.5 w-3.5" />
        <strong>{t('shipBundleReady', { count: result.draftIds.length })}</strong>
        <span className="flex-1" />
        <button onClick={onDismiss} className="text-muted-foreground hover:underline">
          {t('shipDismiss')}
        </button>
      </div>
      <p>
        {t(result.kind === 'recipe' ? 'shipBundleHintRecipes' : 'shipBundleHintNames', {
          file: result.fileName,
        })}
      </p>
      <SkippedDrafts skipped={result.skipped} heading="shipBundleSkipped" />
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={() => saveJsonFile(result.fileName, result.content)}
          className="gap-2"
        >
          <Download className="h-3.5 w-3.5" />
          {t('shipBundleDownload')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => onMarkShipped(result.draftIds)}
          className="gap-2"
        >
          <Send className="h-3.5 w-3.5" />
          {t('shipBundleMarkShipped')}
        </Button>
      </div>
    </div>
  );
}
