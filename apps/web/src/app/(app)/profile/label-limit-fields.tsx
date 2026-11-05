// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { LABEL_LIMIT_BOUNDS, LABEL_LIMIT_STARTS, type LabelLimits } from '@diet-app/shared';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Input } from '@/components/ui/input';

/** The limits, in the order the form shows them. */
const LIMITS = ['saltAtMost', 'fiberAtLeast', 'saturatedFatAtMost', 'sugarsAtMost'] as const;

/** The limits as the form holds them: one that is ticked at its number, one that is not ticked off. */
export function labelLimitsIn(fields: FormData): LabelLimits {
  const limitOf = (key: (typeof LIMITS)[number]): number | null =>
    fields.get(`${key}On`) === 'on' ? Number(fields.get(key)) : null;
  return {
    saltAtMost: limitOf('saltAtMost'),
    fiberAtLeast: limitOf('fiberAtLeast'),
    saturatedFatAtMost: limitOf('saturatedFatAtMost'),
    sugarsAtMost: limitOf('sugarsAtMost'),
  };
}

/**
 * A box to tick for each limit of a label, and its number in grams a day once it is ticked: what
 * the profile set, or where a limit starts (`LABEL_LIMIT_STARTS`).
 */
export function LabelLimitFields({ initial }: { initial: LabelLimits }) {
  const t = useTranslations('profile');
  const [on, setOn] = useState<Record<(typeof LIMITS)[number], boolean>>(() => ({
    saltAtMost: initial.saltAtMost !== null,
    fiberAtLeast: initial.fiberAtLeast !== null,
    saturatedFatAtMost: initial.saturatedFatAtMost !== null,
    sugarsAtMost: initial.sugarsAtMost !== null,
  }));
  return (
    <fieldset className="space-y-2 sm:col-span-2">
      {/* The section above names it. */}
      <legend className="sr-only">{t('labelLimits')}</legend>
      <p className="text-xs text-muted-foreground">{t('labelLimitsHint')}</p>
      <ul className="space-y-2">
        {LIMITS.map((key) => (
          <li key={key} className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name={`${key}On`}
                checked={on[key]}
                onChange={(event) => setOn({ ...on, [key]: event.target.checked })}
                className="size-4 accent-primary"
              />
              {t(`labelLimit.${key}`)}
            </label>
            {on[key] && (
              <span className="flex items-center gap-1.5 text-sm">
                <Input
                  name={key}
                  type="number"
                  required
                  min={LABEL_LIMIT_BOUNDS[key].min}
                  max={LABEL_LIMIT_BOUNDS[key].max}
                  step={0.5}
                  defaultValue={initial[key] ?? LABEL_LIMIT_STARTS[key]}
                  aria-label={t(`labelLimit.${key}`)}
                  className="w-24"
                />
                {t('labelLimitUnit')}
              </span>
            )}
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">{t('labelLimitStarts')}</p>
    </fieldset>
  );
}
