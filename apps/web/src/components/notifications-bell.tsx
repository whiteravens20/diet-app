'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { Bell } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import type { Notification, WeightReminderPayload } from '@diet-app/shared';
import { api, tokenStore } from '@/lib/api';
import { Button } from '@/components/ui/button';

const POLL_INTERVAL_MS = 60_000;

/**
 * F19 — unread-notification bell with a small dropdown. Polls the API every
 * 60s when a session is active; the same row shape feeds the future Android
 * surface, so this component is the web-only render of a shared contract.
 */
export function NotificationsBell() {
  const t = useTranslations('notifications');
  const tBody = useTranslations('notifications.weight_reminder');
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // Only poll once an access token is present — otherwise unauthenticated
  // public pages would spam 401s.
  const hasToken = tokenStore.access !== null;

  const unread = useQuery({
    queryKey: ['notifications-unread'],
    queryFn: () => api.get<Notification[]>('/notifications/unread'),
    enabled: hasToken,
    refetchInterval: hasToken ? POLL_INTERVAL_MS : false,
    refetchOnWindowFocus: true,
  });

  const markRead = useMutation({
    mutationFn: (id: string) => api.post(`/notifications/${id}/read`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications-unread'] }),
  });
  const markAllRead = useMutation({
    mutationFn: () => api.post('/notifications/read-all'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications-unread'] }),
  });

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const list = unread.data ?? [];
  const count = list.length;

  function renderBody(n: Notification): string {
    if (n.type === 'weight_reminder') {
      const p = (n.payload ?? null) as WeightReminderPayload | null;
      const days = p?.daysSinceLastEntry ?? 0;
      return days > 0
        ? tBody('withHistory', { days })
        : tBody('noHistory');
    }
    return n.type;
  }

  if (!hasToken) return null;

  return (
    <div ref={ref} className="relative z-50">
      <button
        type="button"
        aria-label={t('label')}
        onClick={() => setOpen((o) => !o)}
        className="relative inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Bell size={16} aria-hidden />
        {count > 0 && (
          <span className="absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground">
            {count > 9 ? '9+' : count}
          </span>
        )}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, scale: 0.97, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: -4 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="absolute left-0 top-full z-50 mt-2 w-72 rounded-md border border-border bg-card text-card-foreground shadow-lg"
            role="dialog"
            aria-label={t('label')}
          >
            <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
              <span className="text-sm font-medium">{t('title')}</span>
              {count > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-xs"
                  disabled={markAllRead.isPending}
                  onClick={() => markAllRead.mutate()}
                >
                  {t('markAllRead')}
                </Button>
              )}
            </div>
            <ul className="max-h-72 overflow-y-auto">
              {count === 0 ? (
                <li className="px-3 py-6 text-center text-xs text-muted-foreground">
                  {t('empty')}
                </li>
              ) : (
                list.map((n) => (
                  <li
                    key={n.id}
                    className="flex items-start justify-between gap-2 border-b border-border/60 px-3 py-2 last:border-b-0"
                  >
                    <span className="flex-1 text-sm">{renderBody(n)}</span>
                    <button
                      type="button"
                      onClick={() => markRead.mutate(n.id)}
                      disabled={markRead.isPending}
                      className="shrink-0 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                    >
                      {t('dismiss')}
                    </button>
                  </li>
                ))
              )}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
