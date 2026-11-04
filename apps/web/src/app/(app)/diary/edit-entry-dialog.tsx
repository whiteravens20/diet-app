// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useMutation } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import dynamic from 'next/dynamic';
import { useState } from 'react';
import type { DiaryEntry, MealType, Product, UpdateDiaryEntryRequest } from '@diet-app/shared';
import {
  DIARY_QUANTITY_LIMITS,
  MEAL_SLOTS_BY_COUNT,
  OWN_MEAL_LIMITS,
} from '@diet-app/shared/constants';
import { api } from '@/lib/api';
import { useUnitName } from '@/lib/ingredient-format';
import { useErrorText } from '@/lib/use-error-text';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/input';
import { shownServings } from '@/components/diary-entry-amount';
import { Skeleton } from '@/components/ui/skeleton';

// Only somebody correcting a product needs the form and the contract it checks against loaded.
// Waited for here, so that the window stays open: a page that waits closes every window over it.
const OwnProductForm = dynamic(
  () => import('@/components/own-product-form').then((form) => form.OwnProductForm),
  { ssr: false, loading: () => <Skeleton className="h-96" /> },
);

const selectClass =
  'w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring';

/**
 * The window an entry of the diary is changed in: the meal it is under, and
 * how much of it there was, in servings or in the amount of its ingredient as
 * it was given. The API changes its figures in proportion. An entry of a
 * product of the base can be moved to its reader's correction of it, written
 * here, or to the version of their own they wrote before.
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
  const servingsAtFirst = String(shownServings(entry.servings));
  const quantityAtFirst = String(entry.amount?.quantity ?? '');
  const [servings, setServings] = useState(servingsAtFirst);
  const [quantity, setQuantity] = useState(quantityAtFirst);
  const errorText = useErrorText();
  const tProducts = useTranslations('products');
  // What the code answers for its reader: the base's product to correct, or a version of their own already.
  const [found, setFound] = useState<Product | null>(null);
  const correctable =
    entry.kind === 'product' && entry.productSource !== 'own' && entry.productCode !== null;
  const lookUp = useMutation({
    mutationFn: () => api.get<Product>(`/products/code/${entry.productCode}`),
    onSuccess: setFound,
  });
  /** The entry goes on to a product of the reader's own, with the meal and the amount the window holds. */
  const toOwn = (product: Product): void =>
    onSubmit({
      mealType,
      productId: product.id,
      ...(quantity !== quantityAtFirst ? { quantity: Number(quantity) } : {}),
    });

  if (found && found.source !== 'own') {
    return (
      <Dialog open onClose={onClose} label={tProducts('correctTitle')} className="max-w-lg">
        <div className="flex items-center justify-between border-b border-border p-4">
          <div className="min-w-0">
            <h2 className="font-semibold">{tProducts('correctTitle')}</h2>
            <p className="break-words text-xs text-muted-foreground">{entry.name}</p>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            {tCommon('close')}
          </Button>
        </div>
        <div className="space-y-3 p-4">
          <p className="text-xs text-muted-foreground">{t('entryCorrectHint')}</p>
          <OwnProductForm from={found} onSaved={toOwn} onCancel={() => setFound(null)} />
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog open onClose={onClose} label={t('editTitle')} className="max-w-md">
      <div className="flex items-center justify-between border-b border-border p-4">
        <div className="min-w-0">
          <h2 className="font-semibold">{t('editTitle')}</h2>
          <p className="break-words text-xs text-muted-foreground">{entry.name}</p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {tCommon('close')}
        </Button>
      </div>
      <form
        className="space-y-4 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          // An amount left alone stays exactly what it was: what is shown of it may be rounded.
          onSubmit({
            mealType,
            ...(quantity !== quantityAtFirst ? { quantity: Number(quantity) } : {}),
            ...(servings !== servingsAtFirst ? { servings: Number(servings) } : {}),
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
              // A meal of a plan copied here may hold less than an entry can be written with, and no round number.
              min={Math.min(OWN_MEAL_LIMITS.servings.min, Number(servingsAtFirst))}
              max={OWN_MEAL_LIMITS.servings.max}
              step="any"
              value={servings}
              onChange={(e) => setServings(e.target.value)}
            />
          </Field>
        )}
        {correctable && (
          <div className="space-y-2 rounded-md border border-border bg-muted/40 p-3 text-xs">
            {found ? (
              <>
                <p className="break-words">{t('entryOwnVersion', { name: found.name })}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => toOwn(found)}
                >
                  {t('entryUseOwnVersion')}
                </Button>
              </>
            ) : (
              <>
                <p className="text-muted-foreground">{t('productCorrectHint')}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={lookUp.isPending}
                  onClick={() => lookUp.mutate()}
                >
                  {t('entryCorrect')}
                </Button>
              </>
            )}
            {lookUp.isError && (
              <p role="alert" className="text-destructive">
                {errorText(lookUp.error)}
              </p>
            )}
          </div>
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
