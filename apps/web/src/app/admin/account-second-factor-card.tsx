// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { adminApi } from '@/lib/admin-api';
import { useErrorText } from '@/lib/use-error-text';

/**
 * For the holder of an account who lost the authenticator app and the
 * recovery codes: the operator switches two-step sign-in off for the account
 * of an address. Asked twice, because afterwards the password alone opens
 * the account.
 */
export function AccountSecondFactorCard() {
  const t = useTranslations('admin');
  const errorText = useErrorText();
  const tCommon = useTranslations('common');
  const [email, setEmail] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  function ask(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setError(null);
    setDone(null);
    setConfirming(true);
  }

  async function remove(): Promise<void> {
    setBusy(true);
    try {
      await adminApi.removeAccountSecondFactor(email.trim());
      setDone(t('accountFactorRemoved', { email: email.trim() }));
      setEmail('');
    } catch (err) {
      setError(errorText(err, t('secondFactorFailed')));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('accountFactorTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{t('accountFactorBody')}</p>
        {confirming ? (
          <div className="space-y-3">
            <p className="text-sm font-medium">{t('accountFactorConfirm', { email: email.trim() })}</p>
            <div className="flex gap-2">
              <Button type="button" variant="destructive" disabled={busy} onClick={() => void remove()}>
                {t('accountFactorConfirmButton')}
              </Button>
              <Button type="button" variant="outline" disabled={busy} onClick={() => setConfirming(false)}>
                {tCommon('cancel')}
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={ask} className="max-w-sm space-y-3">
            <Field label={t('accountFactorEmail')}>
              <Input name="email" type="email" required autoComplete="off" value={email} onChange={(event) => setEmail(event.target.value)} />
            </Field>
            <Button type="submit" variant="outline">
              {t('accountFactorRemove')}
            </Button>
          </form>
        )}
        {done && (
          <p role="status" className="text-sm text-success">
            {done}
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
