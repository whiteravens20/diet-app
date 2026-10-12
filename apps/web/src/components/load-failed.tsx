// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useErrorText } from '@/lib/use-error-text';

/**
 * What a page shows in the place of its content when the content could not be
 * loaded: why, and a way to try again. A page that showed its empty state
 * here would tell somebody that they have nothing, when it only knows that it
 * could not ask.
 */
export function LoadFailed({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const t = useTranslations('common');
  const errorText = useErrorText();
  return (
    <Card className="mx-auto mt-16 max-w-xl">
      <CardContent className="flex flex-col items-center gap-4 py-10 text-center">
        <p role="alert" className="text-sm">
          {errorText(error, t('error'))}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          {t('retry')}
        </Button>
      </CardContent>
    </Card>
  );
}
