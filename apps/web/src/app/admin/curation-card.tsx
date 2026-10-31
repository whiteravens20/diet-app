// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

/**
 * Curation queue card.
 *
 * Top-level tab strip switches between two pipelines that share the same
 * card chrome:
 *   - Ingredient-name drafts. One-line raw-FDC → friendly name
 *     editor with per-locale approve/reject.
 *   - Recipe drafts. Title / description / ingredient editor
 *     with live engine-recomputed nutrition + complexity chip.
 *
 * Both kinds use the single-flight runner pattern shared with `translate/`,
 * so the polling + state shape is identical apart from the recipe runner's
 * extra `complexityCounts` + `mixDrift` fields.
 */
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { ClipboardCheck } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { AdminOverview } from '@/lib/admin-api';
import { Explain } from './explain';
import { IngredientPanel } from './curation/ingredient-panel';
import { RecipePanel } from './curation/recipe-panel';
import { ReviewSignature, SignatureField } from './curation/review-signature';
import type { Kind } from './curation/shared';

export function CurationCard({
  kind,
  onKindChange,
  overview,
  onQueueChanged,
}: {
  kind: Kind;
  onKindChange: (kind: Kind) => void;
  /** How much waits in each queue; null until it is read. */
  overview: AdminOverview | null;
  /** A list was read: what it shows may have changed the counts. */
  onQueueChanged: () => void | Promise<void>;
}) {
  const t = useTranslations('admin.curation');
  // Both stay rendered once opened: a list's filters and page, and a run it follows, are there on coming back.
  const [opened, setOpened] = useState<ReadonlySet<Kind>>(() => new Set([kind]));
  if (!opened.has(kind)) setOpened(new Set([...opened, kind]));
  const names = overview?.names;
  const recipes = overview?.recipes;
  return (
    <ReviewSignature>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2">
              <ClipboardCheck className="h-5 w-5" />
              {t('title')}
            </CardTitle>
            <KindTabs
              kind={kind}
              onChange={onKindChange}
              names={names ? names.pending + names.rejected + names.approved : 0}
              recipes={recipes ? recipes.pending + recipes.approved : 0}
            />
          </div>
          <Explain>
            <p>{kind === 'ingredient-names' ? t('explain') : t('explainRecipes')}</p>
          </Explain>
        </CardHeader>
        <CardContent className="space-y-4">
          <SignatureField />
          <div hidden={kind !== 'ingredient-names'} className="space-y-4">
            {opened.has('ingredient-names') && (
              <IngredientPanel queue={names ?? null} onQueueChanged={onQueueChanged} />
            )}
          </div>
          <div hidden={kind !== 'recipes'} className="space-y-4">
            {opened.has('recipes') && <RecipePanel onQueueChanged={onQueueChanged} />}
          </div>
        </CardContent>
      </Card>
    </ReviewSignature>
  );
}

function KindTabs({
  kind,
  onChange,
  names,
  recipes,
}: {
  kind: Kind;
  onChange: (k: Kind) => void;
  names: number;
  recipes: number;
}) {
  const t = useTranslations('admin.curation');
  const opts: { value: Kind; label: string; count: number }[] = [
    { value: 'ingredient-names', label: t('kindIngredients'), count: names },
    { value: 'recipes', label: t('kindRecipes'), count: recipes },
  ];
  return (
    <div className="flex gap-1 text-xs">
      {opts.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === kind}
          onClick={() => onChange(o.value)}
          className={
            o.value === kind
              ? 'rounded-full bg-primary px-3 py-1 text-primary-foreground'
              : 'rounded-full border border-border px-3 py-1 hover:bg-muted'
          }
        >
          {o.label}
          {o.count > 0 && (
            <>
              <span aria-hidden className="ml-1.5 tabular-nums">
                {o.count}
              </span>
              <span className="sr-only">{`, ${t('waitingCount', { count: o.count })}`}</span>
            </>
          )}
        </button>
      ))}
    </div>
  );
}
