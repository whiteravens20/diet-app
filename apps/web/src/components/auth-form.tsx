'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useState } from 'react';
import { type AuthResponse, PASSWORD_RULES } from '@diet-app/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { api, ApiClientError, tokenStore } from '@/lib/api';

/** Shared login / registration form. */
export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const router = useRouter();
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
      setError(
        err instanceof ApiClientError
          ? err.message
          : 'Something unexpected happened. Please try again.',
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-xl">
          {mode === 'login' ? 'Welcome back' : 'Create your account'}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          {mode === 'register' && (
            <Field label="Name">
              <Input name="displayName" required placeholder="Alex" autoComplete="name" />
            </Field>
          )}
          <Field label="Email">
            <Input name="email" type="email" required autoComplete="email" />
          </Field>
          <Field label="Password">
            <Input
              name="password"
              type="password"
              required
              minLength={mode === 'register' ? 12 : 1}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
          </Field>
          {mode === 'register' && (
            <ul className="-mt-2 space-y-0.5 text-xs text-muted-foreground">
              {PASSWORD_RULES.map((rule) => (
                <li key={rule}>• {rule}</li>
              ))}
            </ul>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </Button>
        </form>
        <p className="mt-4 text-center text-sm text-muted-foreground">
          {mode === 'login' ? (
            <>
              No account?{' '}
              <Link href="/register" className="text-primary hover:underline">
                Register
              </Link>
            </>
          ) : (
            <>
              Have an account?{' '}
              <Link href="/login" className="text-primary hover:underline">
                Sign in
              </Link>
            </>
          )}
        </p>
      </CardContent>
    </Card>
  );
}
