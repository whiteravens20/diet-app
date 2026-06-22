'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type Status = 'pending' | 'success' | 'failed' | 'missing';

/**
 * Lands here from the verification email link. POSTs the token once, then shows
 * the outcome. Reachable while signed out, so it lives under the (auth) shell.
 */
function VerifyEmailInner() {
  const t = useTranslations('auth');
  const params = useSearchParams();
  const token = params.get('token') ?? '';
  const [status, setStatus] = useState<Status>(token ? 'pending' : 'missing');
  // Guard against the effect firing twice (React Strict Mode) — the token is
  // single-use, so a double POST would make the second call look "failed".
  const fired = useRef(false);

  useEffect(() => {
    if (!token || fired.current) return;
    fired.current = true;
    api
      .post('/auth/verify-email', { token })
      .then(() => setStatus('success'))
      .catch(() => setStatus('failed'));
  }, [token]);

  const copy: Record<Status, { title: string; body: string }> = {
    pending: { title: t('verifyTitle'), body: '' },
    success: { title: t('verifySuccess'), body: t('verifySuccessBody') },
    failed: { title: t('verifyFailed'), body: t('verifyFailedBody') },
    missing: { title: t('missingTokenTitle'), body: t('verifyMissingToken') },
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

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={null}>
      <VerifyEmailInner />
    </Suspense>
  );
}
