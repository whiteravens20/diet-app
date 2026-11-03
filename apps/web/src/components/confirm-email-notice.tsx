// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { Mail } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { SessionUser } from '@diet-app/shared';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useConfig } from '@/lib/use-config';
import { useErrorText } from '@/lib/use-error-text';

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

/**
 * Said over the pages of an account whose address is not confirmed, on an
 * instance that sends mail: that confirming is not needed, what it gives on
 * this instance, and a button that sends a new link, since a link lasts an
 * hour. "Not now" puts it aside on this browser for a month. Gone once the
 * address is confirmed. Without mail there is nothing to confirm with, and
 * every address counts as confirmed when its account is made.
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
  const me = session.data;
  const resend = useMutation({
    mutationFn: () => api.post<void>('/users/me/email/resend-verification'),
    onSuccess: () => {
      setSent(true);
      setError(null);
    },
    onError: (err) => setError(errorText(err, t('failed'))),
  });

  // Nothing is drawn before the session is read, so the server and the browser draw the same at first.
  if (!me || me.emailVerified || !config?.email.enabled || aside === me.id) return null;
  const later = (): void => {
    setAside(me.id);
    try {
      localStorage.setItem(LATER, JSON.stringify({ account: me.id, until: Date.now() + LATER_MS }));
    } catch {
      // A browser that keeps nothing shows the notice again on the next page.
    }
  };
  return (
    <div
      role="status"
      className="mb-6 flex flex-wrap items-start gap-3 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm"
    >
      <Mail size={18} aria-hidden className="mt-0.5 shrink-0 text-muted-foreground" />
      {/* The words keep a width to be read at: on a narrow screen the buttons go under them. */}
      <div className="min-w-0 flex-1 basis-64 space-y-1">
        <p>
          {t(config.email.confirmationUnlocksAi ? 'noticeAi' : 'noticePlain', {
            email: me.email,
          })}
        </p>
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
  );
}
