// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import type { PlannedMeal } from '@diet-app/shared';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import {
  partsOf,
  SplitCalculator,
  type SplitLine,
  type SplitPortion,
} from '@/components/split-calculator';

/** A meal a dish is eaten at, with its day. */
export interface CookedMeal {
  meal: PlannedMeal;
  date: string;
}

/** A portion of a dish to split, before it is named. */
export interface PotPart {
  key: string;
  /** Whose portion it is, in a pot both people cook; null for a dish of one person. */
  who: string | null;
  date: string;
  mealType: string;
  kcal: number;
  lines: readonly SplitLine[];
  eaten: boolean;
}

/**
 * What a dish is split into, of the meals it is eaten at (`cooked`: every meal of a dish cooked ahead, or the one
 * meal of a pot both people cook): each meal's portion, and in a pot both cook the other person's portion of it as
 * well. A portion eaten already is left out of the split (`eaten` names them); what the pot holds beyond the portions
 * its meals take now (a meal sized down after the pot was cooked, `PlannedMeal.pot`) is a portion of its own, in the
 * dish's make-up. `plated`: a plate of either person holds its parts in proportions of its own, so the dish is split
 * one part at a time.
 */
export function partsOfPot(cooked: readonly CookedMeal[], ownName: string) {
  const parts: PotPart[] = cooked.flatMap((one) => {
    const together = one.meal.shared && !one.meal.shared.apart ? one.meal.shared : null;
    const own: PotPart = {
      key: one.meal.id,
      who: together ? ownName : null,
      date: one.date,
      mealType: one.meal.mealType,
      kcal: one.meal.nutrition.calories,
      lines: one.meal.ingredients,
      eaten: one.meal.eatenAt !== null,
    };
    if (!together) return [own];
    return [
      own,
      {
        key: together.with.mealId,
        who: together.with.profileName,
        date: one.date,
        mealType: one.meal.mealType,
        kcal: together.with.calories,
        lines: together.with.ingredients,
        eaten: together.with.eaten,
      },
    ];
  });
  // What stays in the pot beyond the portions its meals take now: their rests together.
  let restKcal = 0;
  const restLines = new Map<string, SplitLine>();
  for (const one of cooked) {
    const rest = one.meal.pot?.rest ?? 0;
    const servings = one.meal.servings * one.meal.quantityScale;
    if (!(rest > 0) || !(servings > 0)) continue;
    const factor = rest / servings;
    restKcal += one.meal.nutrition.calories * factor;
    for (const line of one.meal.ingredients) {
      restLines.set(line.ingredientId, {
        ingredientId: line.ingredientId,
        name: line.name,
        quantity: (restLines.get(line.ingredientId)?.quantity ?? 0) + line.quantity * factor,
      });
    }
  }
  return {
    split: parts.filter((part) => !part.eaten),
    eaten: parts.filter((part) => part.eaten),
    rest: restKcal > 0 ? { kcal: restKcal, lines: [...restLines.values()] } : null,
    plated: cooked.some((one) =>
      [...one.meal.ingredients, ...(one.meal.shared?.with.ingredients ?? [])].some(
        (line) => line.share !== undefined,
      ),
    ),
  };
}

/**
 * The window a dish cooked ahead, or a pot both people cook, is split in, into the portions of the plan, by the
 * plan's shares: their energy, or what each takes of a part weighed alone. Portions eaten already are left out and
 * named; the pot's surplus is a portion of its own; where the plates differ it opens on one part at a time. The
 * page that opens it names the portions (`words`), as the rest of the plan names days and people: the window,
 * fetched when it opens, brings nothing of that along, and leaves how the pages' shared scripts are split alone.
 */
export function SplitDialog({
  cooked,
  ownName,
  words,
  onClose,
}: {
  cooked: readonly CookedMeal[];
  /** The name this plan's portion goes by in a pot both people cook. */
  ownName: string;
  words: { label: (part: PotPart) => string; list: (items: readonly string[]) => string };
  onClose: () => void;
}) {
  const t = useTranslations('split');
  const tCommon = useTranslations('common');
  const { split, eaten, rest, plated } = partsOfPot(cooked, ownName);
  const portions: SplitPortion[] = [
    ...split.map((part) => ({
      key: part.key,
      label: words.label(part),
      kcal: part.kcal,
      lines: part.lines,
    })),
    ...(rest ? [{ key: 'rest', label: t('restInPot'), kcal: rest.kcal, lines: rest.lines }] : []),
  ];
  return (
    <Dialog open onClose={onClose} label={t('title')} className="max-w-lg">
      <div className="flex items-center justify-between border-b border-border p-4">
        <h2 className="font-semibold">{t('title')}</h2>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {tCommon('close')}
        </Button>
      </div>
      <div className="space-y-4 p-4">
        <p className="text-sm text-muted-foreground">
          {t(partsOf(portions).length > 0 ? 'planIntroParts' : 'planIntro')}
        </p>
        {eaten.length > 0 && (
          <p className="text-sm text-muted-foreground">
            {t('eatenLeftOut', { portions: words.list(eaten.map(words.label)) })}
          </p>
        )}
        {portions.length > 0 ? (
          <SplitCalculator portions={portions} plated={plated} />
        ) : (
          <p className="text-sm">{t('allEaten')}</p>
        )}
      </div>
    </Dialog>
  );
}
