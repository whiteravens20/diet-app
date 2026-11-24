// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import type { DisplayUnit } from '@diet-app/shared';
import { useAmount } from '@/lib/ingredient-format';

/** The rules of freezing at home, in the order they come up: packing, freezing, thawing. */
const RULES = ['ruleLabel', 'ruleUseBy', 'ruleThaw', 'ruleRefreeze'] as const;

/**
 * What to know when freezing a food: the size to split it into where plans eat it, and, folded under "Jak mrozić",
 * the rules of freezing and thawing it safely.
 *
 * A plan takes a package out of the freezer only whole, and what is thawed is eaten within two days: a package no
 * bigger than two days eat is one the plan can use.
 */
export function FreezingTips({
  portion,
  unit,
  of,
}: {
  /** The most the plans eat of the food in two days, in `unit`; null where nothing is to be split. */
  portion: number | null;
  unit: DisplayUnit;
  /** Whose two days: the profile's plans (the pantry), or the plan the rest is frozen in. */
  of: 'plans' | 'plan';
}) {
  const t = useTranslations('freezing');
  const amount = useAmount();
  return (
    <div className="text-xs text-muted-foreground">
      {portion !== null && (
        <p>
          {t(of === 'plan' ? 'portionPlan' : 'portionPlans', { amount: amount(portion, unit) })}
        </p>
      )}
      <details>
        <summary className="w-fit cursor-pointer py-1">{t('rulesTitle')}</summary>
        <ul className="mt-1 list-disc space-y-0.5 pl-5">
          {RULES.map((rule) => (
            <li key={rule}>{t(rule)}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}
