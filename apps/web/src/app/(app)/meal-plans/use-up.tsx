// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { RebalanceResult, UseUpSuggestion, UseUpSuggestions } from '@diet-app/shared';
import { ModelSays, WeighButton, WeighedLine } from '@/components/weigh';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useAmount } from '@/lib/ingredient-format';
import { useErrorText } from '@/lib/use-error-text';
import { useFormat } from '@/lib/use-format';

/**
 * The swaps that would use up what a plan opens, asked for under the plan's
 * line of packs. The API finds them and counts what each would do; this
 * shows them, asks a model to weigh them when the reader wants that, and
 * makes the one the reader takes as any swap is made.
 */
export function UseUp({
  planId,
  aiEnabled,
  aiOffNote,
  mealName,
  busy,
  onSwapped,
  onStale,
}: {
  planId: string;
  aiEnabled: boolean;
  aiOffNote?: string;
  mealName: (mealType: string) => string;
  busy: boolean;
  /** Told what a swap that was made came to. */
  onSwapped: (result: RebalanceResult) => void;
  /** Told when the plan had changed under a suggestion: the page reads it anew. */
  onStale: () => void;
}) {
  const t = useTranslations('mealPlans.useUp');
  const tPlans = useTranslations('mealPlans');
  const fmt = useFormat();
  const amount = useAmount();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const [found, setFound] = useState<UseUpSuggestions | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ask = useMutation({
    mutationFn: (weigh: boolean) =>
      api.post<UseUpSuggestions>(`/meal-plans/${planId}/use-up`, { weigh }),
    onSuccess: (answer) => {
      setError(null);
      setFound(answer);
      if (answer.aiMeta) void qc.invalidateQueries({ queryKey: ['ai-quota'] });
    },
    onError: (e: unknown) => setError(errorText(e, t('errLoad'))),
  });
  const take = useMutation({
    mutationFn: (suggestion: UseUpSuggestion) =>
      api.post<RebalanceResult>('/meal-plans/swap-meal', {
        planId,
        plannedMealId: suggestion.plannedMealId,
        recipeId: suggestion.to.id,
        revision: found!.revision,
        strategy: 'random',
        allowOffDiet: false,
        // The note of a model's pick, where a model put this swap first: the meal then says who chose its recipe.
        ...(suggestion.pick ? { pick: suggestion.pick } : {}),
      }),
    onSuccess: (result) => {
      // The suggestions were for the plan as it was: they go with it.
      setFound(null);
      onSwapped(result);
    },
    onError: (e: unknown) => {
      setFound(null);
      onStale();
      setError(errorText(e, tPlans('errSwap')));
    },
  });
  const working = busy || ask.isPending || take.isPending;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={working}
          onClick={() => ask.mutate(false)}
        >
          {ask.isPending && !found ? t('asking') : t('ask')}
        </Button>
        {found && found.suggestions.length > 0 && (
          <WeighButton
            enabled={aiEnabled}
            offNote={aiOffNote}
            asking={ask.isPending}
            onAsk={() => ask.mutate(true)}
          />
        )}
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <WeighedLine aiMeta={found?.aiMeta ?? null} />
      {found && found.suggestions.length === 0 && <p>{t('none')}</p>}
      {found && found.suggestions.length > 0 && (
        <ul className="space-y-2">
          {found.suggestions.map((suggestion) => (
            <li
              key={`${suggestion.plannedMealId}-${suggestion.to.id}`}
              className="space-y-1 rounded-md border border-border p-2"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="text-foreground">
                  <span className="text-muted-foreground">
                    {fmt.day(suggestion.date)} · {mealName(suggestion.mealType)}:
                  </span>{' '}
                  {t.rich('swap', {
                    to: suggestion.to.title,
                    from: suggestion.from.title,
                    strong: (chunks) => <span className="font-medium">{chunks}</span>,
                  })}
                </p>
                <Button
                  type="button"
                  size="sm"
                  disabled={working}
                  onClick={() => take.mutate(suggestion)}
                >
                  {tPlans('offerTake')}
                </Button>
              </div>
              <ModelSays reason={suggestion.reason} />
              <p>
                {suggestion.takes
                  .map((taken) =>
                    t('takes', {
                      amount: amount(taken.amount, taken.unit),
                      name: taken.name,
                      left: amount(taken.left, taken.unit),
                    }),
                  )
                  .join(' · ')}
              </p>
              <p>
                {t('energy', {
                  before: suggestion.before.calories,
                  after: suggestion.after.calories,
                  proteinBefore: suggestion.before.protein,
                  proteinAfter: suggestion.after.protein,
                })}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
