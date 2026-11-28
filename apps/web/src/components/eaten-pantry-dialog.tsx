// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { EatenPantry } from '@diet-app/shared';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { useShownAmount } from '@/lib/ingredient-format';
import { useErrorText } from '@/lib/use-error-text';

/** What the window asks: to take what was eaten, to give back what was taken, or that before an entry is removed. */
export type PantryQuestion = 'take' | 'give-back' | 'remove';

const TITLES = { take: 'takeTitle', 'give-back': 'giveBackTitle', remove: 'removeTitle' } as const;
const NOTES = { take: 'takeNote', 'give-back': 'giveBackNote', remove: 'removeNote' } as const;

/**
 * The window that takes what a meal or an entry ate off the pantry ("Zdejmij ze spiżarni to, co zjedzono"), or gives
 * back what it took ("Oddaj do spiżarni"): food by food, in the amounts the API shows, and nothing until it is
 * confirmed. A shared meal of a joint plan takes what its own person's pantry lacks off the other's, saying whose; eaten
 * by both, it is two portions, worked out together and taken on one press. Before an entry that took food is removed,
 * it offers to give that back first.
 */
export function EatenPantryDialog({
  ask,
  path,
  both,
  pantries,
  remove,
  onClose,
}: {
  ask: PantryQuestion;
  /** The meal's or the entry's own path (`/meal-plans/:id/meals/:mealId`, `/diary/entries/:id`). */
  path: string;
  /** Of a shared meal marked eaten for both: both portions, taken together. */
  both: boolean;
  /** What eating it does to the pantry: of each portion with something to say, this plan's first. */
  pantries: readonly EatenPantry[];
  /** Of a removal: removes the entry, once what it took is given back or not. */
  remove?: () => void;
  onClose: () => void;
}) {
  const t = useTranslations('eatenPantry');
  const tCommon = useTranslations('common');
  const shown = useShownAmount();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const write = useMutation({
    mutationFn: (to: 'take' | 'return') =>
      api.post<unknown>(`${path}/pantry-${to}${both ? '/both' : ''}`),
    onMutate: () => setError(null),
    onSettled: () =>
      // The pantry, and the diary's entries, which say whether they took food.
      Promise.all([
        qc.invalidateQueries({ queryKey: ['inventory'] }),
        qc.invalidateQueries({ queryKey: ['diary'] }),
      ]),
    onSuccess: () => {
      if (ask === 'remove') remove?.();
      onClose();
    },
    onError: (e, to) => setError(errorText(e, t(to === 'take' ? 'errTake' : 'errGiveBack'))),
  });
  const byPerson = pantries.length > 1;
  return (
    <Dialog open onClose={onClose} label={t(TITLES[ask])} className="max-w-md">
      <div className="space-y-3 p-4 text-sm">
        <h2 className="font-semibold">{t(TITLES[ask])}</h2>
        <p>{t(NOTES[ask])}</p>
        {byPerson && <p>{t('byPerson')}</p>}
        <div
          role="group"
          aria-label={t('foods')}
          // Scrolls on its own where the window would not fit the screen: the title and the buttons stay in sight, and
          // the window opens at its top, the list taking the focus before the buttons below it.
          className="max-h-[60vh] space-y-3 overflow-y-auto"
          tabIndex={0}
        >
          {pantries.map((pantry, at) => (
            // The portions of one meal, in the API's order: this plan's first.
            <div key={at} className="space-y-2">
              {byPerson && <h3 className="font-semibold">{pantry.profileName}</h3>}
              <ul className="space-y-2">
                {(ask === 'take' ? pantry.offer : pantry.taken).map((line) => (
                  <li key={line.ingredientId}>
                    {ask === 'take' ? (
                      <>
                        <span className="font-medium">{line.name}</span>
                        <span className="block text-muted-foreground">
                          {t('line', {
                            eaten: shown(line.eaten),
                            held: shown(line.held),
                            taken: shown(line.taken),
                          })}
                        </span>
                      </>
                    ) : (
                      <span>{t('takenLine', { name: line.name, taken: shown(line.taken) })}</span>
                    )}
                    {line.borrowed && (
                      <span className="block text-muted-foreground">
                        {t('borrowed', {
                          amount: shown(line.borrowed.amount),
                          name: line.borrowed.from,
                        })}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            {ask === 'take' ? t('notNow') : ask === 'give-back' ? t('keep') : tCommon('cancel')}
          </Button>
          {ask === 'remove' && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={write.isPending}
              onClick={() => {
                remove?.();
                onClose();
              }}
            >
              {t('removeOnly')}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            disabled={write.isPending}
            onClick={() => write.mutate(ask === 'take' ? 'take' : 'return')}
          >
            {t(ask === 'take' ? 'take' : ask === 'give-back' ? 'giveBack' : 'giveBackAndRemove')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
