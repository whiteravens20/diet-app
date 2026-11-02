// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState, type ComponentProps } from 'react';
import { OwnProductBody, type OwnProduct, type Product, type ProductUnit } from '@diet-app/shared';
import { PRODUCT_TEXT } from '@diet-app/shared/constants';
import { productCodeOf } from '@diet-app/shared/product-code';
import { api } from '@/lib/api';
import { ApiClientError } from '@/lib/http';
import { useUnitName } from '@/lib/ingredient-format';
import { useErrorText } from '@/lib/use-error-text';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';

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

const draftOf = (product: OwnProduct | null, code: string): Draft => ({
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
 * window. It says of a field what cannot be right before anything is sent. A code
 * the base knows is refused by the API, as a code is in one place: the form then
 * shows the base's product, and leads to writing this one without a code.
 */
export function OwnProductForm({
  product = null,
  code = '',
  onSaved,
  onUseBase,
  onCancel,
}: {
  /** The product being changed; none for a new one. */
  product?: OwnProduct | null;
  /** The code a new one is written for, where it came from a search. */
  code?: string;
  onSaved: (product: OwnProduct) => void;
  /** Takes the base's product of the code, where the base turned out to have one and the place can take it. */
  onUseBase?: (product: Product) => void;
  onCancel: () => void;
}) {
  const t = useTranslations('products');
  const errorText = useErrorText();
  const unitName = useUnitName();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() => draftOf(product, code));
  const [shown, setShown] = useState(false);

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

  // A code the base knows is refused, and the form shows the product it knows it as.
  const known = save.error instanceof ApiClientError && save.error.code === 'PRODUCT_CODE_KNOWN';
  const knownCode = known ? productCodeOf(draft.code) : null;
  const base = useQuery({
    queryKey: ['products-code', knownCode],
    queryFn: () => api.get<Product>(`/products/code/${knownCode}`),
    enabled: knownCode !== null,
  });

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
    return (
      <Field key={path.join('.')} label={label} hint={hint} error={error}>
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
      noValidate
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        setShown(true);
        if (asked.success) save.mutate(asked.data);
      }}
    >
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
        <div className="space-y-2 rounded-md border border-border bg-muted/40 p-3 text-sm">
          <p role="alert" className="text-destructive">
            {errorText(save.error)}
          </p>
          {known && (
            <>
              {base.data && (
                <div>
                  <p className="break-words font-medium">{base.data.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {[
                      base.data.brand,
                      base.data.pack,
                      t('figures', {
                        kcal: Math.round(base.data.per100.calories ?? 0),
                        unit: unitName(base.data.unit),
                      }),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                {onUseBase && base.data && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => onUseBase(base.data)}
                  >
                    {t('useBase')}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => change({ code: '' })}
                >
                  {t('withoutCode')}
                </Button>
              </div>
            </>
          )}
        </div>
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
