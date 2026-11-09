// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import { Card, CardContent } from '@/components/ui/card';
import { PageBanner } from '@/components/page-banner';
import { SplitCalculator } from '@/components/split-calculator';
import { IMAGERY } from '@/lib/imagery';

/**
 * A cooked dish split into its portions, on its own: equal ones, or by the
 * energy typed for each. Nothing is asked of the API and nothing is kept; a
 * dish cooked ahead is split from its plan, with the plan's shares.
 */
export default function SplitPage() {
  const t = useTranslations('split');
  return (
    <div className="space-y-8">
      <PageBanner image={IMAGERY.split} title={t('pageTitle')} subtitle={t('pageIntro')} />
      <Card className="max-w-2xl">
        <CardContent className="pt-6">
          <SplitCalculator />
        </CardContent>
      </Card>
    </div>
  );
}
