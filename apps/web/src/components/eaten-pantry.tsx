// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import dynamic from 'next/dynamic';
import { useState, type ReactNode } from 'react';
import type { EatenPantries, EatenPantry } from '@diet-app/shared';
import { api } from '@/lib/api';
import type { PantryQuestion } from './eaten-pantry-dialog';

/** Fetched once there is something to ask: no first visit of a page waits for the window. */
const EatenPantryDialog = dynamic(
  () => import('./eaten-pantry-dialog').then((dialog) => dialog.EatenPantryDialog),
  { ssr: false },
);

interface Asked {
  ask: PantryQuestion;
  path: string;
  both: boolean;
  pantries: EatenPantry[];
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
   * Of the meal or the entry at `path`: after a mark set or an entry written (`take`), after a mark taken back
   * (`give-back`), or before an entry that took food is removed (`remove`, with what removes it, once what it took is
   * given back or not; at once where nothing is to be given back). Of a shared meal marked eaten for both (`both`,
   * with `take`), both portions at once, as the API works them out together.
   */
  ask: (
    path: string,
    question: PantryQuestion,
    how?: { both?: boolean; remove?: () => void },
  ) => void;
  dialog: ReactNode;
} {
  const [asked, setAsked] = useState<Asked | null>(null);
  const ask = (
    path: string,
    question: PantryQuestion,
    { both = false, remove }: { both?: boolean; remove?: () => void } = {},
  ) =>
    void (
      both
        ? api.get<EatenPantries>(`${path}/pantry/both`)
        : api.get<EatenPantry>(`${path}/pantry`).then((pantry) => [pantry])
    ).then(
      (read) => {
        const pantries = read.filter(
          (pantry) => (question === 'take' ? pantry.offer : pantry.taken).length > 0,
        );
        if (pantries.length > 0) setAsked({ ask: question, path, both, pantries, remove });
        else remove?.();
      },
      () => remove?.(),
    );
  return {
    ask,
    dialog: asked && <EatenPantryDialog {...asked} onClose={() => setAsked(null)} />,
  };
}
