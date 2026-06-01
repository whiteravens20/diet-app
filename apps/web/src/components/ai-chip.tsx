'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Sparkles } from 'lucide-react';
import type { AiQuotaStatus, SessionUser } from '@diet-app/shared';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * App-shell AI status chip (F10). Renders nothing when the user's
 * `aiMode === 'none'`, so users who have AI turned off see no extra
 * chrome. For `admin` mode it shows the remaining weekly quota with a
 * tooltip of the rolling-window reset time; for `byok` it shows
 * `BYOK` with a no-quota tooltip. Both link to Settings so the user can
 * change mode in one click.
 *
 * The chip queries `/users/me` and `/ai/quota` separately so the
 * quota refetches after every AI call without re-fetching the whole
 * session. Both queries already exist in other surfaces — sharing the
 * cache key means no extra round-trip on Settings.
 */
export function AiChip({ className }: { className?: string }) {
  const t = useTranslations('aiChip');
  const session = useQuery({
    queryKey: ['session'],
    queryFn: () => api.get<SessionUser>('/users/me'),
  });
  const quota = useQuery({
    queryKey: ['ai-quota'],
    queryFn: () => api.get<AiQuotaStatus>('/ai/quota'),
    // Only fetch when the user has actually opted in to AI — keeps
    // `none` users from making a request they never use.
    enabled: session.data?.aiMode !== undefined && session.data.aiMode !== 'none',
  });

  if (!session.data || session.data.aiMode === 'none') return null;
  const status = quota.data;
  if (!status) return null;

  if (status.mode === 'byok') {
    return (
      <ChipLink
        className={className}
        tone="byok"
        title={t('byokTooltip')}
        label={t('byokLabel')}
      />
    );
  }

  // admin mode
  const limit = status.limit ?? 0;
  const remaining = status.remaining ?? 0;
  const exhausted = remaining === 0;
  const reset = status.resetAt ? new Date(status.resetAt).toLocaleString() : '';

  return (
    <ChipLink
      className={className}
      tone={exhausted ? 'exhausted' : 'admin'}
      title={
        exhausted
          ? t('exhaustedTooltip', { date: reset })
          : t('adminTooltip')
      }
      label={
        exhausted
          ? t('exhaustedLabel', { limit })
          : t('adminLabel', { remaining, limit })
      }
    />
  );
}

function ChipLink({
  className,
  tone,
  title,
  label,
}: {
  className?: string;
  tone: 'admin' | 'byok' | 'exhausted';
  title: string;
  label: string;
}) {
  return (
    <Link
      href="/settings"
      title={title}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors',
        tone === 'admin' &&
          'border-primary/30 bg-primary/10 text-primary hover:bg-primary/15',
        tone === 'byok' &&
          'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-300',
        tone === 'exhausted' &&
          'border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/15',
        className,
      )}
    >
      <Sparkles size={12} aria-hidden />
      <span className="tabular-nums">{label}</span>
    </Link>
  );
}
