// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { AddCustomMealRequest, EnteredNutrition, type MealType } from '@diet-app/shared';
import { MEAL_TYPES } from '@diet-app/shared/constants';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { useFormat } from '@/lib/use-format';
import { Dialog } from '@/components/ui/dialog';

/** The most one serving may hold of each, as the API has it. */
const most = (of: keyof EnteredNutrition) => EnteredNutrition.shape[of].maxValue ?? undefined;

/**
 * The window a meal of the user's own is added to a day in. Such a meal has
 * no ingredients, so what it holds is what the user says: the numbers of one
 * serving, and how many servings the meal is. The API multiplies the one by
 * the other, and the window shows that product before anything is sent, so
 * that nobody types the whole meal as one serving of several.
 */
export function CustomMealModal({
  date,
  onClose,
  onSubmit,
}: {
  date: string;
  onClose: () => void;
  onSubmit: (body: AddCustomMealRequest) => void;
}) {
  const t = useTranslations('mealPlans');
  const tCommon = useTranslations('common');
  const tMeal = useTranslations('enums.mealType');
  const fmt = useFormat();

  const [name, setName] = useState('');
  const [mealType, setMealType] = useState<MealType>('lunch');
  const mealTypeOptions = MEAL_TYPES;
  const [calories, setCalories] = useState('');
  const [protein, setProtein] = useState('');
  const [fat, setFat] = useState('');
  const [carbs, setCarbs] = useState('');
  const [servings, setServings] = useState('1');

  const num = (v: string) => (v.trim() === '' ? NaN : Number(v));
  const serving = { calories: num(calories), protein: num(protein), fat: num(fat), carbs: num(carbs) };
  const asked = AddCustomMealRequest.safeParse({ name, mealType, nutrition: serving, servings: num(servings) });
  // What the meal adds to its day, rounded as the API rounds it. It does not wait for a name.
  const counted = AddCustomMealRequest.omit({ name: true }).safeParse({ mealType, nutrition: serving, servings: num(servings) });
  const adds = counted.success
    ? {
        calories: Math.round(counted.data.nutrition.calories * counted.data.servings),
        protein: Math.round(counted.data.nutrition.protein * counted.data.servings),
        fat: Math.round(counted.data.nutrition.fat * counted.data.servings),
        carbs: Math.round(counted.data.nutrition.carbs * counted.data.servings),
      }
    : null;

  return (
    <Dialog open onClose={onClose} label={t('customModalTitle')} className="max-w-md">
      <div className="flex items-center justify-between border-b border-border p-4">
        <div>
          <h2 className="font-semibold">{t('customModalTitle')}</h2>
          <p className="text-xs text-muted-foreground">{fmt.day(date)}</p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {tCommon('close')}
        </Button>
      </div>

      <form
        className="space-y-4 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          // The fields say themselves what is wrong with them before it comes to this.
          if (asked.success) onSubmit(asked.data);
        }}
      >
        <Field label={t('customName')}>
          {/* A name of nothing but spaces is no name. */}
          <Input value={name} onChange={(e) => setName(e.target.value)} required pattern=".*\S.*" maxLength={120} />
        </Field>

        <Field label={t('customMealType')}>
          <select
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            value={mealType}
            onChange={(e) => setMealType(e.target.value as MealType)}
          >
            {mealTypeOptions.map((slot) => (
              <option key={slot} value={slot}>
                {tMeal.has(slot) ? tMeal(slot) : slot}
              </option>
            ))}
          </select>
        </Field>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t('customPerServing')}</legend>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('customCalories')}>
              <Input type="number" inputMode="decimal" required min={0} max={most('calories')} step="any" value={calories} onChange={(e) => setCalories(e.target.value)} />
            </Field>
            <Field label={t('customProtein')}>
              <Input type="number" inputMode="decimal" required min={0} max={most('protein')} step="any" value={protein} onChange={(e) => setProtein(e.target.value)} />
            </Field>
            <Field label={t('customFat')}>
              <Input type="number" inputMode="decimal" required min={0} max={most('fat')} step="any" value={fat} onChange={(e) => setFat(e.target.value)} />
            </Field>
            <Field label={t('customCarbs')}>
              <Input type="number" inputMode="decimal" required min={0} max={most('carbs')} step="any" value={carbs} onChange={(e) => setCarbs(e.target.value)} />
            </Field>
          </div>
        </fieldset>

        <Field label={t('customServings')} hint={t('customServingsHint')}>
          <Input type="number" inputMode="decimal" required min={0.25} max={20} step={0.25} value={servings} onChange={(e) => setServings(e.target.value)} />
        </Field>

        <p aria-live="polite" className="rounded-md border border-border bg-muted/40 p-3 text-xs">
          {adds ? t('customTotal', adds) : t('customTotalPending')}
        </p>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            {tCommon('cancel')}
          </Button>
          <Button type="submit" size="sm">
            {t('customSubmit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
