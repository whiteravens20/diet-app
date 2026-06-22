'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { api, ApiClientError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';

/**
 * Step 2 of password reset — read the `token` query param from the email link,
 * collect a new password, submit. On success we send the user to /login.
 */
function ResetPasswordInner() {
  const router = useRouter();
  const params = useSearchParams();
  const t = useTranslations('auth');
  const tRules = useTranslations('auth.passwordRules');
  const tErrors = useTranslations('errors');
  const token = params.get('token') ?? '';
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setLoading(true);
    const f = new FormData(event.currentTarget);
    const password = String(f.get('password'));
    const confirm = String(f.get('confirm'));
    if (password !== confirm) {
      setError(t('passwordsDontMatch'));
      setLoading(false);
      return;
    }
    try {
      await api.post('/auth/password-reset/confirm', { token, password });
      setDone(true);
      // Brief pause so the user sees the confirmation, then off to login.
      setTimeout(() => router.push('/login'), 1500);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? tErrors.has(err.code)
            ? tErrors(err.code)
            : err.message
          : t('resetFailed'),
      );
    } finally {
      setLoading(false);
    }
  }

  if (!token) {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">{t('missingTokenTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            {t.rich('missingTokenBody', {
              link: (chunks) => (
                <Link href="/forgot-password" className="text-primary hover:underline">
                  {chunks}
                </Link>
              ),
            })}
          </p>
        </CardContent>
      </Card>
    );
  }

  if (done) {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">{t('newPasswordDone')}</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">{t('redirecting')}</CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-xl">{t('newPasswordTitle')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <Field label={t('newPasswordField')}>
            <Input
              name="password"
              type="password"
              required
              minLength={12}
              autoComplete="new-password"
            />
          </Field>
          <Field label={t('confirmPasswordField')}>
            <Input
              name="confirm"
              type="password"
              required
              minLength={12}
              autoComplete="new-password"
            />
          </Field>
          <ul className="-mt-2 space-y-0.5 text-xs text-muted-foreground">
            <li>• {tRules('minLength')}</li>
            <li>• {tRules('case')}</li>
            <li>• {tRules('digit')}</li>
          </ul>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? t('submitting') : t('newPasswordSubmit')}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordInner />
    </Suspense>
  );
}
