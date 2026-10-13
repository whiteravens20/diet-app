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
import {
  ClipboardCheck,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { IngredientPanel } from './curation/ingredient-panel';
import { RecipePanel } from './curation/recipe-panel';
import type { Kind } from './curation/shared';

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
