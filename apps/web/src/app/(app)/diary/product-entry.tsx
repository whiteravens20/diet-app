// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useState, type ReactNode } from 'react';
import type { Product, ProductSearchResult } from '@diet-app/shared';
import { DIARY_QUANTITY_LIMITS, PRODUCT_SEARCH } from '@diet-app/shared/constants';
import { productCodeOf, wordsOfProductSearch } from '@diet-app/shared/product-code';
import { api } from '@/lib/api';
import { ApiClientError } from '@/lib/http';
import { useUnitName } from '@/lib/ingredient-format';
import { useErrorText } from '@/lib/use-error-text';
import { useFormat } from '@/lib/use-format';
import { useSettled } from '@/lib/use-settled';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { FoundList } from './found-list';

const OPEN_FOOD_FACTS = 'https://world.openfoodfacts.org';
const ODBL = 'https://opendatacommons.org/licenses/odbl/1-0/';

/** What a person types when they type a code: digits, with whatever they read between them. */
const looksLikeCode = (typed: string): boolean => /^[\d\s-]+$/.test(typed);

function linkTo(href: string) {
  return function Linked(chunks: ReactNode) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="text-primary underline underline-offset-2"
      >
        {chunks}
      </a>
    );
  };
}

/** Where the figures of a product come from, under the licence they come with. */
function ProductSource({ source }: { source: Product['source'] }) {
  const t = useTranslations('diary');
  return (
    <p className="text-xs text-muted-foreground">
      {source === 'own'
        ? t('productSourceOwn')
        : t.rich(source === 'instance' ? 'productSourceInstance' : 'productSource', {
            off: linkTo(OPEN_FOOD_FACTS),
            odbl: linkTo(ODBL),
          })}
    </p>
  );
}

/**
 * The field a product is looked for in: words look among what the instance
 * holds as they are typed, and a code is asked about only when somebody says
 * so, for eight digits on the way to thirteen can be a code as well, and a code
 * the instance does not hold counts against what the account may ask.
 */
export function ProductSearch({
  lookups,
  onPick,
  onOwnMeal,
  onOwnProduct,
}: {
  /** Whether a code the instance does not hold is asked of Open Food Facts. */
  lookups: boolean;
  onPick: (product: Product) => void;
  onOwnMeal: () => void;
  /** Writes a product of one's own, with the code that was looked for where one was. */
  onOwnProduct: (code: string) => void;
}) {
  const t = useTranslations('diary');
  const unitName = useUnitName();
  const errorText = useErrorText();
  const id = useId();
  const [typed, setTyped] = useState('');
  const [badCode, setBadCode] = useState(false);
  const text = typed.trim();
  const isCode = text !== '' && looksLikeCode(text);
  const asked = useSettled(text, 300);
  // Only what can be looked for is asked, and said anything of: an answer to an earlier text is none to this one.
  const searching = !isCode && asked === text && wordsOfProductSearch(text).length > 0;

  const found = useQuery({
    queryKey: ['products-search', asked],
    queryFn: () => api.get<ProductSearchResult>(`/products?search=${encodeURIComponent(asked)}`),
    enabled: searching,
  });
  const check = useMutation({
    mutationFn: (code: string) => api.get<Product>(`/products/code/${code}`),
    onSuccess: onPick,
  });

  const type = (value: string): void => {
    setTyped(value);
    setBadCode(false);
    check.reset();
  };
  const checkCode = (): void => {
    const code = productCodeOf(text);
    setBadCode(code === null);
    if (code !== null) check.mutate(code);
  };
  const unknown = check.error instanceof ApiClientError && check.error.code === 'PRODUCT_NOT_FOUND';

  const offered = searching ? (found.data?.items ?? []) : [];
  return (
    <div className="space-y-2">
      <Field label={t('productField')} hint={t('productHint')}>
        <Input
          type="search"
          inputMode="text"
          value={typed}
          onChange={(e) => type(e.target.value)}
          onKeyDown={(e) => {
            // Enter checks a code; the window's own button is for what was picked.
            if (e.key !== 'Enter') return;
            e.preventDefault();
            if (isCode) checkCode();
          }}
          aria-controls={`${id}-found`}
          maxLength={PRODUCT_SEARCH.longest}
        />
      </Field>
      {isCode && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={check.isPending}
          onClick={checkCode}
        >
          {t('productCheck')}
        </Button>
      )}
      <div id={`${id}-found`} aria-live="polite" className="space-y-2">
        {badCode && (
          <p role="alert" className="text-sm text-destructive">
            {t('productCodeBad')}
          </p>
        )}
        {check.isError && (
          <div className="space-y-2">
            <p role="alert" className="text-sm text-destructive">
              {unknown
                ? t(lookups ? 'productNotFound' : 'productNotFoundHere')
                : errorText(check.error)}
            </p>
            <div className="flex flex-wrap gap-2">
              {unknown && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onOwnProduct(productCodeOf(text) ?? '')}
                >
                  {t('productAddOwn')}
                </Button>
              )}
              <Button type="button" variant="ghost" size="sm" onClick={onOwnMeal}>
                {t('productAsOwn')}
              </Button>
            </div>
          </div>
        )}
        {searching && !found.isFetching && found.isError && (
          <p role="alert" className="text-sm text-destructive">
            {t('searchFailed')}
          </p>
        )}
        {searching && !found.isFetching && !found.isError && offered.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('productNothingHere')}</p>
        )}
        {offered.length > 0 && (
          <FoundList
            found={offered.map((product) => ({
              id: product.id,
              name: product.brand ? `${product.name}, ${product.brand}` : product.name,
              about: [
                t('per100', {
                  kcal: Math.round(product.per100.calories ?? 0),
                  unit: unitName(product.unit),
                }),
                ...(product.source === 'own' ? [t('productOwnMark')] : []),
              ].join(' · '),
              pick: () => onPick(product),
            }))}
          />
        )}
        {searching && !found.isFetching && !found.isError && (
          <Button type="button" variant="ghost" size="sm" onClick={() => onOwnProduct('')}>
            {t('productAddOwn')}
          </Button>
        )}
      </div>
    </div>
  );
}

/** What was picked: what its label says in 100 of its unit, with what is unknown said to be so, and a way back to the search. */
export function PickedProduct({
  product,
  onAgain,
  onOwnMeal,
}: {
  product: Product;
  onAgain: () => void;
  onOwnMeal: () => void;
}) {
  const t = useTranslations('diary');
  const unitName = useUnitName();
  const { per100 } = product;
  const usable = per100.calories !== null;
  const row = (label: string, value: number | null, inner = false): ReactNode => (
    <div key={label} className="flex justify-between gap-3">
      <dt className={inner ? 'pl-3 text-muted-foreground' : undefined}>{label}</dt>
      <dd className="tabular-nums">
        {value === null ? t('labelUnknown') : t('labelGrams', { grams: value })}
      </dd>
    </div>
  );
  const lacking =
    usable && (per100.protein === null || per100.fat === null || per100.carbs === null);
  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/40 px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="break-words text-sm font-medium">{product.name}</p>
          <p className="text-xs text-muted-foreground">
            {[product.brand, product.pack].filter(Boolean).join(' · ')}
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onAgain}>
          {t('changePick')}
        </Button>
      </div>
      {usable ? (
        <div className="space-y-0.5 text-xs">
          <p className="font-medium">{t('labelIn100', { unit: unitName(product.unit) })}</p>
          <dl className="space-y-0.5">
            <div className="flex justify-between gap-3">
              <dt>{t('labelEnergy')}</dt>
              <dd className="tabular-nums">
                {product.energyWorkedOut && '≈ '}
                {t('mealKcal', { kcal: Math.round(per100.calories!) })}
              </dd>
            </div>
            {row(t('labelProtein'), per100.protein)}
            {row(t('labelFat'), per100.fat)}
            {row(t('labelSaturated'), per100.saturatedFat, true)}
            {row(t('labelCarbs'), per100.carbs)}
            {row(t('labelSugars'), per100.sugars, true)}
            {row(t('labelFiber'), per100.fiber)}
            {row(t('labelSalt'), per100.salt)}
          </dl>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-sm">{t('productNoFigures')}</p>
          <Button type="button" variant="outline" size="sm" onClick={onOwnMeal}>
            {t('productAsOwn')}
          </Button>
        </div>
      )}
      {product.doubtful && usable && (
        <p className="rounded-md border border-warning/40 bg-warning/5 p-2 text-xs">
          {t('productDoubtful')}
        </p>
      )}
      {lacking && <p className="text-xs text-muted-foreground">{t('productLacking')}</p>}
      {product.energyWorkedOut && (
        <p className="text-xs text-muted-foreground">{t('productEnergyWorkedOut')}</p>
      )}
      <ProductSource source={product.source} />
    </div>
  );
}

/** What the amount of a picked product is typed in, with a serving and a pack a press away. */
export function ProductAmount({
  product,
  quantity,
  onChange,
}: {
  product: Product;
  quantity: string;
  onChange: (quantity: string) => void;
}) {
  const t = useTranslations('diary');
  const fmt = useFormat();
  const unitName = useUnitName();
  const most = DIARY_QUANTITY_LIMITS[product.unit];
  const unit = unitName(product.unit);
  const amount = (value: number): string => `${fmt.number(value, 2)} ${unit}`;
  const fits = (value: number | null): value is number => value !== null && value <= most;
  return (
    <div className="space-y-2">
      <Field label={`${t('quantity')} (${unit})`}>
        <Input
          type="number"
          inputMode="decimal"
          required
          min={0.01}
          max={most}
          step="any"
          value={quantity}
          onChange={(e) => onChange(e.target.value)}
        />
      </Field>
      {(fits(product.servingAmount) || fits(product.packAmount)) && (
        <div className="flex flex-wrap gap-2">
          {fits(product.servingAmount) && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onChange(String(product.servingAmount))}
            >
              {t('productServing', { amount: amount(product.servingAmount) })}
            </Button>
          )}
          {fits(product.packAmount) && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onChange(String(product.packAmount))}
            >
              {t('productPack', { amount: amount(product.packAmount) })}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** The amount a picked product starts with: a serving by its label, where it gives one a diary takes. */
export function firstAmount(product: Product): string {
  const serving = product.servingAmount;
  return serving !== null && serving <= DIARY_QUANTITY_LIMITS[product.unit] ? String(serving) : '';
}
