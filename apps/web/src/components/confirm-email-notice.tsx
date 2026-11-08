// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Mail } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { type RefObject, useEffect, useRef, useState } from 'react';
import type { SessionUser } from '@diet-app/shared';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useConfig } from '@/lib/use-config';
import { useErrorText } from '@/lib/use-error-text';
import { cn } from '@/lib/utils';

/** Where a browser keeps until when the notice is put aside, and for which account. */
const LATER = 'diet-app.confirm-email.later';
/** How long "Not now" puts the notice aside on a browser. */
const LATER_MS = 30 * 86_400_000;

/**
 * The account this browser put the notice aside for, while that lasts: read once, when the notice is
 * first drawn on the browser, which the server never draws it on.
 */
function putAside(): string | null {
  try {
    const kept = JSON.parse(localStorage.getItem(LATER) ?? 'null') as {
      account?: unknown;
      until?: unknown;
    } | null;
    return typeof kept?.account === 'string' &&
      typeof kept.until === 'number' &&
      kept.until > Date.now()
      ? kept.account
      : null;
  } catch {
    return null;
  }
}

/** The property of the page that holds the bar's height, for what else stands at the bottom of the screen. */
const BAR_HEIGHT = '--bottom-bar';

/**
 * How tall the bar is, kept as it changes (a narrow screen wraps its words), in the page's property for
 * what stands above it, and given back for the room the page keeps at its end. Nothing where the browser
 * cannot say.
 */
function useHeight(bar: RefObject<HTMLDivElement | null>, shown: boolean): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const element = bar.current;
    if (!shown || !element || typeof ResizeObserver === 'undefined') return;
    const kept = new ResizeObserver(() => {
      const now = Math.ceil(element.getBoundingClientRect().height);
      setHeight(now);
      document.documentElement.style.setProperty(BAR_HEIGHT, `${now}px`);
    });
    kept.observe(element);
    return () => {
      kept.disconnect();
      document.documentElement.style.removeProperty(BAR_HEIGHT);
    };
  }, [bar, shown]);
  return shown ? height : 0;
}

/**
 * Said at the bottom of the screen, over the pages of an account whose address
 * is not confirmed, on an instance that sends mail: that confirming is not
 * needed, what it gives on this instance, and a button that sends a new link,
 * since a link lasts an hour. "Not now" puts it aside on this browser for a
 * month. Gone once the address is confirmed. Without mail there is nothing to
 * confirm with, and every address counts as confirmed when its account is
 * made. It comes once the session is read, after the page is drawn: standing
 * over the bottom of the screen, it moves nothing a person is reading or about
 * to press, and the page keeps as much room at its end, so that it covers
 * nothing of the page either.
 */
export function ConfirmEmailNotice() {
  const t = useTranslations('confirmEmail');
  const errorText = useErrorText();
  const session = useQuery({
    queryKey: ['session'],
    queryFn: () => api.get<SessionUser>('/users/me'),
  });
  const { data: config } = useConfig();
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aside, setAside] = useState(putAside);
  const [more, setMore] = useState(false);
  const me = session.data;
  const bar = useRef<HTMLDivElement | null>(null);
  const shown = !!me && !me.emailVerified && !!config?.email.enabled && aside !== me.id;
  const height = useHeight(bar, shown);
  const resend = useMutation({
    mutationFn: () => api.post<void>('/users/me/email/resend-verification'),
    onSuccess: () => {
      setSent(true);
      setError(null);
    },
    onError: (err) => setError(errorText(err, t('failed'))),
  });

  // Nothing is drawn before the session is read, so the server and the browser draw the same at first.
  if (!shown || !me || !config) return null;
  const later = (): void => {
    setAside(me.id);
    try {
      localStorage.setItem(LATER, JSON.stringify({ account: me.id, until: Date.now() + LATER_MS }));
    } catch {
      // A browser that keeps nothing shows the notice again on the next page.
    }
  };
  return (
    <>
      {/* The room the page keeps at its end, as tall as the bar: it grows the page below all else. */}
      <div aria-hidden style={{ height }} />
      <div
        ref={bar}
        role="status"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))] pt-3 text-sm text-card-foreground shadow-[0_-4px_12px_rgb(0_0_0/0.08)] md:left-60 md:px-8 print:hidden"
      >
        <div className="mx-auto flex max-w-5xl flex-wrap items-start gap-3">
          <Mail size={18} aria-hidden className="mt-0.5 shrink-0 text-muted-foreground" />
          {/* The words keep a width to be read at: on a narrow screen the buttons go under them. A phone
              says one sentence, and the whole at "Details": the bar stands over a quarter of its screen otherwise. */}
          <div className="min-w-0 flex-1 basis-64 space-y-1">
            <p className={cn(!more && 'hidden sm:block')}>
              {t(config.email.confirmationUnlocksAi ? 'noticeAi' : 'noticePlain', {
                email: me.email,
              })}
            </p>
            {!more && (
              <p className="sm:hidden">
                {t(config.email.confirmationUnlocksAi ? 'shortAi' : 'shortPlain')}{' '}
                <button
                  type="button"
                  className="font-medium underline underline-offset-2"
                  onClick={() => setMore(true)}
                >
                  {t('more')}
                </button>
              </p>
            )}
            {sent && <p className="text-muted-foreground">{t('sent')}</p>}
            {error && <p className="text-destructive">{error}</p>}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={resend.isPending}
              onClick={() => resend.mutate()}
            >
              {resend.isPending ? t('sending') : t('resend')}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={later}>
              {t('later')}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}
