// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { WifiOff } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

/**
 * The page the service worker answers with when the server cannot be reached
 * and the page that was asked for was never opened in this browser. The
 * worker reads it once, when it is installed, and keeps it. It asks for
 * nothing itself: a link leads to a page, which is opened from what was kept
 * or brings the reader back here.
 */
export default async function OfflinePage() {
  const t = await getTranslations('offline');
  const tNav = await getTranslations('nav');
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <Card className="w-full max-w-xl">
        <CardContent className="flex flex-col items-center gap-4 py-10 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-warning/10 text-warning">
            <WifiOff size={28} strokeWidth={1.75} aria-hidden />
          </span>
          <h1 className="text-lg font-semibold tracking-tight">{t('pageTitle')}</h1>
          <p className="max-w-sm text-sm text-muted-foreground">{t('pageBody')}</p>
          <div className="flex flex-wrap justify-center gap-2 pt-1">
            <Link href="/shopping-lists" prefetch={false} className={buttonVariants({ size: 'md' })}>
              {tNav('shoppingLists')}
            </Link>
            <Link href="/meal-plans" prefetch={false} className={buttonVariants({ variant: 'outline', size: 'md' })}>
              {tNav('mealPlans')}
            </Link>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
