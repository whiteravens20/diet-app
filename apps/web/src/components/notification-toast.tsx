// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { useNotificationText, useUnreadNotifications } from '@/components/notifications-bell';

/** Where a browser keeps which notifications it has said once already. */
const SAID = 'diet-app.notifications.said';
/** How long a notification stays on the page before it goes by itself. */
const STAYS_MS = 10_000;

function saidBefore(): readonly string[] {
  try {
    const kept = JSON.parse(localStorage.getItem(SAID) ?? '[]') as unknown;
    return Array.isArray(kept) ? kept.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * A new notification, said once on the page it arrives on: what it is, a way
 * to mark it read and a way to put it aside. The bell keeps counting what is
 * unread; this is for the moment something comes in.
 *
 * "New" is for the browser to know: it keeps the notifications it has said,
 * for as long as they are unread, so one is not said again on every page.
 * It goes by itself after ten seconds, and is then said too.
 */
export function NotificationToast() {
  const t = useTranslations('notifications');
  const textOf = useNotificationText();
  const qc = useQueryClient();
  const { hasToken, list } = useUnreadNotifications();
  const [said, setSaid] = useState<readonly string[]>(saidBefore);

  const fresh = list.filter((notification) => !said.includes(notification.id));
  const freshIds = fresh.map((notification) => notification.id).join(',');

  /** Everything unread now has been said: what was read since is forgotten with it. */
  const putAside = (): void => {
    const now = list.map((notification) => notification.id);
    setSaid(now);
    try {
      localStorage.setItem(SAID, JSON.stringify(now));
    } catch {
      // A browser that keeps nothing says a notification again on the next page.
    }
  };
  // The timer is set once for what is on show, and puts aside what is unread when it runs out.
  const whenOver = useRef(putAside);
  useEffect(() => {
    whenOver.current = putAside;
  });
  useEffect(() => {
    if (freshIds === '') return;
    const timer = setTimeout(() => whenOver.current(), STAYS_MS);
    return () => clearTimeout(timer);
  }, [freshIds]);

  const markRead = useMutation({
    mutationFn: () => (fresh.length === list.length ? api.post('/notifications/read-all') : Promise.all(fresh.map((notification) => api.post(`/notifications/${notification.id}/read`)))),
    onSettled: () => {
      putAside();
      void qc.invalidateQueries({ queryKey: ['notifications-unread'] });
    },
  });

  if (!hasToken || fresh.length === 0) return null;

  return (
    <div
      role="status"
      // Under the bar a narrow screen has over the page, so that the navigation stays in reach; in the corner of a wide one.
      className="pop-in fixed inset-x-4 top-16 z-50 mx-auto max-w-sm rounded-lg border border-border bg-card p-4 text-card-foreground shadow-lg md:inset-x-auto md:right-4 md:top-4 md:mx-0"
    >
      <p className="text-sm font-medium">{t('toastTitle', { count: fresh.length })}</p>
      {fresh.length === 1 && <p className="mt-1 text-sm text-muted-foreground">{textOf(fresh[0]!)}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" disabled={markRead.isPending} onClick={() => markRead.mutate()}>
          {t('toastMarkRead', { count: fresh.length })}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={putAside}>
          {t('dismiss')}
        </Button>
      </div>
    </div>
  );
}
