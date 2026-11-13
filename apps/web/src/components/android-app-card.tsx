// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { Smartphone } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useConfig } from '@/lib/use-config';

/**
 * The landing page's card about the Android app: what it is and a link to the
 * page it is downloaded from, where the operator gave that page's address
 * (`ANDROID_APP_URL`). Nothing on an instance that gave none.
 */
export function AndroidAppCard() {
  const t = useTranslations('landing.android');
  const { data: config } = useConfig();
  const url = config?.instance.androidAppUrl;
  if (!url) return null;
  return (
    <section className="mt-12">
      <Card className="flex flex-col gap-4 p-6 sm:flex-row sm:items-center">
        <span className="inline-flex self-start rounded-md bg-muted p-2 text-primary sm:self-center">
          <Smartphone size={20} />
        </span>
        <div className="flex-1">
          <h2 className="font-semibold">{t('title')}</h2>
          <p className="mt-1 text-pretty text-sm text-muted-foreground">{t('body')}</p>
        </div>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className={buttonVariants({ variant: 'outline' })}
        >
          {t('download')}
        </a>
      </Card>
    </section>
  );
}
