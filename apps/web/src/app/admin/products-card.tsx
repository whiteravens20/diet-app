// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { Barcode, LoaderCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import type { AcceptedProducts } from '@diet-app/shared';
import { PRODUCT_REASON_LONGEST } from '@diet-app/shared/constants';
import { ProductQueuePanel, type ProductQueueApi } from '@/components/product-queue-panel';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { adminApi, type AdminProducts } from '@/lib/admin-api';
import { useUnitName } from '@/lib/ingredient-format';
import { useErrorText } from '@/lib/use-error-text';
import { useFormat } from '@/lib/use-format';
import { Explain } from './explain';
import { DOT, held } from '@/lib/figure-line';

/** How often the card reads the state while the worker is at it, or about to be. */
const READ_EVERY_MS = 5_000;

/** What the administrator does with products sent to the base. */
const PRODUCT_QUEUE: ProductQueueApi = {
  queue: () => adminApi.productQueue(),
  accept: (id, updatedAt) => adminApi.acceptProduct(id, updatedAt),
  reject: (id, updatedAt, reason) => adminApi.rejectProduct(id, updatedAt, reason),
};

/** Whether the last import failed, or a product waits for a word: an instance without either is no fault. */
export function productImportNeedsAttention(products: AdminProducts | null | undefined): boolean {
  return products?.import.status === 'error' || (products?.held.waiting ?? 0) > 0;
}

/**
 * The products the instance accepted, the latest first: who took each and
 * whether its author still has an account, and a way to withdraw one, with what
 * its author is told.
 */
function AcceptedProductsList({
  readAgain,
  onChanged,
}: {
  /** Grows when something changed what the list holds. */
  readAgain: number;
  onChanged: () => void;
}) {
  const t = useTranslations('admin.products');
  const tFigure = useTranslations('products');
  const fmt = useFormat();
  const errorText = useErrorText();
  const unitName = useUnitName();
  const [page, setPage] = useState(1);
  const [list, setList] = useState<AcceptedProducts | null>(null);
  const [withdrawing, setWithdrawing] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const read = useCallback(async (): Promise<void> => {
    try {
      setList(await adminApi.acceptedProducts(page));
    } catch (err) {
      setError(errorText(err));
    }
  }, [page, errorText]);
  useEffect(() => {
    void (async () => {
      await read();
    })();
  }, [read, readAgain]);

  const withdraw = async (id: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await adminApi.withdrawProduct(id, reason.trim());
      setWithdrawing(null);
      setReason('');
      // Whoever holds the list reads it again.
      onChanged();
    } catch (err) {
      setError(errorText(err));
      await read();
    }
    setBusy(false);
  };

  if (!list) {
    return error ? (
      <p role="alert" className="text-destructive">
        {error}
      </p>
    ) : (
      <p className="text-muted-foreground">{t('acceptedLoading')}</p>
    );
  }
  return (
    <div className="space-y-2">
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {list.items.length === 0 && <p className="text-muted-foreground">{t('acceptedNone')}</p>}
      <ul className="space-y-2">
        {list.items.map((product) => (
          <li key={product.id} className="space-y-1 rounded-md border border-border p-3">
            <p className="break-words font-medium">{product.name}</p>
            <p className="break-words text-xs text-muted-foreground">
              {[
                product.brand,
                product.code,
                held(
                  tFigure('figures', {
                    kcal: Math.round(product.per100.calories ?? 0),
                    unit: unitName(product.unit),
                  }),
                ),
              ]
                .filter(Boolean)
                .join(DOT)}
            </p>
            <p className="text-xs text-muted-foreground">
              {product.acceptedBy
                ? t('acceptedWhen', {
                    when: fmt.moment(product.acceptedAt),
                    by: product.acceptedBy,
                  })
                : t('acceptedOn', { when: fmt.moment(product.acceptedAt) })}
              {!product.hasAuthor && ` ${t('acceptedNoAuthor')}`}
            </p>
            {withdrawing === product.id ? (
              <form
                className="space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (reason.trim() !== '') void withdraw(product.id);
                }}
              >
                <Field label={t('withdrawReason')} hint={t('withdrawHint')}>
                  <Input
                    value={reason}
                    required
                    maxLength={PRODUCT_REASON_LONGEST}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </Field>
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" size="sm" variant="destructive" disabled={busy}>
                    {t('withdrawConfirm')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setWithdrawing(null)}
                  >
                    {tFigure('cancel')}
                  </Button>
                </div>
              </form>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setReason('');
                  setWithdrawing(product.id);
                }}
              >
                {t('withdraw')}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {list.totalPages > 1 && (
        <div className="flex items-center gap-2 text-xs">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
          >
            {t('prev')}
          </Button>
          <span>{t('pageOf', { page: list.page, pages: list.totalPages })}</span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={page >= list.totalPages}
            onClick={() => setPage(page + 1)}
          >
            {t('next')}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * What the instance holds of products with a barcode and how it gets them:
 * the settings, how the last import went, country by country, and a run asked
 * for now instead of at night.
 */
export function ProductsCard({
  products,
  onChanged,
}: {
  /** Null until it is read. */
  products: AdminProducts | null;
  onChanged: (products: AdminProducts) => void;
}) {
  const t = useTranslations('admin.products');
  const fmt = useFormat();
  const errorText = useErrorText();
  const [error, setError] = useState<string | null>(null);

  const going = products?.import.status === 'running' || Boolean(products?.askedAt);
  useEffect(() => {
    if (!going) return;
    const reading = setInterval(() => {
      void adminApi.products().then(onChanged, () => undefined);
    }, READ_EVERY_MS);
    return () => clearInterval(reading);
  }, [going, onChanged]);

  const ask = async (): Promise<void> => {
    setError(null);
    try {
      await adminApi.askForProductImport();
      onChanged(await adminApi.products());
    } catch (err) {
      setError(errorText(err));
    }
  };

  const [changes, setChanges] = useState(0);
  const changed = (): void => {
    setChanges((count) => count + 1);
    void adminApi.products().then(onChanged, () => undefined);
  };

  const run = products?.import;
  const failure = (): string => {
    switch (run?.reason) {
      case 'source':
        return t('failedSource');
      case 'format':
        return t('failedFormat');
      case 'nothing':
        return t('failedNothing');
      case 'shrunk':
        return t('failedShrunk');
      default:
        return t('failedOther', { error: run?.error ?? '' });
    }
  };
  const brought = run ? Object.entries(run.perCountry) : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Barcode className="h-5 w-5" /> {t('title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <Explain>
          <p>{t('explain')}</p>
        </Explain>
        {!products || !run ? (
          <p role="status" className="text-muted-foreground">
            <LoaderCircle className="mr-2 inline h-4 w-4 animate-spin" aria-hidden />
            {t('title')}
          </p>
        ) : (
          <>
            <ul className="space-y-1">
              <li>
                {products.lookups
                  ? t('lookupsOn', { count: products.lookupsToday })
                  : t('lookupsOff')}
              </li>
              <li>
                {products.countries.length > 0
                  ? t('countries', { countries: products.countries.join(', ') })
                  : t('noCountries')}
              </li>
              <li>
                {t('held', {
                  imported: products.held.imported,
                  lookedUp: products.held.lookedUp,
                  unknown: products.held.unknownCodes,
                  accepted: products.held.accepted,
                })}
              </li>
            </ul>

            {products.countries.length > 0 && (
              <div className="space-y-2 border-t border-border pt-3" aria-live="polite">
                {run.status === 'idle' && <p>{t('never')}</p>}
                {run.status === 'running' && (
                  <p role="status">
                    <LoaderCircle className="mr-2 inline h-4 w-4 animate-spin" aria-hidden />
                    {t('running', { read: run.read })}
                  </p>
                )}
                {run.status === 'done' && (
                  <p>
                    {t('done', {
                      when: fmt.moment(run.finishedAt ?? run.startedAt!),
                      added: run.added,
                      changed: run.changed,
                      removed: run.removed,
                      read: run.read,
                    })}
                  </p>
                )}
                {run.status === 'error' && (
                  <div className="rounded-md border border-warning/40 bg-warning/5 p-2">
                    <p>{t('failedAt', { when: fmt.moment(run.startedAt ?? run.finishedAt!) })}</p>
                    <p>{failure()}</p>
                  </div>
                )}
                {run.status !== 'running' && run.status !== 'idle' && brought.length > 0 && (
                  <>
                    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
                      {brought.map(([country, count]) => (
                        <li key={country}>{t('perCountry', { country, count })}</li>
                      ))}
                    </ul>
                    <p className="text-xs text-muted-foreground">{t('leftOut', run.leftOut)}</p>
                  </>
                )}
                {run.status === 'done' &&
                  brought
                    .filter(([, count]) => count === 0)
                    .map(([country]) => (
                      <p
                        key={country}
                        className="rounded-md border border-warning/40 bg-warning/5 p-2"
                      >
                        {t('countryEmpty', { country })}
                      </p>
                    ))}
                <p className="text-xs text-muted-foreground">{t('schedule')}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={going || products.askAgainAt !== null}
                    aria-describedby={
                      products.askAgainAt !== null ? 'product-import-again' : undefined
                    }
                    onClick={() => void ask()}
                  >
                    {t('ask')}
                  </Button>
                  {products.askedAt && <span className="text-xs">{t('asked')}</span>}
                  {products.askAgainAt && (
                    <span id="product-import-again" className="text-xs text-muted-foreground">
                      {t('askAgainAt', { when: fmt.moment(products.askAgainAt) })}
                    </span>
                  )}
                </div>
                {error && (
                  <p role="alert" className="text-destructive">
                    {error}
                  </p>
                )}
              </div>
            )}
            <section className="space-y-2 border-t border-border pt-3">
              <h3 className="font-medium">{t('queueTitle')}</h3>
              <ProductQueuePanel source={PRODUCT_QUEUE} onChanged={changed} />
            </section>
            <section className="space-y-2 border-t border-border pt-3">
              <h3 className="font-medium">{t('acceptedTitle')}</h3>
              <AcceptedProductsList readAgain={changes} onChanged={changed} />
            </section>
          </>
        )}
      </CardContent>
    </Card>
  );
}
