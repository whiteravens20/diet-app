'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { api, ApiClientError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { TurnstileWidget } from '@/components/turnstile-widget';
import { useConfig } from '@/lib/use-config';

/**
 * Step 1 of password reset — submit an email so the server emails a token.
 * The endpoint deliberately returns 202 whether or not the email exists, so we
 * always show the same confirmation screen (no account-enumeration leak).
 */
export default function ForgotPasswordPage() {
  const t = useTranslations('auth');
  const tErrors = useTranslations('errors');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const config = useConfig();
  const turnstile = config.data?.turnstile;
  const [token, setToken] = useState<string | null>(null);
  const [widgetKey, setWidgetKey] = useState(0);
  const needsToken = Boolean(turnstile?.enabled && turnstile.siteKey);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setLoading(true);
    const f = new FormData(event.currentTarget);
    try {
      await api.post('/auth/password-reset/request', {
        email: String(f.get('email')),
        ...(needsToken ? { turnstileToken: token ?? undefined } : {}),
      });
      setSent(true);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(tErrors.has(err.code) ? tErrors(err.code) : err.message);
      } else {
        setError(tErrors('GENERIC'));
      }
      if (needsToken) {
        setToken(null);
        setWidgetKey((k) => k + 1);
      }
    } finally {
      setLoading(false);
    }
  }

  if (sent) {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">{t('resetSent')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <p className="text-muted-foreground">{t('resetSentBody')}</p>
          <p className="text-center">
            <Link href="/login" className="text-primary hover:underline">
              {t('backToSignIn')}
            </Link>
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-xl">{t('resetTitle')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <p className="text-sm text-muted-foreground">{t('forgotIntro')}</p>
          <Field label={t('email')}>
            <Input name="email" type="email" required autoComplete="email" />
          </Field>
          {needsToken && turnstile?.siteKey && (
            <TurnstileWidget key={widgetKey} siteKey={turnstile.siteKey} onToken={setToken} />
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={loading || (needsToken && !token)}>
            {loading ? t('submitting') : t('resetSubmit')}
          </Button>
        </form>
        <p className="mt-4 text-center text-sm text-muted-foreground">
          {t('remembered')}{' '}
          <Link href="/login" className="text-primary hover:underline">
            {t('signInButton')}
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
