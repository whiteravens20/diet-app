// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { FileUp, ListChecks, Upload } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useId, useState } from 'react';
import type {
  ImportRejection,
  MealType,
  RecipeImportResult,
  StoredImportRejection,
} from '@diet-app/shared';
import { MEAL_TYPES, MOST_IMPORT_BYTES, MOST_RECIPES_PER_IMPORT } from '@diet-app/shared/constants';
import { Button } from '@/components/ui/button';
import { adminApi } from '@/lib/admin-api';
import { useDraftErrorText, useProblemLine } from '@/lib/use-draft-error';
import { useFormat } from '@/lib/use-format';

/**
 * Why a recipe was not taken, in the reader's language: the rule in words,
 * with what it is about. A reason this version has no words for is shown as
 * the API wrote it.
 */
function useImportReasonText(): (reason: string) => string {
  const t = useTranslations('admin.curation.import.reasons');
  const problemLine = useProblemLine();
  return useCallback(
    (reason) => {
      const at = reason.indexOf(': ');
      const rule = at === -1 ? reason : reason.slice(0, at);
      if (!t.has(rule)) return reason;
      let detail = at === -1 ? '' : reason.slice(at + 2);
      if (rule === 'invalid-draft') {
        // Each entry is `<path>: <rule>`, as a refused edit names its problems.
        detail = detail
          .split('; ')
          .map((entry) => {
            const cut = entry.lastIndexOf(': ');
            return cut === -1
              ? entry
              : problemLine({ path: entry.slice(0, cut), rule: entry.slice(cut + 2) });
          })
          .join('; ');
      }
      return t(rule, { detail });
    },
    [t, problemLine],
  );
}

/** The recipes an import did not take, each with its reasons. */
function Refused({ rejected }: { rejected: readonly ImportRejection[] }) {
  const reasonText = useImportReasonText();
  return (
    <ul className="space-y-1.5 text-xs">
      {rejected.map((rejection, index) => (
        <li key={`${rejection.title}-${index}`}>
          <span className="font-medium text-foreground">{rejection.title}</span>
          <ul className="ml-4 list-disc text-muted-foreground">
            {rejection.reasons.map((reason, at) => (
              // Two lines of a recipe can be refused for the same reason, in the same words.
              <li key={`${at}-${reason}`}>{reasonText(reason)}</li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

/**
 * Taking recipes in from a document the operator has: the document, what
 * holds for a recipe of it that does not say so itself, a look at what would
 * come of it, and the import. What an import refused is kept and shown below,
 * so that a name can be written down for an ingredient and the document sent
 * again.
 */
export function RecipeImport({ onImported }: { onImported: () => void | Promise<void> }) {
  const t = useTranslations('admin.curation.import');
  const tMeal = useTranslations('enums.mealType');
  const fmt = useFormat();
  const errorText = useDraftErrorText();
  const titleId = useId();
  const documentId = useId();
  const sourceId = useId();
  const licenceId = useId();
  const [text, setText] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [license, setLicense] = useState('');
  const [meals, setMeals] = useState<MealType[]>([]);
  const [busy, setBusy] = useState<'look' | 'import' | null>(null);
  const [result, setResult] = useState<RecipeImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kept, setKept] = useState<StoredImportRejection[]>([]);

  const readKept = useCallback(async (): Promise<void> => {
    try {
      setKept(await adminApi.importRejections());
    } catch {
      // What was refused before is a convenience: the import itself says what it refused.
    }
  }, []);
  useEffect(() => {
    void (async () => {
      await readKept();
    })();
  }, [readKept]);

  const send = async (dryRun: boolean): Promise<void> => {
    setError(null);
    setResult(null);
    const request = {
      document: text,
      ...(sourceUrl.trim() ? { sourceUrl: sourceUrl.trim() } : {}),
      ...(license.trim() ? { license: license.trim() } : {}),
      ...(meals.length > 0 ? { mealTypes: meals } : {}),
      dryRun,
    };
    // The request as it will be sent: the document is written into it as a text, which makes it longer than the document.
    if (new Blob([JSON.stringify(request)]).size > MOST_IMPORT_BYTES) {
      setError(t('tooLarge', { kilobytes: Math.floor(MOST_IMPORT_BYTES / 1000) }));
      return;
    }
    setBusy(dryRun ? 'look' : 'import');
    try {
      const answer = await adminApi.importRecipes(request);
      setResult(answer);
      if (!dryRun) {
        await readKept();
        await onImported();
      }
    } catch (err) {
      setError(errorText(err, t('failed')));
    } finally {
      setBusy(null);
    }
  };

  const fromFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    setError(null);
    setResult(null);
    setText(await file.text());
  };

  const clearKept = async (): Promise<void> => {
    try {
      await adminApi.clearImportRejections();
      setKept([]);
    } catch (err) {
      setError(errorText(err, t('failed')));
    }
  };

  return (
    <section aria-labelledby={titleId} className="space-y-3 rounded-md border border-border p-3">
      <h3 id={titleId} className="text-sm font-medium">
        {t('title')}
      </h3>
      <p className="text-xs text-muted-foreground">
        {t('hint', { most: MOST_RECIPES_PER_IMPORT })}
      </p>

      <div className="space-y-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label htmlFor={documentId} className="text-xs font-medium">
            {t('document')}
          </label>
          <label className="inline-flex cursor-pointer items-center gap-1 text-xs text-primary underline underline-offset-2">
            <FileUp className="h-3.5 w-3.5" />
            {t('fromFile')}
            <input
              type="file"
              accept="application/json,application/ld+json,.json,.jsonld"
              className="sr-only"
              onChange={(e) => void fromFile(e.target.files?.[0])}
            />
          </label>
        </div>
        <textarea
          id={documentId}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          spellCheck={false}
          placeholder='{ "@type": "Recipe", "name": "…", "recipeIngredient": ["200 g …"], … }'
          className="w-full rounded-md border border-input bg-background px-2 py-1 font-mono text-xs"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label htmlFor={sourceId} className="text-xs font-medium">
            {t('sourceUrl')}
          </label>
          <input
            id={sourceId}
            type="url"
            value={sourceUrl}
            onChange={(e) => setSourceUrl(e.target.value)}
            placeholder="https://"
            className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor={licenceId} className="text-xs font-medium">
            {t('licence')}
          </label>
          <input
            id={licenceId}
            type="text"
            value={license}
            onChange={(e) => setLicense(e.target.value)}
            maxLength={200}
            placeholder="CC BY 4.0"
            className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{t('defaultsHint')}</p>

      <fieldset>
        <legend className="text-xs font-medium">{t('meals')}</legend>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
          {MEAL_TYPES.map((meal) => (
            <label key={meal} className="flex min-h-6 items-center gap-1 text-xs">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={meals.includes(meal)}
                onChange={(e) =>
                  setMeals(
                    e.target.checked ? [...meals, meal] : meals.filter((other) => other !== meal),
                  )
                }
              />
              {tMeal(meal)}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void send(true)}
          disabled={busy !== null || text.trim() === ''}
          className="gap-2"
        >
          <ListChecks className="h-4 w-4" />
          {busy === 'look' ? t('looking') : t('look')}
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => void send(false)}
          disabled={busy !== null || text.trim() === ''}
          className="gap-2"
        >
          <Upload className="h-4 w-4" />
          {busy === 'import' ? t('importing') : t('import')}
        </Button>
      </div>

      <div role="status" className="space-y-2">
        {error && <p className="text-xs text-destructive">{error}</p>}
        {result && (
          <>
            <p className="text-xs">
              {t(result.dryRun ? 'wouldCome' : 'came', {
                found: result.found,
                drafted: result.drafted.length,
                rejected: result.rejected.length,
              })}
            </p>
            {result.found > MOST_RECIPES_PER_IMPORT && (
              <p className="text-xs">
                {t('beyond', {
                  count: result.found - MOST_RECIPES_PER_IMPORT,
                  most: MOST_RECIPES_PER_IMPORT,
                })}
              </p>
            )}
            {result.drafted.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {fmt.list(result.drafted.map((draft) => draft.title))}
              </p>
            )}
            {result.rejected.length > 0 && <Refused rejected={result.rejected} />}
          </>
        )}
      </div>

      {kept.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer select-none font-medium">
            {t('kept', { count: kept.length })}
          </summary>
          <div className="mt-2 space-y-2">
            <p className="text-muted-foreground">{t('keptHint')}</p>
            <Refused rejected={kept} />
            <Button type="button" size="sm" variant="ghost" onClick={() => void clearKept()}>
              {t('clearKept')}
            </Button>
          </div>
        </details>
      )}
    </section>
  );
}
