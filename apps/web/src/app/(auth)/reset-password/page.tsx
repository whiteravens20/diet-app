'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { PASSWORD_RULES } from '@diet-app/shared';
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
      setError('The two passwords do not match.');
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
          ? err.message
          : 'Could not reset the password. The link may have expired.',
      );
    } finally {
      setLoading(false);
    }
  }

  if (!token) {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Missing token</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            This page expects a reset token in the URL. Request a new email from{' '}
            <Link href="/forgot-password" className="text-primary hover:underline">
              forgot password
            </Link>
            .
          </p>
        </CardContent>
      </Card>
    );
  }

  if (done) {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Password updated</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Sending you to sign in…
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-xl">Set a new password</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <Field label="New password">
            <Input
              name="password"
              type="password"
              required
              minLength={12}
              autoComplete="new-password"
            />
          </Field>
          <Field label="Confirm new password">
            <Input
              name="confirm"
              type="password"
              required
              minLength={12}
              autoComplete="new-password"
            />
          </Field>
          <ul className="-mt-2 space-y-0.5 text-xs text-muted-foreground">
            {PASSWORD_RULES.map((rule) => (
              <li key={rule}>• {rule}</li>
            ))}
          </ul>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? 'Please wait…' : 'Update password'}
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
