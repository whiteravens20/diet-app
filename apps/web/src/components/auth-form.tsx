// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { AuthResponse, LoginResponse } from '@diet-app/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { TurnstileWidget } from '@/components/turnstile-widget';
import { api, COOKIE_SESSION } from '@/lib/api';
import { ApiClientError } from '@/lib/http';
import { useErrorText } from '@/lib/use-error-text';
import { session } from '@/lib/session';
import { useConfig } from '@/lib/use-config';

/** Shared login / registration form. */
export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const t = useTranslations('auth');
  const worded = useErrorText();
  const tRules = useTranslations('auth.passwordRules');
  const tSecond = useTranslations('secondFactor');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const config = useConfig();
  const turnstile = config.data?.turnstile;
  const [token, setToken] = useState<string | null>(null);
  // Bumped to force a fresh Turnstile challenge after a failed submit.
  const [widgetKey, setWidgetKey] = useState(0);
  const needsToken = Boolean(turnstile?.enabled && turnstile.siteKey);
  // What an account with two-step sign-in got for its password: the form then asks for the code.
  const [challenge, setChallenge] = useState<string | null>(null);

  /** A Turnstile token is good for one request: the next one needs a new challenge. */
  function renewToken() {
    if (!needsToken) return;
    setToken(null);
    setWidgetKey((k) => k + 1);
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setLoading(true);
    const form = new FormData(event.currentTarget);
    const body = {
      email: String(form.get('email')),
      password: String(form.get('password')),
      ...(mode === 'register' ? { displayName: String(form.get('displayName')) } : {}),
      ...(needsToken ? { turnstileToken: token ?? undefined } : {}),
    };
    try {
      const answer = await api.post<LoginResponse>(`/auth/${mode}`, body, COOKIE_SESSION);
      if ('secondFactor' in answer) {
        setChallenge(answer.secondFactor.challenge);
        return;
      }
      session.begin(answer);
      session.load('/dashboard');
    } catch (err) {
      setError(worded(err));
      renewToken();
    } finally {
      setLoading(false);
    }
  }

  async function onCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setLoading(true);
    const code = String(new FormData(event.currentTarget).get('code'));
    try {
      session.begin(await api.post<AuthResponse>('/auth/login/second-factor', { challenge, code }, COOKIE_SESSION));
      session.load('/dashboard');
    } catch (err) {
      setError(worded(err));
      // A sign-in that took too long begins again, with the password.
      if (err instanceof ApiClientError && err.code === 'INVALID_SIGN_IN_CHALLENGE') backToPassword(false);
    } finally {
      setLoading(false);
    }
  }

  function backToPassword(clear = true) {
    setChallenge(null);
    if (clear) setError(null);
    renewToken();
  }

  if (challenge) {
    return (
      // A form of its own: without the key its field would be the email field of the form before, with the address still in it.
      <Card key="second-step" className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">{tSecond('title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onCode} className="space-y-4">
            <p className="text-sm text-muted-foreground">{tSecond('signInBody')}</p>
            <Field label={tSecond('codeOrRecovery')}>
              <Input name="code" required autoFocus autoComplete="one-time-code" maxLength={40} />
            </Field>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? t('submitting') : t('signInButton')}
            </Button>
          </form>
          <p className="mt-4 text-center text-sm">
            <button type="button" className="text-muted-foreground hover:underline" onClick={() => backToPassword()}>
              {tSecond('signInBack')}
            </button>
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card key="first-step" className="w-full max-w-sm">
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
          {/* The reset link arrives by email, so it is offered only where email is configured. */}
          {mode === 'login' && config.data?.email.enabled && (
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
          {needsToken && turnstile?.siteKey && (
            <TurnstileWidget key={widgetKey} siteKey={turnstile.siteKey} onToken={setToken} />
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={loading || (needsToken && !token)}>
            {loading
              ? t('submitting')
              : mode === 'login'
                ? t('signInButton')
                : t('createAccountButton')}
          </Button>
          {mode === 'register' && (
            <p className="text-center text-xs text-muted-foreground">
              {t.rich('termsConsent', {
                link: (chunks) => (
                  <Link
                    href="/terms"
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary underline underline-offset-2"
                  >
                    {chunks}
                  </Link>
                ),
              })}
            </p>
          )}
        </form>
        <p className="mt-4 text-center text-sm text-muted-foreground">
          {mode === 'login' ? (
            <>
              {t('noAccount')}{' '}
              <Link href="/register" className="text-primary underline underline-offset-2">
                {t('createAccountButton')}
              </Link>
            </>
          ) : (
            <>
              {t('hasAccount')}{' '}
              <Link href="/login" className="text-primary underline underline-offset-2">
                {t('signInButton')}
              </Link>
            </>
          )}
        </p>
      </CardContent>
    </Card>
  );
}
