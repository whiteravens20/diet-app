// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import type { PlanPacks } from '@diet-app/shared';
import { useAmount } from '@/lib/ingredient-format';
import { useFormat } from '@/lib/use-format';

/** Items of one food together, in the order the server gives them: each food where it first comes, its items in order. */
function byFood<T extends { ingredientId: string }>(items: readonly T[]): T[][] {
  const foods = new Map<string, T[]>();
  for (const item of items)
    foods.set(item.ingredientId, [...(foods.get(item.ingredientId) ?? []), item]);
  return [...foods.values()];
}

/**
 * What a plan's menu uses of the packs that do not keep once they are opened,
 * in a line that unfolds into the packs it does not finish. The server counts
 * all of it; this spells it. `children` is what can be done about what is
 * left, shown with the packs. `together` names the other person of a joint plan,
 * whose menu the server counts with this one: the two are cooked in one kitchen.
 */
export function PlanPacksLine({
  packs,
  together,
  children,
}: {
  packs: PlanPacks;
  together?: string;
  children?: ReactNode;
}) {
  const t = useTranslations('mealPlans.packs');
  const tFreezer = useTranslations('mealPlans.freezer');
  const amount = useAmount();
  const fmt = useFormat();
  const wasted = packs.open.filter((pack) => pack.wasted).length;
  return (
    <details>
      <summary className="cursor-pointer">
        {together !== undefined
          ? t('lineJoint', {
              percent: Math.round((packs.used / packs.bought) * 100),
              wasted,
              name: together,
            })
          : t('line', { percent: Math.round((packs.used / packs.bought) * 100), wasted })}
      </summary>
      <div className="ml-4 mt-1 space-y-1">
        {packs.open.length === 0 ? (
          packs.frozen.length === 0 && <p>{t('allFinished')}</p>
        ) : (
          <ul className="space-y-0.5">
            {/* One line a food, its rests added up. */}
            {byFood(packs.open).map((food) => {
              const first = food[0]!;
              const much = food.filter((pack) => pack.wasted).length;
              const said = {
                name: first.name,
                left: amount(
                  food.reduce((sum, pack) => sum + pack.left, 0),
                  first.unit,
                ),
                size: amount(first.packSize, first.unit),
              };
              return (
                <li key={first.ingredientId} className={much > 0 ? 'text-warning' : undefined}>
                  {food.length === 1
                    ? t(much > 0 ? 'leftMuch' : 'left', said)
                    : t(
                        much === 0
                          ? 'leftTotal'
                          : much === food.length
                            ? 'leftTotalAllMuch'
                            : 'leftTotalMuch',
                        { ...said, count: food.length, much },
                      )}
                </li>
              );
            })}
          </ul>
        )}
        {packs.frozen.length > 0 && (
          <p>
            {tFreezer('intoFreezer', {
              // One item a food: each of its rests with the day it goes in.
              items: byFood(packs.frozen)
                .map((rests) =>
                  tFreezer('intoFreezerItem', {
                    name: fmt.text(rests[0]!.name),
                    rests: fmt.list(
                      rests.map((rest) =>
                        tFreezer('intoFreezerRest', {
                          amount: amount(rest.amount, rest.unit),
                          day: fmt.weekday(rest.date, 'short'),
                        }),
                      ),
                    ),
                  }),
                )
                .join('; '),
            })}
          </p>
        )}
        {packs.fromFreezer.length > 0 && (
          <p>
            {tFreezer('fromFreezer', {
              items: packs.fromFreezer
                .map((held) =>
                  tFreezer(held.eaten < held.amount ? 'fromFreezerItemLeft' : 'fromFreezerItem', {
                    name: fmt.text(held.name),
                    amount: amount(held.amount, held.unit),
                    eaten: amount(held.eaten, held.unit),
                  }),
                )
                .join('; '),
            })}
          </p>
        )}
        {/* What the freezer held goes first only in a plan that took something out of it. */}
        <p>{t(packs.fromFreezer.length > 0 ? 'explainFreezer' : 'explain')}</p>
        {children}
      </div>
    </details>
  );
}
