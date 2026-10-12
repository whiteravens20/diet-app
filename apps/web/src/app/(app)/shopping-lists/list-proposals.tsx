// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { ListProposals as Proposals, ShoppingList } from '@diet-app/shared';
import { ModelSays, WeighButton, WeighedLine } from '@/components/weigh';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useAmount } from '@/lib/ingredient-format';
import { useErrorText } from '@/lib/use-error-text';
import { useFormat } from '@/lib/use-format';

/**
 * What a shopping list could do without, asked for on the list: rows that
 * one ingredient could stand for, and packs that will be left over. The API
 * works them out; this shows them, asks a model to weigh them when the reader
 * wants that, and leads to the plan, where a substitution is made.
 */
export function ListProposals({ list, profileId, aiEnabled, aiOffNote }: { list: ShoppingList; profileId: string | null; aiEnabled: boolean; aiOffNote?: string }) {
  const t = useTranslations('shoppingLists.proposals');
  const fmt = useFormat();
  const amount = useAmount();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const [found, setFound] = useState<Proposals | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ask = useMutation({
    mutationFn: (weigh: boolean) => api.post<Proposals>(`/shopping-lists/${list.id}/proposals`, { weigh }),
    onSuccess: (answer) => {
      setError(null);
      setFound(answer);
      if (answer.aiMeta) void qc.invalidateQueries({ queryKey: ['ai-quota'] });
    },
    onError: (e: unknown) => setError(errorText(e, t('errLoad'))),
  });
  /** The plan page, opened on the plan at a day of it. */
  const inThePlan = (date: string): string => `/meal-plans?${new URLSearchParams({ ...(profileId ? { profile: profileId } : {}), plan: list.planId, day: date })}`;

  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" disabled={ask.isPending} onClick={() => ask.mutate(false)}>
          {ask.isPending && !found ? t('asking') : t('ask')}
        </Button>
        {found && found.proposals.length > 0 && <WeighButton enabled={aiEnabled} offNote={aiOffNote} asking={ask.isPending} onAsk={() => ask.mutate(true)} />}
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <WeighedLine aiMeta={found?.aiMeta ?? null} />
      {found && found.proposals.length === 0 && <p className="text-muted-foreground">{t('none')}</p>}
      {found && found.proposals.length > 0 && (
        <ul className="space-y-2">
          {found.proposals.map((proposal) =>
            proposal.kind === 'merge' ? (
              <li key={`merge-${proposal.from.ingredientId}`} className="space-y-1 rounded-md border border-border p-2">
                <p>{t.rich('merge', { to: proposal.to.name, from: proposal.from.name, count: proposal.meals.length, packs: proposal.packsSaved, strong: (chunks) => <span className="font-medium">{chunks}</span> })}</p>
                <ModelSays reason={proposal.reason} />
                <ul className="text-xs text-muted-foreground">
                  {proposal.meals.map((meal) => (
                    <li key={meal.plannedMealId}>
                      {fmt.day(meal.date)} · {meal.title}
                    </li>
                  ))}
                </ul>
                <p className="text-xs">
                  <Link href={inThePlan(proposal.meals[0]!.date)} className="font-medium text-primary underline-offset-2 hover:underline">
                    {t('mergeHow')}
                  </Link>{' '}
                  <span className="text-muted-foreground">{t('mergeThen')}</span>
                </p>
              </li>
            ) : (
              <li key={`leftover-${proposal.ingredientId}`} className="space-y-1 rounded-md border border-border p-2">
                <p>{t.rich('leftover', { name: proposal.name, left: amount(proposal.left, proposal.unit), size: amount(proposal.packSize, proposal.unit), strong: (chunks) => <span className="font-medium">{chunks}</span> })}</p>
                <ModelSays reason={proposal.reason} />
                <p className="text-xs">
                  <Link href={inThePlan(list.fromDate)} className="font-medium text-primary underline-offset-2 hover:underline">
                    {t('leftoverHow')}
                  </Link>
                </p>
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}
