// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { DiaryEntry, MealType, UpdateDiaryEntryRequest } from '@diet-app/shared';
import {
  DIARY_QUANTITY_LIMITS,
  MEAL_SLOTS_BY_COUNT,
  OWN_MEAL_LIMITS,
} from '@diet-app/shared/constants';
import { useUnitName } from '@/lib/ingredient-format';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/input';

const selectClass =
  'w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring';

/**
 * The window an entry of the diary is changed in: the meal it is under, and
 * how much of it there was, in servings or in the amount of its ingredient as
 * it was given. The API changes its figures in proportion.
 */
export function EditEntryDialog({
  entry,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  entry: DiaryEntry;
  busy: boolean;
  /** Why the API refused what was sent, said in the window. */
  error: string | null;
  onClose: () => void;
  onSubmit: (change: UpdateDiaryEntryRequest) => void;
}) {
  const t = useTranslations('diary');
  const tCommon = useTranslations('common');
  const tMeal = useTranslations('enums.mealType');
  const unitName = useUnitName();
  const [mealType, setMealType] = useState<MealType>(entry.mealType);
  const [servings, setServings] = useState(String(entry.servings ?? 1));
  const [quantity, setQuantity] = useState(String(entry.amount?.quantity ?? ''));

  return (
    <Dialog open onClose={onClose} label={t('editTitle')} className="max-w-md">
      <div className="flex items-center justify-between border-b border-border p-4">
        <div className="min-w-0">
          <h2 className="font-semibold">{t('editTitle')}</h2>
          <p className="text-xs text-muted-foreground">{entry.name}</p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {tCommon('close')}
        </Button>
      </div>
      <form
        className="space-y-4 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit({
            mealType,
            ...(entry.amount ? { quantity: Number(quantity) } : { servings: Number(servings) }),
          });
        }}
      >
        <Field label={t('mealLabel')}>
          <select
            className={selectClass}
            value={mealType}
            onChange={(e) => setMealType(e.target.value as MealType)}
          >
            {MEAL_SLOTS_BY_COUNT[5]!.map((slot) => (
              <option key={slot} value={slot}>
                {tMeal(slot)}
              </option>
            ))}
          </select>
        </Field>
        {entry.amount ? (
          // The amount as it was given, in the unit it was given in.
          <Field label={`${t('quantity')} (${unitName(entry.amount.shown.unit)})`}>
            <Input
              type="number"
              inputMode="decimal"
              required
              min={0.01}
              max={DIARY_QUANTITY_LIMITS[entry.amount.unit]}
              step="any"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </Field>
        ) : (
          <Field label={t('servings')}>
            <Input
              type="number"
              inputMode="decimal"
              required
              min={OWN_MEAL_LIMITS.servings.min}
              max={OWN_MEAL_LIMITS.servings.max}
              step={0.25}
              value={servings}
              onChange={(e) => setServings(e.target.value)}
            />
          </Field>
        )}
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            {tCommon('cancel')}
          </Button>
          <Button type="submit" size="sm" disabled={busy}>
            {tCommon('save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
