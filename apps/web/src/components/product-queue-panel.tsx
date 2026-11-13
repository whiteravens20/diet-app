// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import type { ProductQueue, ProductUnderReview } from '@diet-app/shared';
import { PRODUCT_REASON_LONGEST } from '@diet-app/shared/constants';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { useUnitName } from '@/lib/ingredient-format';
import { useErrorText } from '@/lib/use-error-text';
import { useFormat } from '@/lib/use-format';
import { DOT } from '@/lib/figure-line';

/** The way to what accounts sent to the base: the panel's or the reviewers'. */
export interface ProductQueueApi {
  queue: () => Promise<ProductQueue>;
  accept: (id: string, updatedAt: string) => Promise<unknown>;
  reject: (id: string, updatedAt: string, reason: string) => Promise<unknown>;
}

/**
 * What accounts sent to the base of products, the longest waiting first, for
 * whoever reviews it: every figure the product has, what does not add up, and
 * a word on each. Who sent one is not said.
 */
export function ProductQueuePanel({
  source,
  onChanged,
}: {
  source: ProductQueueApi;
  onChanged?: () => void;
}) {
  const t = useTranslations('productReview');
  const errorText = useErrorText();
  const [queue, setQueue] = useState<ProductQueue | null>(null);
  const [error, setError] = useState<string | null>(null);

  const read = useCallback(async (): Promise<void> => {
    try {
      setQueue(await source.queue());
    } catch (e) {
      setError(errorText(e));
    }
  }, [source, errorText]);
  useEffect(() => {
    void (async () => {
      await read();
    })();
  }, [read]);

  const decide = async (act: () => Promise<unknown>): Promise<void> => {
    setError(null);
    try {
      await act();
      onChanged?.();
    } catch (e) {
      setError(errorText(e));
    }
    await read();
  };

  if (!queue) {
    return error ? (
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
    ) : (
      <p className="text-sm text-muted-foreground">{t('loading')}</p>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t('explain')}</p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {queue.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('nothing')}</p>
      ) : (
        <p className="text-sm text-muted-foreground">{t('waiting', { count: queue.total })}</p>
      )}
      <ul className="space-y-3">
        {queue.items.map((product) => (
          <ProductToReview
            key={product.id}
            product={product}
            onAccept={() => decide(() => source.accept(product.id, product.updatedAt))}
            onReject={(reason) =>
              decide(() => source.reject(product.id, product.updatedAt, reason))
            }
          />
        ))}
      </ul>
    </div>
  );
}

function ProductToReview({
  product,
  onAccept,
  onReject,
}: {
  product: ProductUnderReview;
  onAccept: () => Promise<void>;
  onReject: (reason: string) => Promise<void>;
}) {
  const t = useTranslations('productReview');
  const tFigure = useTranslations('products');
  const fmt = useFormat();
  const unitName = useUnitName();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (act: () => Promise<void>): Promise<void> => {
    setBusy(true);
    await act();
    setBusy(false);
  };
  const { per100 } = product;
  const rows: [string, number | null][] = [
    [tFigure('calories'), per100.calories],
    [tFigure('protein'), per100.protein],
    [tFigure('fat'), per100.fat],
    [tFigure('saturatedFat'), per100.saturatedFat],
    [tFigure('carbs'), per100.carbs],
    [tFigure('sugars'), per100.sugars],
    [tFigure('fiber'), per100.fiber],
    [tFigure('salt'), per100.salt],
  ];
  return (
    <li className="space-y-2 rounded-md border border-border p-3 text-sm">
      <div>
        <p className="break-words font-medium">{fmt.text(product.name)}</p>
        <p className="break-words text-xs text-muted-foreground">
          {fmt.text([product.brand, product.pack, product.code].filter(Boolean).join(DOT))}
        </p>
        {product.sentAt && (
          <p className="text-xs text-muted-foreground">{fmt.moment(product.sentAt)}</p>
        )}
      </div>
      <p className="text-xs font-medium">{tFigure('in100', { unit: unitName(product.unit) })}</p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs sm:grid-cols-4">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-2">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="tabular-nums">{value === null ? '—' : fmt.number(value, 2)}</dd>
          </div>
        ))}
      </dl>
      {product.doubtful && <p className="text-xs text-warning">{t('doubtful')}</p>}
      {rejecting ? (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (reason.trim() !== '') void run(() => onReject(reason.trim()));
          }}
        >
          <Field label={t('reason')}>
            <Input
              value={reason}
              required
              maxLength={PRODUCT_REASON_LONGEST}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" variant="destructive" disabled={busy}>
              {t('rejectConfirm')}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setRejecting(false)}>
              {tFigure('cancel')}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" disabled={busy} onClick={() => void run(onAccept)}>
            {t('accept')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => setRejecting(true)}
          >
            {t('reject')}
          </Button>
        </div>
      )}
    </li>
  );
}
