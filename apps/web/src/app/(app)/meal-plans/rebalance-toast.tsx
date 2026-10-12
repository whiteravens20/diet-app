// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';
import type { RebalanceResult } from '@diet-app/shared';
import { Button } from '@/components/ui/button';

/**
 * Rebalance toast: a bottom-right card summarising the auto-rebalance, with
 * "undo last rebalance" (restores the pre-edit scales), "rebalance the rest of
 * the week", and dismiss. Auto-dismisses after 10 s.
 */
export function RebalanceToast({
  rebalance,
  busy,
  onUndo,
  onRebalanceWeek,
  onDismiss,
}: {
  rebalance: NonNullable<RebalanceResult['rebalance']>;
  busy: boolean;
  onUndo: () => void;
  onRebalanceWeek: () => void;
  onDismiss: () => void;
}) {
  const t = useTranslations('mealPlans');
  // Keep the auto-dismiss timer stable across parent re-renders: the latest
  // onDismiss lives in a ref (updated in an effect, never during render) so the
  // 10 s timer is armed exactly once.
  const dismiss = useRef(onDismiss);
  useEffect(() => {
    dismiss.current = onDismiss;
  }, [onDismiss]);
  useEffect(() => {
    const id = setTimeout(() => dismiss.current(), 10_000);
    return () => clearTimeout(id);
  }, []);

  return (
    <div className="fixed bottom-4 right-4 z-50 max-w-sm rounded-lg border border-border bg-background p-4 shadow-lg">
      <p className="text-sm font-medium">{t('rebalanceTitle')}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        {t('rebalanceSummary', {
          before: Math.round(rebalance.macrosBefore.calories),
          after: Math.round(rebalance.macrosAfter.calories),
          count: rebalance.changes.length,
        })}
      </p>
      {rebalance.feasibility === 'best-effort' && (
        <p className="mt-1 text-xs text-warning">{t('rebalanceBestEffort')}</p>
      )}
      {rebalance.unabsorbedKcal !== 0 && (
        <p className="mt-1 text-xs text-warning">
          {t(rebalance.unabsorbedKcal > 0 ? 'rebalanceLeftOver' : 'rebalanceLeftUnder', { kcal: Math.abs(rebalance.unabsorbedKcal) })}
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onUndo} disabled={busy}>
          {t('rebalanceUndo')}
        </Button>
        {rebalance.scope === 'day' && (
          <Button type="button" variant="outline" size="sm" onClick={onRebalanceWeek} disabled={busy}>
            {t('rebalanceWeek')}
          </Button>
        )}
        <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
          {t('rebalanceDismiss')}
        </Button>
      </div>
    </div>
  );
}
