// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

/** What a list of drafts is narrowed and paged with. */
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import type { StatusFilter } from './shared';

export function FilterStrip({
  status,
  onStatusChange,
}: {
  status: StatusFilter;
  onStatusChange: (s: StatusFilter) => void;
}) {
  const t = useTranslations('admin.curation');
  const options: StatusFilter[] = ['ALL', 'PENDING', 'APPROVED', 'REJECTED', 'SHIPPED'];
  const labelKey: Record<StatusFilter, string> = {
    ALL: 'statusAll',
    PENDING: 'statusPending',
    APPROVED: 'statusApproved',
    REJECTED: 'statusRejected',
    SHIPPED: 'statusShipped',
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted-foreground">{t('filterStatus')}:</span>
      {options.map((o) => (
        <button
          key={o}
          onClick={() => onStatusChange(o)}
          className={
            o === status
              ? 'rounded-full bg-primary px-2 py-0.5 text-primary-foreground'
              : 'rounded-full border border-border px-2 py-0.5 hover:bg-muted'
          }
        >
          {t(labelKey[o])}
        </button>
      ))}
    </div>
  );
}

export function Pagination({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
}) {
  const t = useTranslations('admin.curation');
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  const last = Math.ceil(total / pageSize);
  return (
    <div className="flex items-center justify-between text-xs text-muted-foreground">
      <span>{t('showing', { from, to, total })}</span>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          {t('prev')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= last}
          onClick={() => onPage(page + 1)}
        >
          {t('next')}
        </Button>
      </div>
    </div>
  );
}

// ── Ingredient draft row ────────────────────────────────────────────────────
