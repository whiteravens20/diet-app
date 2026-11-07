// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import type {
  CookedAhead,
  CookingReminderPayload,
  Notification,
  Profile,
  ProductNoticePayload,
  WaterDay,
  WaterReminderPayload,
  WeightReminderPayload,
} from '@diet-app/shared';
import { WATER_AMOUNTS_ML } from '@diet-app/shared/constants';
import { api } from '@/lib/api';
import { held } from '@/lib/figure-line';
import { useErrorText } from '@/lib/use-error-text';
import { useFormat } from '@/lib/use-format';
import { useIsAuthenticated } from '@/lib/use-is-authenticated';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const POLL_INTERVAL_MS = 60_000;

/** How long a reminder of water says what a press added before it goes. */
const ADDED_SHOWN_MS = 4000;

/**
 * The notifications of the account that nobody has read yet, asked for again
 * every minute while a session is open. Whoever shows them asks through here,
 * so that the question goes out once however many do.
 */
export function useUnreadNotifications() {
  // Only poll once an access token is present — otherwise unauthenticated
  // public pages would spam 401s. Resolved after mount, so the first client
  // render matches the server's, which has no token store to read.
  const hasToken = useIsAuthenticated();
  const unread = useQuery({
    queryKey: ['notifications-unread'],
    queryFn: () => api.get<Notification[]>('/notifications/unread'),
    enabled: hasToken,
    refetchInterval: hasToken ? POLL_INTERVAL_MS : false,
    refetchOnWindowFocus: true,
  });
  return { hasToken, list: unread.data ?? [] };
}

/** What a notification says, in the reader's language. */
export function useNotificationText(): (notification: Notification) => string {
  const t = useTranslations('notifications');
  const tBody = useTranslations('notifications.weight_reminder');
  const fmt = useFormat();
  const liters = (ml: number) => fmt.unit(ml / 1000, 'liter', 2);
  return (n) => {
    if (n.type === 'water_reminder') {
      const { ml, target } = n.payload as WaterReminderPayload;
      return t('water_reminder', { drunk: liters(ml), target: liters(target) });
    }
    if (n.type === 'cooking_reminder') {
      const { date, dishes } = n.payload as CookingReminderPayload;
      // The dishes by what else they cover: the day after, or another meal of the day.
      const groups = new Map<string, CookedAhead[]>();
      for (const dish of dishes) {
        const cover = dish.alsoDate === date ? dish.alsoMealType : 'nextDay';
        groups.set(cover, [...(groups.get(cover) ?? []), dish]);
      }
      const said = [...groups].map(([cover, cooked]) =>
        t('cookingGroup', {
          dishes: fmt.list(cooked.map((dish) => dish.dish)),
          cover: t(`cookingCover.${cover}` as 'cookingCover.nextDay'),
        }),
      );
      return t('cooking_reminder', { groups: said.join('; ') });
    }
    if (n.type === 'weight_reminder') {
      const p = (n.payload ?? null) as WeightReminderPayload | null;
      const days = p?.daysSinceLastEntry ?? 0;
      return days > 0 ? tBody('withHistory', { days }) : tBody('noHistory');
    }
    if (n.type === 'preferences_review') return t('preferences_review');
    if (n.type.startsWith('product_')) {
      const { name, reason, replacedBy } = n.payload as ProductNoticePayload;
      switch (n.type) {
        case 'product_accepted':
          return t('product_accepted', { name });
        case 'product_rejected':
          return t('product_rejected', { name, reason: reason ?? '' });
        case 'product_withdrawn':
          return t('product_withdrawn', { name, reason: reason ?? '' });
        case 'product_replaced':
          return t(
            replacedBy === 'open_food_facts'
              ? 'product_replaced_open_food_facts'
              : 'product_replaced_instance',
            { name },
          );
      }
    }
    return n.type;
  };
}

/**
 * What a press on a reminder of water does: the amount goes to the day of the
 * reminded profile, the reminder says so for a moment, and is then read and goes.
 */
function useWaterFromReminder() {
  const t = useTranslations('notifications');
  const tWater = useTranslations('water');
  const fmt = useFormat();
  const errorText = useErrorText();
  const qc = useQueryClient();
  const hasToken = useIsAuthenticated();
  const profiles = useQuery({
    queryKey: ['profiles'],
    queryFn: () => api.get<Profile[]>('/profiles'),
    enabled: hasToken,
  });
  /** What a press added, by the reminder, said for a moment before it goes. */
  const [added, setAdded] = useState<Record<string, string>>({});
  /** Why a press added nothing, by the reminder. */
  const [failed, setFailed] = useState<Record<string, string>>({});
  const read = useMutation({
    mutationFn: (id: string) => api.post(`/notifications/${id}/read`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications-unread'] }),
  });
  const drink = useMutation({
    mutationFn: ({ n, ml }: { n: Notification; ml: number }) =>
      api.post<WaterDay>('/water', {
        profileId: n.profileId,
        day: (n.payload as WaterReminderPayload).day,
        ml,
      }),
    onMutate: ({ n }) =>
      setFailed((was) => {
        const left = { ...was };
        delete left[n.id];
        return left;
      }),
    onSuccess: (_day, { n, ml }) => {
      const name = profiles.data?.find((profile) => profile.id === n.profileId)?.name ?? '';
      setAdded((was) => ({
        ...was,
        [n.id]: t('waterAdded', { amount: held(fmt.unit(ml, 'milliliter')), name }),
      }));
      qc.invalidateQueries({ queryKey: ['water', n.profileId] });
      qc.invalidateQueries({ queryKey: ['week-summary', n.profileId] });
      window.setTimeout(() => read.mutate(n.id), ADDED_SHOWN_MS);
    },
    onError: (err, { n }) =>
      setFailed((was) => ({ ...was, [n.id]: errorText(err, tWater('errAdd')) })),
  });
  return {
    added,
    failed,
    pending: drink.isPending,
    add: (n: Notification, ml: number) => drink.mutate({ n, ml }),
  };
}

/** The amounts a reminder of water adds, side by side, until one of them was added. */
function WaterAmounts({
  reminder,
  water,
}: {
  reminder: Notification;
  water: ReturnType<typeof useWaterFromReminder>;
}) {
  const t = useTranslations('water');
  if (water.added[reminder.id]) return null;
  const failed = water.failed[reminder.id];
  return (
    <span className="block space-y-1">
      <span className="grid grid-cols-3 gap-1">
        {WATER_AMOUNTS_ML.map((ml) => (
          <Button
            key={ml}
            type="button"
            size="sm"
            variant="outline"
            className="px-1"
            disabled={water.pending}
            onClick={() => water.add(reminder, ml)}
          >
            {t('addMl', { ml })}
          </Button>
        ))}
      </span>
      {failed && (
        <span role="alert" className="block text-xs text-destructive">
          {failed}
        </span>
      )}
    </span>
  );
}

/**
 * Unread-notification bell with a small dropdown. Polls the API every
 * 60s when a session is active; the same row shape feeds the future Android
 * surface, so this component is the web-only render of a shared contract.
 */
export function NotificationsBell({ align = 'start' }: { align?: 'start' | 'end' }) {
  const t = useTranslations('notifications');
  const renderBody = useNotificationText();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const { hasToken, list } = useUnreadNotifications();

  const markRead = useMutation({
    mutationFn: (id: string) => api.post(`/notifications/${id}/read`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications-unread'] }),
  });
  const markAllRead = useMutation({
    mutationFn: () => api.post('/notifications/read-all'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications-unread'] }),
  });
  const water = useWaterFromReminder();

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const count = list.length;

  if (!hasToken) return null;

  return (
    <div ref={ref} className="relative z-50">
      <button
        type="button"
        aria-label={t('label')}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="relative inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Bell size={16} aria-hidden />
        {count > 0 && (
          <span className="absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-2xs font-medium text-primary-foreground">
            {count > 9 ? '9+' : count}
          </span>
        )}
      </button>

      {open && (
        <div
          className={cn(
            'pop-in absolute top-full z-50 mt-2 w-72 max-w-[calc(100vw-1rem)] rounded-md border border-border bg-card text-card-foreground shadow-lg',
            align === 'end' ? 'right-0' : 'left-0',
          )}
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
              <li className="px-3 py-6 text-center text-xs text-muted-foreground">{t('empty')}</li>
            ) : (
              list.map((n) => (
                <li
                  key={n.id}
                  className="flex items-start justify-between gap-2 border-b border-border/60 px-3 py-2 last:border-b-0"
                >
                  <span className="min-w-0 flex-1 space-y-2 break-words text-sm">
                    <span className="block">{water.added[n.id] ?? renderBody(n)}</span>
                    {n.type === 'water_reminder' && <WaterAmounts reminder={n} water={water} />}
                  </span>
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
        </div>
      )}
    </div>
  );
}
