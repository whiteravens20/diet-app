// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { MailWarning } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { SessionUser } from '@diet-app/shared';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useConfig } from '@/lib/use-config';
import { useErrorText } from '@/lib/use-error-text';

/**
 * Said over the pages of an account whose address is not confirmed, on an
 * instance that sends mail: where the link went, and a button that sends a
 * new one, since a link lasts an hour. Gone once the address is confirmed.
 * Without mail there is nothing to confirm with, and every address counts as
 * confirmed when its account is made.
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
  const resend = useMutation({
    mutationFn: () => api.post<void>('/users/me/email/resend-verification'),
    onSuccess: () => {
      setSent(true);
      setError(null);
    },
    onError: (err) => setError(errorText(err, t('failed'))),
  });

  const me = session.data;
  if (!me || me.emailVerified || !config?.email.enabled) return null;
  return (
    <div
      role="status"
      className="mb-6 flex flex-wrap items-start gap-3 rounded-lg border border-warning/40 bg-warning/5 px-4 py-3 text-sm"
    >
      <MailWarning size={18} aria-hidden className="mt-0.5 shrink-0 text-warning" />
      <div className="min-w-0 flex-1 space-y-1">
        <p>{t('notice', { email: me.email })}</p>
        {sent && <p className="text-muted-foreground">{t('sent')}</p>}
        {error && <p className="text-destructive">{error}</p>}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={resend.isPending}
        onClick={() => resend.mutate()}
      >
        {resend.isPending ? t('sending') : t('resend')}
      </Button>
    </div>
  );
}
