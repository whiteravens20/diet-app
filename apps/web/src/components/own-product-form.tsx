// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { OwnProductBody, type OwnProduct, type Product, type ProductUnit } from '@diet-app/shared';
import { PRODUCT_TEXT } from '@diet-app/shared/constants';
import { api } from '@/lib/api';
import { useUnitName } from '@/lib/ingredient-format';
import { useErrorText } from '@/lib/use-error-text';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { linkTo, offProductPage } from '@/components/open-food-facts';

// In the order of a label.
const FIGURES = ['protein', 'fat', 'saturatedFat', 'carbs', 'sugars', 'fiber', 'salt'] as const;
type Figure = (typeof FIGURES)[number];

/** What a form holds of a product: its text as it is typed. */
interface Draft {
  code: string;
  name: string;
  brand: string;
  pack: string;
  unit: ProductUnit;
  packAmount: string;
  servingAmount: string;
  calories: string;
  figures: Record<Figure, string>;
}

const typed = (value: number | null): string => (value === null ? '' : String(value));

const draftOf = (product: Product | OwnProduct | null, code: string): Draft => ({
  code: product?.code ?? code,
  name: product?.name ?? '',
  brand: product?.brand ?? '',
  pack: product?.pack ?? '',
  unit: product?.unit ?? 'g',
  packAmount: typed(product?.packAmount ?? null),
  servingAmount: typed(product?.servingAmount ?? null),
  calories: typed(product?.per100.calories ?? null),
  figures: Object.fromEntries(
    FIGURES.map((figure) => [figure, typed(product?.per100[figure] ?? null)]),
  ) as Record<Figure, string>,
});

/** A number as a person types it, with a point or a comma; null for an empty field, NaN for what is no number. */
const numberOf = (text: string): number | null => {
  const trimmed = text.trim().replace(',', '.');
  return trimmed === '' ? null : Number(trimmed);
};

const orNull = (text: string): string | null => (text.trim() === '' ? null : text.trim());

/**
 * The form a product of one's own is written in, on its page and in the diary's
 * window. It says of a field what cannot be right before anything is sent. Given
 * a product of the base, it writes a correction of it: its figures to start
 * from, its code, and where a correction reaches everybody.
 */
export function OwnProductForm({
  product = null,
  code = '',
  from = null,
  onSaved,
  onCancel,
}: {
  /** The product being changed; none for a new one. */
  product?: OwnProduct | null;
  /** The code a new one is written for, where it came from a search. */
  code?: string;
  /** A product of the base its label says otherwise than: the new one is its reader's correction of it. */
  from?: Product | null;
  onSaved: (product: OwnProduct) => void;
  onCancel: () => void;
}) {
  const t = useTranslations('products');
  const errorText = useErrorText();
  const unitName = useUnitName();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() => draftOf(product ?? from, code));
  const [shown, setShown] = useState(false);
  // How often the form was sent with something wrong: each time the first such field comes into view.
  const [refused, setRefused] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (refused > 0) formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [refused]);

  const asked = OwnProductBody.safeParse({
    code: orNull(draft.code),
    name: draft.name,
    brand: orNull(draft.brand),
    pack: orNull(draft.pack),
    unit: draft.unit,
    packAmount: numberOf(draft.packAmount),
    servingAmount: numberOf(draft.servingAmount),
    per100: {
      calories: numberOf(draft.calories),
      ...Object.fromEntries(FIGURES.map((figure) => [figure, numberOf(draft.figures[figure])])),
    },
  });
  /** What is wrong with a field, once the form was sent; undefined where nothing is. */
  const problem = (...path: string[]): string | undefined => {
    if (!shown || asked.success) return undefined;
    const issue = asked.error.issues.find((one) => one.path.join('.') === path.join('.'));
    if (!issue) return undefined;
    const field = path.at(-1);
    if (field === 'code') return t('errCode');
    if (field === 'name') return t('errName');
    if (field === 'packAmount' || field === 'servingAmount') return t('errAmount');
    if (field === 'calories') return t('errCalories');
    if (issue.code === 'custom' && field === 'carbs') return t('errMacros');
    if (issue.code === 'custom' && field === 'sugars') return t('errSugars');
    if (issue.code === 'custom' && field === 'saturatedFat') return t('errSaturated');
    return t('errFigure');
  };

  const save = useMutation({
    mutationFn: (body: OwnProductBody) =>
      product
        ? api.patch<OwnProduct>(`/products/own/${product.id}`, body)
        : api.post<OwnProduct>('/products/own', body),
    onSuccess: (saved) => {
      // What a search found a moment ago does not hold it yet.
      void qc.invalidateQueries({ queryKey: ['own-products'] });
      void qc.invalidateQueries({ queryKey: ['products-search'] });
      onSaved(saved);
    },
  });
  const change = (part: Partial<Draft>): void => {
    setDraft((now) => ({ ...now, ...part }));
    if (save.isError) save.reset();
  };

  const unit = unitName(draft.unit);
  /** A field of a number or a text with what is wrong with it said under it. */
  const field = (
    label: string,
    path: string[],
    value: string,
    onChange: (typed: string) => void,
    input: ComponentProps<typeof Input> = { inputMode: 'decimal' },
    hint?: string,
  ) => {
    const error = problem(...path);
    // The name and the energy are what a product needs; everything else of it may stay empty.
    const optional = path[0] !== 'name' && path.join('.') !== 'per100.calories';
    return (
      <Field key={path.join('.')} label={label} hint={hint} error={error} optional={optional}>
        <Input
          aria-invalid={error !== undefined}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          {...input}
        />
      </Field>
    );
  };
  return (
    <form
      ref={formRef}
      noValidate
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        setShown(true);
        if (asked.success) save.mutate(asked.data);
        else setRefused((count) => count + 1);
      }}
    >
      {from?.code && (
        <p className="text-xs text-muted-foreground">
          {t.rich('correctIntro', { off: linkTo(offProductPage(from.code)) })}
        </p>
      )}
      {field(
        t('code'),
        ['code'],
        draft.code,
        (typed) => change({ code: typed }),
        { inputMode: 'numeric', maxLength: 20 },
        t('codeHint'),
      )}
      {field(t('name'), ['name'], draft.name, (typed) => change({ name: typed }), {
        maxLength: PRODUCT_TEXT.name,
      })}
      <div className="grid gap-3 sm:grid-cols-2">
        {field(t('brand'), ['brand'], draft.brand, (typed) => change({ brand: typed }), {
          maxLength: PRODUCT_TEXT.brand,
        })}
        {field(t('pack'), ['pack'], draft.pack, (typed) => change({ pack: typed }), {
          maxLength: PRODUCT_TEXT.pack,
        })}
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={t('unit')}>
          <select
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={draft.unit}
            onChange={(e) => change({ unit: e.target.value as ProductUnit })}
          >
            <option value="g">{unitName('g')}</option>
            <option value="ml">{unitName('ml')}</option>
          </select>
        </Field>
        {field(t('packAmount', { unit }), ['packAmount'], draft.packAmount, (typed) =>
          change({ packAmount: typed }),
        )}
        {field(t('servingAmount', { unit }), ['servingAmount'], draft.servingAmount, (typed) =>
          change({ servingAmount: typed }),
        )}
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t('in100', { unit })}</legend>
        <p className="text-xs text-muted-foreground">{t('figuresHint')}</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {field(t('calories'), ['per100', 'calories'], draft.calories, (typed) =>
            change({ calories: typed }),
          )}
          {FIGURES.map((figure) =>
            field(t(figure), ['per100', figure], draft.figures[figure], (typed) =>
              change({ figures: { ...draft.figures, [figure]: typed } }),
            ),
          )}
        </div>
      </fieldset>
      {product?.state === 'sent' && (
        <p className="text-xs text-warning">{t('changeLeavesQueue')}</p>
      )}
      {save.isError && (
        <p role="alert" className="text-sm text-destructive">
          {errorText(save.error)}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t('cancel')}
        </Button>
        <Button type="submit" size="sm" disabled={save.isPending}>
          {t('save')}
        </Button>
      </div>
    </form>
  );
}
