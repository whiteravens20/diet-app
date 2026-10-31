// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { Network } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { adminApi, type AdminConnection } from '@/lib/admin-api';
import { useErrorText } from '@/lib/use-error-text';
import { Explain } from './explain';

/**
 * What the API sees of the administrator's own connection: the address it
 * counts requests against, the address the connection came from and the
 * forwarding header. An operator setting up a reverse proxy opens this through
 * the public address and sees at once whether the API knows who its clients
 * are, or takes the proxy for all of them.
 */
export function ConnectionCard() {
  const t = useTranslations('admin.connection');
  const errorText = useErrorText();
  const [connection, setConnection] = useState<AdminConnection | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setConnection(await adminApi.connection());
      } catch (err) {
        setError(errorText(err, t('loadFailed')));
      }
    })();
  }, [t, errorText]);

  const trust = (setting: AdminConnection['trustProxy']): string =>
    setting === false
      ? t('trustOff')
      : typeof setting === 'number'
        ? t('trustHops', { count: setting })
        : setting.join(', ');

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Network size={18} aria-hidden />
          {t('title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <Explain>
          <p>{t('intro')}</p>
        </Explain>
        {error && <p className="text-destructive">{error}</p>}
        {connection && (
          <>
            {connection.countedAsProxy && (
              <p
                role="status"
                className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-warning"
              >
                {t('countedAsProxy')}
              </p>
            )}
            {connection.overTrusted && (
              <p
                role="status"
                className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-warning"
              >
                {connection.forwardedHops === 0
                  ? t('overTrustedDirect')
                  : t('overTrusted', { passed: connection.forwardedHops })}
              </p>
            )}
            <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[12rem_1fr]">
              <dt className="text-muted-foreground">{t('clientAddress')}</dt>
              <dd>
                <code>{connection.clientAddress ?? '—'}</code>
                <span className="block text-xs text-muted-foreground">
                  {t('clientAddressHint')}
                </span>
              </dd>
              <dt className="text-muted-foreground">{t('peerAddress')}</dt>
              <dd>
                <code>{connection.peerAddress ?? '—'}</code>
              </dd>
              <dt className="text-muted-foreground">{t('forwardedFor')}</dt>
              <dd>
                {connection.forwardedFor ? <code>{connection.forwardedFor}</code> : t('notSent')}
              </dd>
              <dt className="text-muted-foreground">{t('trustProxy')}</dt>
              <dd>{trust(connection.trustProxy)}</dd>
            </dl>
          </>
        )}
      </CardContent>
    </Card>
  );
}
