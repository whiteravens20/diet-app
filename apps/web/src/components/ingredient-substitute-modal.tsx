'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type {
  Ingredient,
  MealPlan,
  RecipeIngredient,
  SwapIngredientRequest,
  SwapPreview,
} from '@diet-app/shared';
import { api, ApiClientError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatIngredientAmount } from '@/lib/ingredient-format';

interface PlannedMealLike {
  id: string;
  servings: number;
  recipe: {
    id: string;
    title: string;
    servings: number;
    ingredients: RecipeIngredient[];
  };
}

/**
 * Modal that walks the user through substituting one ingredient in a planned
 * meal. Steps: pick the source line → search a replacement → see the deterministic
 * delta preview → Apply, which clones the recipe with the swap baked in.
 *
 * The parent owns the open/close state and the mutation result (it invalidates
 * the meal-plans query after Apply).
 */
export function IngredientSubstituteModal({
  meal,
  planId,
  onClose,
  onApplied,
}: {
  meal: PlannedMealLike;
  planId: string;
  onClose: () => void;
  onApplied: (plan: MealPlan) => void;
}) {
  const qc = useQueryClient();
  const t = useTranslations('swap');
  const tCommon = useTranslations('common');
  const tPickers = useTranslations('pickers');
  const tProf = useTranslations('profileSummary');
  const [fromId, setFromId] = useState<string | null>(null);
  const [toId, setToId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);

  const fromLine = meal.recipe.ingredients.find((i) => i.ingredientId === fromId) ?? null;

  // Replacement candidates — only fire once the user has typed something.
  const results = useQuery({
    queryKey: ['ingredients-search', search],
    queryFn: () => api.get<Ingredient[]>(`/ingredients?search=${encodeURIComponent(search)}`),
    enabled: search.trim().length >= 2,
  });
  const candidates = (results.data ?? [])
    .filter((i) => i.id !== fromId)
    .slice(0, 20);

  // Delta preview — run when the user has both ends picked.
  const preview = useQuery({
    queryKey: ['swap-ingredient-preview', meal.id, fromId, toId],
    queryFn: () =>
      api.post<SwapPreview>('/meal-plans/swap-ingredient/preview', {
        planId,
        plannedMealId: meal.id,
        fromIngredientId: fromId!,
        toIngredientId: toId!,
      } satisfies SwapIngredientRequest),
    enabled: Boolean(fromId && toId),
  });

  const apply = useMutation({
    mutationFn: () =>
      api.post<MealPlan>('/meal-plans/swap-ingredient/apply', {
        planId,
        plannedMealId: meal.id,
        fromIngredientId: fromId!,
        toIngredientId: toId!,
      } satisfies SwapIngredientRequest),
    onSuccess: (plan) => {
      // Refresh whichever plan list is currently rendered so the meal card
      // picks up the new recipe variant and its recomputed nutrition.
      qc.invalidateQueries({ queryKey: ['meal-plans'] });
      onApplied(plan);
      onClose();
    },
    onError: (e) =>
      setError(e instanceof ApiClientError ? e.message : t('applyFailed')),
  });

  // The replacement ingredient name (for the preview header).
  const toIngredient = candidates.find((c) => c.id === toId) ?? null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl rounded-lg border border-border bg-background shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border p-4">
          <div>
            <h2 className="font-semibold">{t('title')}</h2>
            <p className="text-xs text-muted-foreground">{meal.recipe.title}</p>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            {tCommon('close')}
          </Button>
        </div>

        <div className="space-y-4 p-4">
          {/* Step 1 — pick the source line. */}
          <section>
            <p className="mb-1 text-sm font-medium">{t('stepPick')}</p>
            <ul className="divide-y divide-border rounded-md border border-border">
              {meal.recipe.ingredients.map((i) => {
                const scale = meal.servings / Math.max(meal.recipe.servings, 1);
                const selected = i.ingredientId === fromId;
                return (
                  <li key={i.ingredientId}>
                    <button
                      type="button"
                      className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted ${
                        selected ? 'bg-muted/60' : ''
                      }`}
                      onClick={() => {
                        setFromId(i.ingredientId);
                        setToId(null);
                        setSearch('');
                        setError(null);
                      }}
                    >
                      <span>{i.name}</span>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {formatIngredientAmount(i, scale)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>

          {/* Step 2 — search a replacement. */}
          {fromLine && (
            <section>
              <p className="mb-1 text-sm font-medium">
                {t.rich('stepReplace', {
                  name: () => <span className="text-primary">{fromLine.name}</span>,
                })}
              </p>
              <Input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setToId(null);
                }}
                placeholder={tPickers('ingredientSearch')}
              />
              {search.trim().length >= 2 && (
                <ul className="mt-1 max-h-48 overflow-y-auto rounded-md border border-border">
                  {candidates.length === 0 && !results.isLoading && (
                    <li className="px-3 py-2 text-xs text-muted-foreground">
                      {tPickers('noMatches')}
                    </li>
                  )}
                  {candidates.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        className={`w-full px-3 py-1.5 text-left text-sm hover:bg-muted ${
                          c.id === toId ? 'bg-muted/60' : ''
                        }`}
                        onClick={() => setToId(c.id)}
                      >
                        {c.name}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {/* Step 3 — delta preview + apply. */}
          {fromLine && toId && (
            <section className="rounded-md border border-border bg-muted/30 p-3 text-sm">
              <p className="mb-1 text-sm font-medium">{t('stepDelta')}</p>
              {preview.isLoading && (
                <p className="text-xs text-muted-foreground">{t('computing')}</p>
              )}
              {preview.error && (
                <p className="text-xs text-destructive">
                  {preview.error instanceof ApiClientError
                    ? preview.error.message
                    : t('previewFailed')}
                </p>
              )}
              {preview.data && (
                <>
                  <p className="text-xs text-muted-foreground">{preview.data.explanation}</p>
                  <dl className="mt-2 grid grid-cols-4 gap-2 text-xs">
                    <Delta label={tProf('kcal')} before={preview.data.before.calories} after={preview.data.after.calories} />
                    <Delta label={tProf('protein').toLowerCase()} before={preview.data.before.protein} after={preview.data.after.protein} suffix=" g" />
                    <Delta label={tProf('fat').toLowerCase()} before={preview.data.before.fat} after={preview.data.after.fat} suffix=" g" />
                    <Delta label={tProf('carbs').toLowerCase()} before={preview.data.before.carbs} after={preview.data.after.carbs} suffix=" g" />
                  </dl>
                  {!preview.data.valid && (
                    <p className="mt-2 text-xs text-destructive">{t('invalid')}</p>
                  )}
                </>
              )}
              <div className="mt-3 flex items-center justify-end gap-2">
                {error && <span className="text-xs text-destructive">{error}</span>}
                <Button
                  type="button"
                  disabled={
                    !preview.data?.valid ||
                    apply.isPending ||
                    !toIngredient
                  }
                  onClick={() => {
                    setError(null);
                    apply.mutate();
                  }}
                >
                  {apply.isPending ? t('applying') : t('apply')}
                </Button>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function Delta({
  label,
  before,
  after,
  suffix = '',
}: {
  label: string;
  before: number;
  after: number;
  suffix?: string;
}) {
  const diff = after - before;
  const sign = diff > 0 ? '+' : '';
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">
        {before}
        {suffix} → {after}
        {suffix}
        <span className={diff === 0 ? '' : diff > 0 ? ' text-destructive' : ' text-primary'}>
          {' '}
          ({sign}
          {diff}
          {suffix})
        </span>
      </dd>
    </div>
  );
}
