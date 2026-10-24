// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { type FormEvent, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { adminApi, type AdminOperatorAi } from '@/lib/admin-api';
import { useErrorText } from '@/lib/use-error-text';

/**
 * Who may use the operator's AI provider: what the instance is set up with
 * (`AI_ADMIN_ACCESS`), and, for an instance that lets the approved accounts
 * use it, approving the account of an address or taking that back. The panel
 * holds no list of accounts: the operator names one by its address.
 */
export function OperatorAiCard() {
  const t = useTranslations('admin.operatorAi');
  const errorText = useErrorText();
  const [state, setState] = useState<AdminOperatorAi | null>(null);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setState(await adminApi.operatorAi());
      } catch (err) {
        setError(errorText(err, t('loadFailed')));
      }
    })();
  }, [t, errorText]);

  async function decide(approve: boolean): Promise<void> {
    const address = email.trim();
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await (approve ? adminApi.approveOperatorAi(address) : adminApi.revokeOperatorAi(address));
      setDone(t(approve ? 'approved' : 'revoked', { email: address }));
      setEmail('');
    } catch (err) {
      setError(errorText(err, t('failed')));
      return;
    } finally {
      setBusy(false);
    }
    // The count the card shows, as it is now.
    try {
      setState(await adminApi.operatorAi());
    } catch (err) {
      setError(errorText(err, t('loadFailed')));
    }
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void decide(true);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles size={18} aria-hidden />
          {t('title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {state && (
          <>
            <p>{t(`access.${state.access}`)}</p>
            {state.access === 'confirmed' && !state.mailConfigured && (
              <p role="status" className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-warning">
                {t('confirmedWithoutMail')}
              </p>
            )}
            <p className="text-muted-foreground">
              {state.access === 'approved' ? t('approvedCount', { count: state.approved }) : t('approvalsWait', { count: state.approved })}
            </p>
          </>
        )}
        <form onSubmit={submit} className="max-w-sm space-y-3">
          <Field label={t('email')}>
            <Input name="email" type="email" required autoComplete="off" value={email} onChange={(event) => setEmail(event.target.value)} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy}>
              {t('approve')}
            </Button>
            <Button type="button" variant="outline" disabled={busy || email.trim() === ''} onClick={() => void decide(false)}>
              {t('revoke')}
            </Button>
          </div>
        </form>
        {done && (
          <p role="status" className="text-success">
            {done}
          </p>
        )}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
