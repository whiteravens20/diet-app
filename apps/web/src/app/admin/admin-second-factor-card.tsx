// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import { ShieldCheck, ShieldOff } from 'lucide-react';
import type { SecondFactorSetup } from '@diet-app/shared';
import { AuthenticatorSetup } from '@/components/authenticator-setup';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { adminApi } from '@/lib/admin-api';
import { useErrorText } from '@/lib/use-error-text';

type Step =
  | { at: 'rest' }
  /** Asked for the password before a secret is handed out. */
  | { at: 'password' }
  | { at: 'scan'; setup: SecondFactorSetup }
  /** Asked for the password and a code, to switch off. */
  | { at: 'off' };

/**
 * Two-step sign-in to the admin panel: whether signing in takes a code from
 * an authenticator app, setting that up, and switching it off again. `on` is
 * what the panel knows; `onChanged` tells it when that is no longer so.
 */
export function AdminSecondFactorCard({ on, onChanged }: { on: boolean; onChanged: (on: boolean) => void }) {
  const t = useTranslations('admin');
  const tSecond = useTranslations('secondFactor');
  const errorText = useErrorText();
  const tCommon = useTranslations('common');
  const [step, setStep] = useState<Step>({ at: 'rest' });
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const worded = (err: unknown): string => errorText(err, t('secondFactorFailed'));

  /** One request of the card at a time; what went wrong is shown. */
  async function run(work: () => Promise<void>): Promise<void> {
    setError(null);
    setDone(null);
    setBusy(true);
    try {
      await work();
    } catch (err) {
      setError(worded(err));
    } finally {
      setBusy(false);
    }
  }

  const field = (event: FormEvent<HTMLFormElement>, name: string): string => String(new FormData(event.currentTarget).get(name) ?? '');

  function onPassword(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const password = field(event, 'password');
    void run(async () => setStep({ at: 'scan', setup: await adminApi.proposeSecondFactor(password) }));
  }

  function onFirstCode(event: FormEvent<HTMLFormElement>, setup: SecondFactorSetup): void {
    event.preventDefault();
    const code = field(event, 'code');
    void run(async () => {
      await adminApi.beginSecondFactor(setup.enrolment, code);
      setStep({ at: 'rest' });
      setDone(t('secondFactorOnNow'));
      onChanged(true);
    });
  }

  function onOff(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const password = field(event, 'password');
    const code = field(event, 'code');
    void run(async () => {
      await adminApi.endSecondFactor(password, code);
      setStep({ at: 'rest' });
      setDone(t('secondFactorOffNow'));
      onChanged(false);
    });
  }

  function to(next: Step): void {
    setError(null);
    setDone(null);
    setStep(next);
  }

  const cancel = (
    <Button type="button" variant="outline" disabled={busy} onClick={() => to({ at: 'rest' })}>
      {tCommon('cancel')}
    </Button>
  );
  const problem = error && (
    <p role="alert" className="text-sm text-destructive">
      {error}
    </p>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {on ? <ShieldCheck className="h-5 w-5 text-emerald-500" /> : <ShieldOff className="h-5 w-5 text-muted-foreground" />}
          {t('secondFactorTitle')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{t('secondFactorBody')}</p>

        {step.at === 'rest' && (
          <>
            <p className="text-sm font-medium">{t(on ? 'secondFactorOn' : 'secondFactorOff')}</p>
            {done && (
              <p role="status" className="text-sm text-emerald-600 dark:text-emerald-400">
                {done}
              </p>
            )}
            {problem}
            {on ? (
              <>
                <Button type="button" variant="outline" onClick={() => to({ at: 'off' })}>
                  {tSecond('switchOff')}
                </Button>
                <p className="text-xs text-muted-foreground">{t('secondFactorLost')}</p>
              </>
            ) : (
              <>
                <Button type="button" onClick={() => to({ at: 'password' })}>
                  {tSecond('setUp')}
                </Button>
                <p className="text-xs text-muted-foreground">{t('secondFactorSetUpNote')}</p>
              </>
            )}
          </>
        )}

        {step.at === 'password' && (
          <form onSubmit={onPassword} className="max-w-sm space-y-3">
            <Field label={t('adminPassword')}>
              <Input name="password" type="password" required autoFocus autoComplete="current-password" />
            </Field>
            {problem}
            <div className="flex gap-2">
              <Button type="submit" disabled={busy}>
                {tSecond('continue')}
              </Button>
              {cancel}
            </div>
          </form>
        )}

        {step.at === 'scan' && (
          <form onSubmit={(event) => onFirstCode(event, step.setup)} className="max-w-sm space-y-3">
            <AuthenticatorSetup setup={step.setup} />
            <Field label={tSecond('code')} hint={tSecond('codeHint')}>
              <Input name="code" required autoFocus inputMode="numeric" autoComplete="one-time-code" maxLength={12} />
            </Field>
            {problem}
            <div className="flex gap-2">
              <Button type="submit" disabled={busy}>
                {tSecond('switchOn')}
              </Button>
              {cancel}
            </div>
          </form>
        )}

        {step.at === 'off' && (
          <form onSubmit={onOff} className="max-w-sm space-y-3">
            <Field label={t('adminPassword')}>
              <Input name="password" type="password" required autoFocus autoComplete="current-password" />
            </Field>
            <Field label={tSecond('code')}>
              <Input name="code" required inputMode="numeric" autoComplete="one-time-code" maxLength={12} />
            </Field>
            {problem}
            <div className="flex gap-2">
              <Button type="submit" disabled={busy}>
                {tSecond('switchOff')}
              </Button>
              {cancel}
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
