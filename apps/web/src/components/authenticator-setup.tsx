// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import { QRCodeSVG } from 'qrcode.react';
import type { SecondFactorSetup } from '@diet-app/shared';

/** A key in groups of four, as it is easier to read off one screen and type into another. */
const grouped = (key: string): string => key.match(/.{1,4}/g)?.join(' ') ?? key;

/**
 * What an authenticator app needs to take a secret over: the QR code it
 * scans, and the same secret as text for an app that cannot scan. The code
 * is drawn here, in the page: the secret goes to no other place.
 */
export function AuthenticatorSetup({ setup }: { setup: SecondFactorSetup }) {
  const t = useTranslations('secondFactor');
  return (
    <div className="space-y-3">
      <p className="text-sm">{t('scan')}</p>
      {/* White around the code whatever the theme: a camera reads dark on light. */}
      <div className="inline-block rounded-md bg-white p-3">
        <QRCodeSVG value={setup.uri} size={176} title={t('qrLabel')} />
      </div>
      <p className="text-sm text-muted-foreground">{t('typeInstead')}</p>
      <p data-testid="authenticator-key" className="break-all font-mono text-sm tracking-wider">
        {grouped(setup.secret)}
      </p>
    </div>
  );
}
