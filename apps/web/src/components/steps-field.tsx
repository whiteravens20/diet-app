// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { ArrowDown, ArrowUp, Plus, Trash } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { RECIPE_LIMITS } from '@diet-app/shared/constants';
import { Button } from '@/components/ui/button';

/**
 * The steps of a recipe as they are written: each in a field of its own,
 * moved up or down, taken out and added, up to as many as a recipe holds.
 */
export function StepsField({
  steps,
  onChange,
}: {
  steps: string[];
  onChange: (steps: string[]) => void;
}) {
  const t = useTranslations('ownRecipe');
  const move = (index: number, by: -1 | 1): void => {
    const next = [...steps];
    [next[index], next[index + by]] = [next[index + by]!, next[index]!];
    onChange(next);
  };
  return (
    <>
      <ol className="space-y-3">
        {steps.map((step, index) => (
          <li key={index} className="flex items-start gap-2">
            <textarea
              value={step}
              onChange={(e) => onChange(steps.map((s, i) => (i === index ? e.target.value : s)))}
              maxLength={RECIPE_LIMITS.step}
              rows={2}
              aria-label={t('stepNumber', { n: index + 1 })}
              className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
            <div className="flex flex-col">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={index === 0}
                onClick={() => move(index, -1)}
                aria-label={t('stepUp', { n: index + 1 })}
                title={t('stepUp', { n: index + 1 })}
              >
                <ArrowUp size={14} aria-hidden />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={index === steps.length - 1}
                onClick={() => move(index, 1)}
                aria-label={t('stepDown', { n: index + 1 })}
                title={t('stepDown', { n: index + 1 })}
              >
                <ArrowDown size={14} aria-hidden />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={steps.length === 1}
                onClick={() => onChange(steps.filter((_, i) => i !== index))}
                aria-label={t('removeStep', { n: index + 1 })}
                title={t('removeStep', { n: index + 1 })}
              >
                <Trash size={14} aria-hidden />
              </Button>
            </div>
          </li>
        ))}
      </ol>
      {steps.length < RECIPE_LIMITS.steps && (
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([...steps, ''])}>
          <Plus size={14} aria-hidden />
          <span className="ml-1">{t('addStep')}</span>
        </Button>
      )}
    </>
  );
}
