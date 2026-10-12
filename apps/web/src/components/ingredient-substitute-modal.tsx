// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type {
  AiSuggestIngredientResponse,
  Ingredient,
  PlannedIngredient,
  SessionUser,
  SubstituteSuggestion,
  SwapIngredientRequest,
  SwapIngredientResponse,
  SwapPreview,
} from '@diet-app/shared';
import { api } from '@/lib/api';
import { useErrorText } from '@/lib/use-error-text';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAmount } from '@/lib/ingredient-format';
import { useFormat } from '@/lib/use-format';

interface PlannedMealLike {
  id: string;
  recipe: {
    id: string;
    title: string;
  };
  /** What the meal takes of each ingredient, as the API scaled and rounded it. */
  ingredients: PlannedIngredient[];
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
  onApplied: (result: SwapIngredientResponse) => void;
}) {
  const qc = useQueryClient();
  const t = useTranslations('swap');
  const worded = useErrorText();
  const tCommon = useTranslations('common');
  const tPickers = useTranslations('pickers');
  const tProf = useTranslations('profileSummary');
  const tFallback = useTranslations('aiFallback');
  const amount = useAmount();
  const [fromId, setFromId] = useState<string | null>(null);
  const [toId, setToId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // What the model said about its suggestion.
  const [aiReason, setAiReason] = useState<string | null>(null);
  // AI-suggested ingredient injected into the candidate list so its name
  // renders without an extra search round-trip.
  const [aiPick, setAiPick] = useState<Ingredient | null>(null);
  // Off unless the user asks: a rewording costs one of their AI requests.
  const [rewriteWithAi, setRewriteWithAi] = useState(false);
  // A substitution that moves what a serving holds by more than a tenth is made only when the user says so.
  const [acceptChange, setAcceptChange] = useState(false);
  // What the API refused with, in the reader's language where the code is known.

  const session = useQuery({
    queryKey: ['session'],
    queryFn: () => api.get<SessionUser>('/users/me'),
  });
  const aiEnabled = session.data?.aiMode && session.data.aiMode !== 'none';

  const fromLine = meal.ingredients.find((i) => i.ingredientId === fromId) ?? null;

  // What the catalogue's own rules name for the ingredients of this meal: no model is asked.
  const suggestions = useQuery({
    queryKey: ['substitutes', planId, meal.id],
    queryFn: () => api.get<SubstituteSuggestion[]>(`/meal-plans/${planId}/meals/${meal.id}/substitutes`),
  });
  const suggestion = (suggestions.data ?? []).find((s) => s.fromIngredientId === fromId) ?? null;

  // Replacement candidates — only fire once the user has typed something.
  const results = useQuery({
    queryKey: ['ingredients-search', search],
    queryFn: () => api.get<Ingredient[]>(`/ingredients?search=${encodeURIComponent(search)}`),
    enabled: search.trim().length >= 2,
  });
  const searchCandidates = (results.data ?? [])
    .filter((i) => i.id !== fromId)
    .slice(0, 20);
  // What was suggested, by the catalogue or by a model, stands above what the
  // search found, so the user sees it and can still look for something else.
  const picks = [suggestion?.to, aiPick].filter((pick): pick is Ingredient => Boolean(pick) && pick!.id !== fromId);
  const candidates = [...picks.filter((pick, i) => picks.findIndex((other) => other.id === pick.id) === i), ...searchCandidates.filter((c) => !picks.some((pick) => pick.id === c.id))];

  const aiSuggest = useMutation({
    mutationFn: () =>
      api.post<AiSuggestIngredientResponse>('/meal-plans/swap-ingredient/ai-suggest', {
        planId,
        plannedMealId: meal.id,
        fromIngredientId: fromId!,
      }),
    onSuccess: (res) => {
      setAiPick(res.toIngredient);
      setToId(res.toIngredient.id);
      qc.invalidateQueries({ queryKey: ['ai-quota'] });
      const reason = res.aiMeta.fallbackReason;
      setNotice(reason ? tFallback(reason) : null);
      setAiReason(res.aiMeta.reason);
    },
    onError: (e) => setError(worded(e, t('aiSuggestFailed'))),
  });

  // Delta preview — run when the user has both ends picked.
  const preview = useQuery({
    queryKey: ['swap-ingredient-preview', meal.id, fromId, toId],
    queryFn: () =>
      api.post<SwapPreview>('/meal-plans/swap-ingredient/preview', {
        planId,
        plannedMealId: meal.id,
        fromIngredientId: fromId!,
        toIngredientId: toId!,
        rewriteWithAi: false,
        acceptChange: false,
      } satisfies SwapIngredientRequest),
    enabled: Boolean(fromId && toId),
  });

  const apply = useMutation({
    mutationFn: () =>
      api.post<SwapIngredientResponse>('/meal-plans/swap-ingredient/apply', {
        planId,
        plannedMealId: meal.id,
        fromIngredientId: fromId!,
        toIngredientId: toId!,
        rewriteWithAi: Boolean(aiEnabled) && rewriteWithAi,
        acceptChange,
      } satisfies SwapIngredientRequest),
    onSuccess: (result) => {
      // Refresh whichever plan list is currently rendered so the meal card
      // picks up the new recipe variant and its recomputed nutrition.
      qc.invalidateQueries({ queryKey: ['meal-plans'] });
      if (result.aiMeta) qc.invalidateQueries({ queryKey: ['ai-quota'] });
      onApplied(result);
      onClose();
    },
    onError: (e) => setError(worded(e, t('applyFailed'))),
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
              {meal.ingredients.map((i) => {
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
                        setAcceptChange(false);
                        setToId(null);
                        setSearch('');
                        setError(null);
                        setNotice(null);
                        setAiReason(null);
                        setAiPick(null);
                      }}
                    >
                      <span>{i.name}</span>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {amount(i.display.quantity, i.display.unit)}
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
                  name: fromLine.name,
                  strong: (chunks) => <span className="text-primary">{chunks}</span>,
                })}
              </p>
              <div className="flex gap-2">
                <Input
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setToId(null);
                  }}
                  placeholder={tPickers('ingredientSearch')}
                />
                {aiEnabled && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    title={t('tooltipAiSuggest')}
                    onClick={() => {
                      setError(null);
                      setNotice(null);
                      setAiReason(null);
                      aiSuggest.mutate();
                    }}
                    disabled={aiSuggest.isPending}
                    className="text-primary"
                  >
                    <Sparkles size={14} aria-hidden />
                    <span className="ml-1">
                      {aiSuggest.isPending ? t('aiSuggestPending') : t('aiSuggest')}
                    </span>
                  </Button>
                )}
              </div>
              {notice && (
                <p
                  className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
                  role="status"
                >
                  {notice}
                </p>
              )}
              {aiReason && (
                <p
                  className="mt-2 rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-xs text-primary"
                  role="status"
                >
                  {t('aiReason', { reason: aiReason })}
                </p>
              )}
              {suggestion && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {t('catalogueSuggests')}{' '}
                  <button
                    type="button"
                    className="font-medium text-primary hover:underline"
                    onClick={() => {
                      setToId(suggestion.to.id);
                      setAcceptChange(false);
                    }}
                  >
                    {suggestion.to.name}
                  </button>
                </p>
              )}
              {(search.trim().length >= 2 || picks.length > 0) && (
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
                        className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-muted ${
                          c.id === toId ? 'bg-muted/60' : ''
                        }`}
                        onClick={() => {
                          setToId(c.id);
                          setAcceptChange(false);
                        }}
                      >
                        <span>{c.name}</span>
                        {aiPick?.id === c.id && (
                          <Sparkles size={12} className="text-primary" aria-hidden />
                        )}
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
              {preview.error && <p className="text-xs text-destructive">{worded(preview.error, t('previewFailed'))}</p>}
              {preview.data && (
                <>
                  <p className="text-xs text-muted-foreground">
                    {t(`sizing.${preview.data.sizing}`, {
                      fromAmount: amount(preview.data.from.display.quantity, preview.data.from.display.unit),
                      fromName: preview.data.from.name,
                      toAmount: amount(preview.data.to.display.quantity, preview.data.to.display.unit),
                      toName: preview.data.to.name,
                    })}
                  </p>
                  {preview.data.merged && <p className="mt-1 text-xs text-muted-foreground">{t('merged', { name: preview.data.to.name })}</p>}
                  <dl className="mt-2 grid grid-cols-4 gap-2 text-xs">
                    <Delta label={tProf('kcal')} before={preview.data.before.calories} after={preview.data.after.calories} />
                    <Delta label={tProf('protein').toLowerCase()} before={preview.data.before.protein} after={preview.data.after.protein} grams />
                    <Delta label={tProf('fat').toLowerCase()} before={preview.data.before.fat} after={preview.data.after.fat} grams />
                    <Delta label={tProf('carbs').toLowerCase()} before={preview.data.before.carbs} after={preview.data.after.carbs} grams />
                  </dl>
                  {!preview.data.valid && (
                    <div className="mt-2 text-xs text-destructive" role="alert">
                      <p>{t('invalid')}</p>
                      <ul className="list-disc pl-5">
                        {preview.data.violations.map((violation) => (
                          <li key={violation}>{t(`violation.${violation}`)}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {preview.data.valid && preview.data.moved.length > 0 && (
                    <div className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                      <p>{t('moved', { what: preview.data.moved.map((key) => t(`movedName.${key}`)).join(', ') })}</p>
                      <label className="mt-1 flex items-center gap-2">
                        <input type="checkbox" checked={acceptChange} onChange={(e) => setAcceptChange(e.target.checked)} />
                        {t('acceptChange')}
                      </label>
                    </div>
                  )}
                </>
              )}
              {aiEnabled && (
                <label className="mt-3 flex items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={rewriteWithAi}
                    onChange={(e) => setRewriteWithAi(e.target.checked)}
                  />
                  <span>
                    {t('rewriteWithAi')}
                    <span className="block text-muted-foreground">{t('rewriteWithAiHint')}</span>
                  </span>
                </label>
              )}
              <div className="mt-3 flex items-center justify-end gap-2">
                {error && <span className="text-xs text-destructive">{error}</span>}
                <Button
                  type="button"
                  disabled={
                    !preview.data?.valid ||
                    (preview.data.moved.length > 0 && !acceptChange) ||
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

function Delta({ label, before, after, grams = false }: { label: string; before: number; after: number; grams?: boolean }) {
  const fmt = useFormat();
  const shown = (value: number): string => (grams ? fmt.unit(value, 'gram', 1) : fmt.number(value));
  // Rounded as it is shown, so that the difference is the one between the two numbers on screen.
  const diff = Math.round((after - before) * 10) / 10;
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">
        {shown(before)} → {shown(after)}
        <span className={diff === 0 ? '' : diff > 0 ? ' text-destructive' : ' text-primary'}>
          {' '}
          ({diff > 0 ? '+' : ''}
          {shown(diff)})
        </span>
      </dd>
    </div>
  );
}
