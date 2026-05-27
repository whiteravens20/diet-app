'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { AuthResponse } from '@diet-app/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { api, ApiClientError, tokenStore } from '@/lib/api';

/** Shared login / registration form. */
export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const router = useRouter();
  const t = useTranslations('auth');
  const tErrors = useTranslations('errors');
  const tRules = useTranslations('auth.passwordRules');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setLoading(true);
    const form = new FormData(event.currentTarget);
    const body = {
      email: String(form.get('email')),
      password: String(form.get('password')),
      ...(mode === 'register' ? { displayName: String(form.get('displayName')) } : {}),
    };
    try {
      const res = await api.post<AuthResponse>(`/auth/${mode}`, body);
      tokenStore.set(res.tokens);
      router.push('/dashboard');
    } catch (err) {
      // Prefer a translated error-code message; fall back to the server's
      // English text, then the generic catch-all.
      if (err instanceof ApiClientError) {
        setError(tErrors.has(err.code) ? tErrors(err.code) : err.message);
      } else {
        setError(tErrors('GENERIC'));
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-xl">
          {mode === 'login' ? t('welcomeBack') : t('createAccount')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          {mode === 'register' && (
            <Field label={t('name')}>
              <Input name="displayName" required placeholder="Alex" autoComplete="name" />
            </Field>
          )}
          <Field label={t('email')}>
            <Input name="email" type="email" required autoComplete="email" />
          </Field>
          <Field label={t('password')}>
            <Input
              name="password"
              type="password"
              required
              minLength={mode === 'register' ? 12 : 1}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
          </Field>
          {mode === 'login' && (
            <p className="-mt-2 text-right text-xs">
              <Link href="/forgot-password" className="text-muted-foreground hover:underline">
                {t('forgotPassword')}
              </Link>
            </p>
          )}
          {mode === 'register' && (
            <ul className="-mt-2 space-y-0.5 text-xs text-muted-foreground">
              <li>• {tRules('minLength')}</li>
              <li>• {tRules('case')}</li>
              <li>• {tRules('digit')}</li>
            </ul>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading
              ? t('submitting')
              : mode === 'login'
                ? t('signInButton')
                : t('createAccountButton')}
          </Button>
        </form>
        <p className="mt-4 text-center text-sm text-muted-foreground">
          {mode === 'login' ? (
            <>
              {t('noAccount')}{' '}
              <Link href="/register" className="text-primary hover:underline">
                {t('createAccountButton')}
              </Link>
            </>
          ) : (
            <>
              {t('hasAccount')}{' '}
              <Link href="/login" className="text-primary hover:underline">
                {t('signInButton')}
              </Link>
            </>
          )}
        </p>
      </CardContent>
    </Card>
  );
}
