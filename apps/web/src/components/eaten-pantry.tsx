// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import dynamic from 'next/dynamic';
import { useState, type ReactNode } from 'react';
import type { EatenPantry } from '@diet-app/shared';
import { api } from '@/lib/api';
import type { PantryQuestion, Portion } from './eaten-pantry-dialog';

/** Fetched once there is something to ask: no first visit of a page waits for the window. */
const EatenPantryDialog = dynamic(
  () => import('./eaten-pantry-dialog').then((dialog) => dialog.EatenPantryDialog),
  { ssr: false },
);

interface Asked {
  ask: PantryQuestion;
  portions: Portion[];
  remove?: () => void;
}

/**
 * What eating a meal of a plan, or an entry of the diary, does to the pantry, asked once the change is through: a mark
 * set or an entry written opens the window that offers to take what was eaten off the pantry, a mark taken back the
 * one that offers to give back what was taken, and the removal of an entry that took food asks first. The window
 * opens only where the API says there is something to take or to give back: on a day a shopping list covers it
 * says nothing. Where the API cannot be asked, nothing is asked and nothing changes.
 */
export function useEatenPantry(): {
  /**
   * Of the meal or the entry at `paths` (or each person's meal of a meal eaten by both): after a mark set or an entry
   * written (`take`), after a mark taken back (`give-back`), or before an entry that took food is removed (`remove`,
   * with what removes it, once what it took is given back or not; at once where nothing is to be given back).
   */
  ask: (paths: string | readonly string[], question: PantryQuestion, remove?: () => void) => void;
  dialog: ReactNode;
} {
  const [asked, setAsked] = useState<Asked | null>(null);
  const ask = (paths: string | readonly string[], question: PantryQuestion, remove?: () => void) =>
    void Promise.all(
      [paths].flat().map((path) =>
        api.get<EatenPantry>(`${path}/pantry`).then(
          (pantry) => ({ path, pantry }),
          () => null,
        ),
      ),
    ).then((read) => {
      const portions = read.filter(
        (one): one is Portion =>
          one !== null && (question === 'take' ? one.pantry.offer : one.pantry.taken).length > 0,
      );
      if (portions.length > 0) setAsked({ ask: question, portions, remove });
      else remove?.();
    });
  return {
    ask,
    dialog: asked && <EatenPantryDialog {...asked} onClose={() => setAsked(null)} />,
  };
}
