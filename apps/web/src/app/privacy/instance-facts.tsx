// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import { useConfig } from '@/lib/use-config';

/**
 * What this instance sends out as its operator set it up: whether it asks Open Food Facts about codes, whether it
 * sends mail, and whether its sign-in pages load Turnstile's check. Nothing is said before the instance has answered.
 */
export function InstanceFacts() {
  const t = useTranslations('privacy.out');
  const { data: config } = useConfig();
  if (!config) return null;
  return (
    <>
      <li>{t(config.products.lookups ? 'lookups' : 'noLookups')}</li>
      <li>{t(config.email.enabled ? 'mail' : 'noMail')}</li>
      {config.turnstile.enabled ? <li>{t('turnstile')}</li> : null}
    </>
  );
}
