// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import type { Ingredient, RetiredIngredient } from '@diet-app/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { adminApi } from '@/lib/admin-api';
import { useErrorText } from '@/lib/use-error-text';
import { useFormat } from '@/lib/use-format';
import { Explain } from './explain';

/**
 * The retired ingredients something of the instance still uses. A database
 * update moves what uses one to the curated ingredient that is the same food,
 * where the data names one; for the rest the administrator chooses an
 * ingredient of the catalogue here. The card is not shown while there are none.
 */
export function RetiredIngredientsCard({
  onChanged,
}: {
  /** One is replaced: how many are left has changed. */
  onChanged?: () => void | Promise<void>;
} = {}) {
  const t = useTranslations('admin.retired');
  const errorText = useErrorText();
  const [retired, setRetired] = useState<RetiredIngredient[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRetired(await adminApi.retiredIngredients());
    } catch (err) {
      setError(errorText(err, String(err)));
    }
  }, [errorText]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  if (!retired || (retired.length === 0 && !done && !error)) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <Explain>
          <p>{t('explain')}</p>
        </Explain>
        {error && (
          <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs">
            {error}
          </p>
        )}
        {done && <p className="text-xs text-success">{done}</p>}
        <ul className="space-y-3">
          {retired.map((ingredient) => (
            <RetiredRow
              key={ingredient.id}
              ingredient={ingredient}
              onReplaced={(summary) => {
                setError(null);
                setDone(summary);
                void load();
                void onChanged?.();
              }}
              onRefused={(message) => {
                setDone(null);
                setError(message);
                void load();
              }}
            />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function RetiredRow({
  ingredient,
  onReplaced,
  onRefused,
}: {
  ingredient: RetiredIngredient;
  onReplaced: (summary: string) => void;
  onRefused: (message: string) => void;
}) {
  const t = useTranslations('admin.retired');
  const errorText = useErrorText();
  const fmt = useFormat();
  const [choosing, setChoosing] = useState(false);
  const [search, setSearch] = useState('');
  const [found, setFound] = useState<Ingredient[]>([]);
  const [working, setWorking] = useState(false);

  // The catalogue is asked once the typing stops, for a name of two letters or more.
  useEffect(() => {
    const words = search.trim();
    if (!choosing || words.length < 2) return;
    let current = true;
    const asked = setTimeout(() => {
      adminApi
        .searchIngredients(words)
        .then((ingredients) => {
          if (current) setFound(ingredients.filter((one) => one.id !== ingredient.id).slice(0, 8));
        })
        .catch(() => {
          if (current) setFound([]);
        });
    }, 250);
    return () => {
      current = false;
      clearTimeout(asked);
    };
  }, [choosing, search, ingredient.id]);

  const replaceWith = async (by: Ingredient) => {
    if (!window.confirm(t('confirm', { from: ingredient.name, to: by.name }))) return;
    setWorking(true);
    try {
      const moved = await adminApi.replaceIngredient(ingredient.id, by.id);
      onReplaced(
        t('replaced', {
          from: ingredient.name,
          to: by.name,
          lines: moved.recipeLines,
          drafts: moved.draftLines,
          pantry: moved.pantryRows,
          profiles: moved.preferences,
          rows: moved.shoppingRows,
        }),
      );
    } catch (err) {
      onRefused(errorText(err, t('replaceFailed')));
    } finally {
      setWorking(false);
    }
  };

  return (
    <li className="rounded-md border border-border p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">{ingredient.name}</p>
          <p className="break-all font-mono text-xs text-muted-foreground">{ingredient.slug}</p>
          <p className="text-xs text-muted-foreground">
            {t('retiredOn', { when: fmt.dayOf(ingredient.retiredAt) })}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={working}
          aria-expanded={choosing}
          onClick={() => setChoosing((open) => !open)}
        >
          {t('replace')}
        </Button>
      </div>
      <p className="mt-2 text-xs">{t('uses', ingredient.uses)}</p>
      {ingredient.usedIn.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {t('usedIn', { list: ingredient.usedIn.join(', ') })}
        </p>
      )}
      {choosing && (
        <div className="mt-2 space-y-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchLabel', { name: ingredient.name })}
          />
          {search.trim().length >= 2 && found.length > 0 && (
            <ul className="flex flex-wrap gap-1">
              {found.map((candidate) => (
                <li key={candidate.id}>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={working}
                    onClick={() => void replaceWith(candidate)}
                  >
                    {candidate.name}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">{t('textNote')}</p>
        </div>
      )}
    </li>
  );
}
