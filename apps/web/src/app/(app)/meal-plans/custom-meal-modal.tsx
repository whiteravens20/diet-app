'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { MealType, type AddCustomMealRequest } from '@diet-app/shared';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';

/**
 * F22(b) modal for adding a user-authored custom meal to a day. The user owns
 * the macros — the engine never recomputes them (a custom meal has no ingredient
 * list), so the inputs are required and frozen on submit.
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

  const [name, setName] = useState('');
  const [mealType, setMealType] = useState<MealType>('lunch');
  const mealTypeOptions = MealType.options;
  const [calories, setCalories] = useState('');
  const [protein, setProtein] = useState('');
  const [fat, setFat] = useState('');
  const [carbs, setCarbs] = useState('');
  const [servings, setServings] = useState('1');

  const num = (v: string) => (v.trim() === '' ? NaN : Number(v));
  const macros = { calories: num(calories), protein: num(protein), fat: num(fat), carbs: num(carbs) };
  const servingsNum = num(servings);
  const valid =
    name.trim().length > 0 &&
    Object.values(macros).every((v) => Number.isFinite(v) && v >= 0) &&
    Number.isFinite(servingsNum) &&
    servingsNum > 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-border bg-background shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border p-4">
          <div>
            <h2 className="font-semibold">{t('customModalTitle')}</h2>
            <p className="text-xs text-muted-foreground">{date}</p>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            {tCommon('close')}
          </Button>
        </div>

        <form
          className="space-y-4 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) return;
            onSubmit({
              name: name.trim(),
              mealType,
              nutrition: macros,
              servings: servingsNum,
            });
          }}
        >
          <Field label={t('customName')}>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
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

          <p className="text-xs italic text-muted-foreground">{t('customMacrosNote')}</p>

          <div className="grid grid-cols-2 gap-3">
            <Field label={t('customCalories')}>
              <Input type="number" min={0} value={calories} onChange={(e) => setCalories(e.target.value)} />
            </Field>
            <Field label={t('customServings')}>
              <Input type="number" min={0.25} step={0.25} value={servings} onChange={(e) => setServings(e.target.value)} />
            </Field>
            <Field label={t('customProtein')}>
              <Input type="number" min={0} value={protein} onChange={(e) => setProtein(e.target.value)} />
            </Field>
            <Field label={t('customFat')}>
              <Input type="number" min={0} value={fat} onChange={(e) => setFat(e.target.value)} />
            </Field>
            <Field label={t('customCarbs')}>
              <Input type="number" min={0} value={carbs} onChange={(e) => setCarbs(e.target.value)} />
            </Field>
          </div>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              {tCommon('cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={!valid}>
              {t('customSubmit')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
