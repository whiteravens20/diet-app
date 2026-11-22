// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import { useConfig } from '@/lib/use-config';

/**
 * A sentence of the landing page that names how many recipes or ingredients this instance's catalogue holds, read
 * from its configuration; until that is read, or where it cannot be, the same sentence without the number.
 */
export function CatalogueSentence({ kind }: { kind: 'plans' | 'counted' }) {
  const t = useTranslations('landing.points');
  const { data: config } = useConfig();
  const catalogue = config?.catalogue;
  if (!catalogue) return <>{t(`${kind}BodyPlain`)}</>;
  return kind === 'plans' ? (
    <>{t('plansBody', { recipes: catalogue.recipes })}</>
  ) : (
    <>{t('countedBody', { ingredients: catalogue.ingredients })}</>
  );
}
