// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Barcode } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { OwnProduct, OwnProducts, ProductAdditions } from '@diet-app/shared';
import { OWN_PRODUCTS } from '@diet-app/shared/constants';
import { EmptyState } from '@/components/empty-state';
import { LoadFailed } from '@/components/load-failed';
import { OwnProductForm } from '@/components/own-product-form';
import { PageBanner } from '@/components/page-banner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { IMAGERY } from '@/lib/imagery';
import { useUnitName } from '@/lib/ingredient-format';
import { saveText } from '@/lib/save-file';
import { useConfig } from '@/lib/use-config';
import { useErrorText } from '@/lib/use-error-text';
import { useFormat } from '@/lib/use-format';
import { cn } from '@/lib/utils';
import { linkTo, ODBL, offProductPage, OPEN_FOOD_FACTS } from '@/components/open-food-facts';
import { DOT, held } from '@/lib/figure-line';

/** A product can go to the base with a code and all four of its figures. */
const sendable = (product: OwnProduct): boolean =>
  product.code !== null &&
  product.per100.protein !== null &&
  product.per100.fat !== null &&
  product.per100.carbs !== null;

export default function ProductsPage() {
  const t = useTranslations('products');
  const errorText = useErrorText();
  const unitName = useUnitName();
  const fmt = useFormat();
  const qc = useQueryClient();
  const config = useConfig().data;
  const [writing, setWriting] = useState<{ product: OwnProduct | null } | null>(null);
  // The product whose sending or removal waits for a word, with what it does said first.
  const [asking, setAsking] = useState<{ id: string; what: 'send' | 'remove' } | null>(null);
  // What was refused, said at the product it was asked of; the file's at the top, beside its button.
  const [error, setError] = useState<{ on: string | null; text: string } | null>(null);

  const mine = useQuery({
    queryKey: ['own-products'],
    queryFn: () => api.get<OwnProducts>('/products/own'),
    enabled: config?.products.offered === true,
  });
  const reread = () => qc.invalidateQueries({ queryKey: ['own-products'] });
  const fail = (e: unknown, id: string) => {
    setError({ on: id, text: errorText(e) });
    void reread();
  };
  const send = useMutation({
    mutationFn: (id: string) => {
      setError(null);
      return api.post<OwnProduct>(`/products/own/${id}/send`);
    },
    onSuccess: () => {
      setAsking(null);
      void reread();
    },
    onError: fail,
  });
  const withdraw = useMutation({
    mutationFn: (id: string) => {
      setError(null);
      return api.post<OwnProduct>(`/products/own/${id}/withdraw`);
    },
    onSuccess: () => void reread(),
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (id: string) => {
      setError(null);
      return api.delete<void>(`/products/own/${id}`);
    },
    onSuccess: () => {
      setAsking(null);
      void reread();
    },
    onError: fail,
  });
  const file = useMutation({
    mutationFn: () => api.get<ProductAdditions>('/products/additions'),
    onSuccess: (additions) =>
      saveText(JSON.stringify(additions, null, 2), 'products-added.json', 'application/json'),
    onError: (e: unknown) => setError({ on: null, text: errorText(e) }),
  });
  const busy = send.isPending || withdraw.isPending || remove.isPending;
  const grams = (value: number | null): string => (value === null ? '—' : fmt.number(value, 1));

  const banner = <PageBanner image={IMAGERY.products} title={t('title')} subtitle={t('subhead')} />;
  if (config && !config.products.offered) {
    return (
      <div className="space-y-8">
        {banner}
        <p className="text-sm text-muted-foreground">{t('notOffered')}</p>
      </div>
    );
  }
  const items = mine.data?.items ?? [];
  return (
    <div className="space-y-8">
      {banner}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={() => setWriting({ product: null })}>
          {t('add')}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={file.isPending}
          onClick={() => file.mutate()}
        >
          {t('file')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {t('limits', {
          held: OWN_PRODUCTS.held,
          written: OWN_PRODUCTS.writtenADay,
          sent: OWN_PRODUCTS.sentADay,
        })}{' '}
        {t.rich('source', { off: linkTo(OPEN_FOOD_FACTS), odbl: linkTo(ODBL) })}
      </p>
      {error && error.on === null && (
        <p role="alert" className="text-sm text-destructive">
          {error.text}
        </p>
      )}
      {mine.isLoading && <Skeleton className="h-40" />}
      {mine.isError && <LoadFailed error={mine.error} onRetry={() => void mine.refetch()} />}
      {mine.data && items.length === 0 && (
        <EmptyState icon={Barcode} title={t('emptyTitle')} description={t('emptyBody')} />
      )}
      <ul className="space-y-3">
        {items.map((product) => (
          <li key={product.id}>
            <Card>
              <CardContent className="space-y-2 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="break-words font-medium">{product.name}</p>
                    <p className="break-words text-xs text-muted-foreground">
                      {[product.brand, product.pack, product.code].filter(Boolean).join(DOT)}
                    </p>
                  </div>
                  <span
                    className={cn(
                      'whitespace-nowrap rounded px-1.5 py-0.5 text-2xs font-medium',
                      product.state === 'rejected'
                        ? 'bg-warning/15 text-warning'
                        : 'bg-muted text-muted-foreground',
                    )}
                  >
                    {t(product.correction ? 'state.correction' : `state.${product.state}`)}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {held(
                    t('figures', {
                      kcal: Math.round(product.per100.calories ?? 0),
                      unit: unitName(product.unit),
                    }),
                  )}
                  {DOT}
                  {t('macros', {
                    protein: grams(product.per100.protein),
                    fat: grams(product.per100.fat),
                    carbs: grams(product.per100.carbs),
                  })}
                </p>
                {product.reason && (
                  <p className="break-words text-xs text-warning">
                    {t('reason', { reason: product.reason })}
                  </p>
                )}
                {product.doubtful && <p className="text-xs text-warning">{t('doubtful')}</p>}
                {product.correction && product.code && (
                  <p className="text-xs text-muted-foreground">
                    {t.rich('correctionNote', { off: linkTo(offProductPage(product.code)) })}
                  </p>
                )}
                <div className="flex flex-wrap gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => setWriting({ product })}
                  >
                    {t('edit')}
                  </Button>
                  {/* A correction stays its author's: the base has the product it corrects. */}
                  {product.correction ? null : product.state === 'sent' ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => withdraw.mutate(product.id)}
                    >
                      {t('withdraw')}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy || !sendable(product)}
                      aria-describedby={sendable(product) ? undefined : `${product.id}-needs`}
                      onClick={() => setAsking({ id: product.id, what: 'send' })}
                    >
                      {t('send')}
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => setAsking({ id: product.id, what: 'remove' })}
                  >
                    {t('remove')}
                  </Button>
                </div>
                {error?.on === product.id && (
                  <p role="alert" className="break-words text-xs text-destructive">
                    {error.text}
                  </p>
                )}
                {!sendable(product) && product.state !== 'sent' && !product.correction && (
                  <p id={`${product.id}-needs`} className="text-xs text-muted-foreground">
                    {t('sendNeeds')}
                  </p>
                )}
                {asking?.id === product.id && (
                  <div className="space-y-2 rounded-md border border-border bg-muted/40 p-3 text-xs">
                    <p>{t(asking.what === 'send' ? 'sendNote' : 'removeNote')}</p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant={asking.what === 'remove' ? 'destructive' : 'primary'}
                        disabled={busy}
                        onClick={() =>
                          asking.what === 'send'
                            ? send.mutate(product.id)
                            : remove.mutate(product.id)
                        }
                      >
                        {t(asking.what === 'send' ? 'sendConfirm' : 'removeConfirm')}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setAsking(null)}
                      >
                        {t('cancel')}
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
      {writing && (
        <Dialog
          open
          onClose={() => setWriting(null)}
          label={t(writing.product ? 'editTitle' : 'addTitle')}
          className="max-w-xl"
        >
          <div className="space-y-3 p-4">
            <h2 className="font-semibold">{t(writing.product ? 'editTitle' : 'addTitle')}</h2>
            <OwnProductForm
              product={writing.product}
              onSaved={() => {
                setWriting(null);
                setError(null);
              }}
              onCancel={() => setWriting(null)}
            />
          </div>
        </Dialog>
      )}
    </div>
  );
}
