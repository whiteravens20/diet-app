// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { Barcode, LoaderCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { adminApi, type AdminProducts } from '@/lib/admin-api';
import { useErrorText } from '@/lib/use-error-text';
import { useFormat } from '@/lib/use-format';
import { Explain } from './explain';

/** How often the card reads the state while the worker is at it, or about to be. */
const READ_EVERY_MS = 5_000;

/** Whether the last import failed: an instance without one is no fault. */
export function productImportNeedsAttention(products: AdminProducts | null | undefined): boolean {
  return products?.import.status === 'error';
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
          </>
        )}
      </CardContent>
    </Card>
  );
}
