// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';
import { useTranslations } from 'next-intl';
import { Check, Clock, X } from 'lucide-react';
import { type DraftLocaleReview, type DraftPastReview } from '@/lib/admin-api';
import { useFormat } from '@/lib/use-format';

export type DraftStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'SHIPPED';

export type LocaleReviewRow = DraftLocaleReview;

/**
 * Per-locale review matrix — one chip per locale expected on the draft,
 * coloured by its latest review action (APPROVE / REJECT / no review yet).
 * Replaces the single status badge so reviewers can see at a glance which
 * locales are still blocking a ship.
 *
 * `compact` mode is used inside the recipe row's collapsed header — chips
 * carry no reviewer label, just locale + icon. The expanded body uses the
 * full mode, which includes reviewer label and reject reason.
 */
export function LocaleReviewMatrix({
  expectedLocales,
  localeReviews,
  pastReviews = [],
  status,
  compact = false,
}: {
  expectedLocales: string[];
  localeReviews: LocaleReviewRow[];
  /** What was decided before: reviews a later review or an edit took the place of. */
  pastReviews?: DraftPastReview[];
  status: DraftStatus;
  compact?: boolean;
}) {
  const t = useTranslations('admin.curation');
  const fmt = useFormat();
  const reviewByLocale = new Map<string, LocaleReviewRow>(localeReviews.map((r) => [r.locale, r]));

  const pendingLocales = expectedLocales.filter((l) => !reviewByLocale.has(l));
  const rejectedLocales = expectedLocales.filter((l) => reviewByLocale.get(l)?.action === 'REJECT');

  const shipState =
    status === 'SHIPPED'
      ? 'shipped'
      : rejectedLocales.length > 0
        ? 'rejected'
        : pendingLocales.length > 0
          ? 'pending'
          : 'ready';

  return (
    <div className={compact ? 'flex flex-wrap items-center gap-1' : 'mt-2 space-y-1.5'}>
      <div className="flex flex-wrap items-center gap-1">
        {expectedLocales.map((locale) => {
          const review = reviewByLocale.get(locale);
          const tone =
            review?.action === 'APPROVE'
              ? 'border-success/40 bg-success/10 text-success'
              : review?.action === 'REJECT'
                ? 'border-destructive/40 bg-destructive/10 text-destructive'
                : 'border-border bg-muted text-muted-foreground';
          const Icon =
            review?.action === 'APPROVE' ? Check : review?.action === 'REJECT' ? X : Clock;
          return (
            <span
              key={locale}
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${tone}`}
              title={
                review
                  ? review.action === 'APPROVE'
                    ? t('matrixApproved', {
                        locale: locale.toUpperCase(),
                        label: review.reviewedByLabel,
                      })
                    : t('matrixRejected', {
                        locale: locale.toUpperCase(),
                        label: review.reviewedByLabel,
                      })
                  : t('matrixPending', { locale: locale.toUpperCase() })
              }
            >
              <span className="font-medium uppercase tracking-wide">{locale}</span>
              <Icon className="h-3 w-3" />
              {!compact && review ? (
                <span className="truncate">{review.reviewedByLabel}</span>
              ) : null}
            </span>
          );
        })}
      </div>

      {!compact && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {shipState === 'shipped' && (
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <Check className="h-3 w-3" />
              {t('shipStateShipped')}
            </span>
          )}
          {shipState === 'ready' && (
            <span className="inline-flex items-center gap-1 text-success">
              <Check className="h-3 w-3" />
              {t('shipStateReady')}
            </span>
          )}
          {shipState === 'pending' && (
            <span className="text-muted-foreground">
              {t('shipStateBlockedPending', {
                count: pendingLocales.length,
                locales: pendingLocales.map((l) => l.toUpperCase()).join(', '),
              })}
            </span>
          )}
          {shipState === 'rejected' && (
            <span className="text-destructive">
              {t('shipStateBlockedRejected', {
                count: rejectedLocales.length,
                locales: rejectedLocales.map((l) => l.toUpperCase()).join(', '),
              })}
            </span>
          )}
        </div>
      )}

      {!compact &&
        localeReviews
          .filter((r) => r.action === 'REJECT' && r.reason)
          .map((r) => (
            <p key={`reason-${r.locale}-${r.reviewedAt}`} className="text-xs text-muted-foreground">
              {t('matrixRejectedReason', { locale: r.locale.toUpperCase(), reason: r.reason! })}
            </p>
          ))}

      {!compact && pastReviews.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">
            {t('pastReviews', { count: pastReviews.length })}
          </summary>
          <ul className="mt-1 space-y-0.5">
            {pastReviews.map((r) => (
              <li key={`${r.locale}-${r.reviewedAt}-${r.supersededAt}`}>
                {t(r.action === 'APPROVE' ? 'pastApproved' : 'pastRejected', {
                  locale: r.locale.toUpperCase(),
                  label: r.reviewedByLabel,
                  role: r.byRole ?? 'unknown',
                  when: fmt.moment(r.reviewedAt),
                })}
                {r.reason ? ` — ${r.reason}` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

// ── Ship bar ────────────────────────────────────────────────────────────────
