// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

/** An account's password and address, and its end. */
import { useMutation } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { type SessionUser } from '@diet-app/shared';
import { api } from '@/lib/api';
import { useErrorText } from '@/lib/use-error-text';
import { session as browserSession } from '@/lib/session';
import { useConfig } from '@/lib/use-config';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export function PasswordCard() {
  const t = useTranslations('settings');
  const errorText = useErrorText();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const change = useMutation({
    mutationFn: (body: { currentPassword: string; newPassword: string }) =>
      api.post<void>('/users/me/password', body),
    onSuccess: () => {
      setDone(true);
      // Every session of the account ended with the password, this one too: the reader reads that it worked, and signs in again.
      window.setTimeout(() => browserSession.end('/login'), 1200);
    },
    onError: (err) => setError(errorText(err, t('passwordFailed'))),
  });
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setDone(false);
    const f = new FormData(event.currentTarget);
    change.mutate({
      currentPassword: String(f.get('currentPassword') ?? ''),
      newPassword: String(f.get('newPassword') ?? ''),
    });
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('password')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="grid max-w-md gap-3 sm:grid-cols-2">
          <Field label={t('currentPassword')}>
            <Input
              name="currentPassword"
              type="password"
              required
              autoComplete="current-password"
            />
          </Field>
          <Field label={t('newPasswordLabel')}>
            <Input
              name="newPassword"
              type="password"
              required
              minLength={12}
              autoComplete="new-password"
            />
          </Field>
          <div className="sm:col-span-2">
            <Button type="submit" disabled={change.isPending}>
              {change.isPending ? t('changingPassword') : t('changePassword')}
            </Button>
            {done && <p className="mt-2 text-xs text-success">{t('passwordChanged')}</p>}
            {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export function EmailCard({ me }: { me: SessionUser }) {
  const t = useTranslations('settings');
  const errorText = useErrorText();
  const tCommon = useTranslations('common');
  const config = useConfig();
  const emailEnabled = config.data?.email.enabled ?? false;
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [resendDone, setResendDone] = useState(false);

  const change = useMutation({
    mutationFn: (body: { newEmail: string; currentPassword: string }) =>
      api.post<void>('/users/me/email', body),
    onSuccess: () => {
      setSent(true);
      setEditing(false);
    },
    onError: (err) => setError(errorText(err, t('changeEmailFailed'))),
  });

  const resend = useMutation({
    mutationFn: () => api.post<void>('/users/me/email/resend-verification'),
    onSuccess: () => setResendDone(true),
    onError: (err) => setError(errorText(err, t('resendVerificationFailed'))),
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const f = new FormData(event.currentTarget);
    change.mutate({
      newEmail: String(f.get('newEmail') ?? '').trim(),
      currentPassword: String(f.get('currentPassword') ?? ''),
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('email')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <p className="font-mono text-sm">{me.email}</p>
          <p className="text-xs text-muted-foreground">
            {me.emailVerified ? t('emailVerified') : t('emailUnverified')} · {t('emailHint')}
          </p>
        </div>

        {/* Resend verification — only meaningful when unverified AND mail works. */}
        {!me.emailVerified && emailEnabled && (
          <div>
            {resendDone ? (
              <p className="text-xs text-success">{t('resendVerificationSent')}</p>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={resend.isPending}
                onClick={() => {
                  setError(null);
                  resend.mutate();
                }}
              >
                {resend.isPending ? t('resendVerificationSending') : t('resendVerification')}
              </Button>
            )}
          </div>
        )}

        {/* Change email — gated entirely on SMTP being configured. */}
        {sent ? (
          <p className="text-xs text-success">{t('changeEmailSent')}</p>
        ) : emailEnabled ? (
          editing ? (
            <form onSubmit={onSubmit} className="grid max-w-md gap-3 sm:grid-cols-2">
              <Field label={t('changeEmailNew')}>
                <Input name="newEmail" type="email" required autoComplete="email" />
              </Field>
              <Field label={t('currentPassword')}>
                <Input
                  name="currentPassword"
                  type="password"
                  required
                  autoComplete="current-password"
                />
              </Field>
              <div className="flex items-center gap-2 sm:col-span-2">
                <Button type="submit" disabled={change.isPending}>
                  {change.isPending ? t('changeEmailSending') : t('changeEmailSubmit')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setEditing(false);
                    setError(null);
                  }}
                >
                  {tCommon('cancel')}
                </Button>
              </div>
            </form>
          ) : (
            <div>
              <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
                {t('changeEmail')}
              </Button>
            </div>
          )
        ) : (
          <p className="text-xs italic text-muted-foreground">{t('changeEmailDisabled')}</p>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}

export function DangerZoneCard({ me }: { me: SessionUser }) {
  const t = useTranslations('settings');
  const errorText = useErrorText();
  const tCommon = useTranslations('common');
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const remove = useMutation({
    mutationFn: () => api.delete<void>('/users/me', { currentPassword: password }),
    onMutate: () => setError(null),
    // The account is gone, and its session with it.
    onSuccess: () => browserSession.end('/'),
    onError: (err) => setError(errorText(err, t('deleteFailed'))),
  });

  function confirm() {
    if (email.trim().toLowerCase() !== me.email.toLowerCase() || !password) return;
    remove.mutate();
  }

  return (
    <Card className="border-destructive/40 bg-destructive/5">
      <CardHeader>
        <CardTitle>{t('danger')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{t('dangerSubhead')}</p>
        {!open ? (
          <Button type="button" variant="destructive" onClick={() => setOpen(true)}>
            {t('deleteAccount')}
          </Button>
        ) : (
          <div className="space-y-3">
            <p className="text-sm font-semibold">{t('deleteAccountConfirmTitle')}</p>
            <p className="text-xs text-muted-foreground">{t('deleteAccountConfirmBody')}</p>
            <div className="grid max-w-md gap-3 sm:grid-cols-2">
              <Field label={t('deleteAccountTypeEmail')}>
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={t('deleteAccountTypeEmailPlaceholder', { email: me.email })}
                />
              </Field>
              <Field label={t('deleteAccountTypePassword')}>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                />
              </Field>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="destructive"
                disabled={
                  remove.isPending ||
                  email.trim().toLowerCase() !== me.email.toLowerCase() ||
                  !password
                }
                onClick={confirm}
              >
                {remove.isPending ? t('deleting') : t('deleteAccountConfirm')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setOpen(false);
                  setEmail('');
                  setPassword('');
                  setError(null);
                }}
              >
                {tCommon('cancel')}
              </Button>
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Keep ts-unused-imports / eslint happy about the cn import used in inline
// className templates above (no-op).
void cn;
