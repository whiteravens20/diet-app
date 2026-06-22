'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { api, tokenStore } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type Status = 'pending' | 'success' | 'failed' | 'missing';

/**
 * Lands here from the confirmation link sent to the *new* address. Confirming
 * revokes existing sessions server-side, so we also clear local tokens and send
 * the user back to sign in with the new address.
 */
function ConfirmEmailChangeInner() {
  const t = useTranslations('auth');
  const params = useSearchParams();
  const token = params.get('token') ?? '';
  const [status, setStatus] = useState<Status>(token ? 'pending' : 'missing');
  const fired = useRef(false);

  useEffect(() => {
    if (!token || fired.current) return;
    fired.current = true;
    api
      .post('/auth/confirm-email-change', { token })
      .then(() => {
        tokenStore.clear();
        setStatus('success');
      })
      .catch(() => setStatus('failed'));
  }, [token]);

  const copy: Record<Status, { title: string; body: string }> = {
    pending: { title: t('changeEmailTitle'), body: '' },
    success: { title: t('changeEmailSuccess'), body: t('changeEmailSuccessBody') },
    failed: { title: t('changeEmailFailed'), body: t('changeEmailFailedBody') },
    missing: { title: t('missingTokenTitle'), body: t('changeEmailMissingToken') },
  };

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-xl">{copy[status].title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {copy[status].body && <p className="text-muted-foreground">{copy[status].body}</p>}
        {status !== 'pending' && (
          <p className="text-center">
            <Link href="/login" className="text-primary hover:underline">
              {t('backToSignIn')}
            </Link>
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export default function ConfirmEmailChangePage() {
  return (
    <Suspense fallback={null}>
      <ConfirmEmailChangeInner />
    </Suspense>
  );
}
