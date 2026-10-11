// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { type FormEvent, useState } from 'react';
import type { RecoveryCodes, SecondFactorSetup, SecondFactorState } from '@diet-app/shared';
import { AuthenticatorSetup } from '@/components/authenticator-setup';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { api, ApiClientError, waitOf } from '@/lib/api';

/** Where the card stands: at rest, or part of the way through one of the things it does. */
type Step =
  | { at: 'rest' }
  /** Asked for the password before a secret is handed out. */
  | { at: 'password' }
  | { at: 'scan'; setup: SecondFactorSetup }
  /** `fresh`: the codes of a second factor that was just switched on. */
  | { at: 'codes'; recoveryCodes: string[]; fresh: boolean }
  /** Asked for the password and a code: to switch off, or for new recovery codes. */
  | { at: 'proof'; to: 'off' | 'renew' };

/** With this few recovery codes left the card says so. */
const FEW_CODES = 3;

/**
 * Two-step sign-in of the account: whether it is on, setting it up with an
 * authenticator app, the recovery codes, and switching it off again.
 */
export function SecondFactorCard() {
  const t = useTranslations('secondFactor');
  const tErrors = useTranslations('errors');
  const tAuth = useTranslations('auth');
  const tCommon = useTranslations('common');
  const format = useFormatter();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>({ at: 'rest' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const state = useQuery({ queryKey: ['second-factor'], queryFn: () => api.get<SecondFactorState>('/users/me/second-factor') });

  function worded(err: unknown): string {
    if (!(err instanceof ApiClientError)) return t('failed');
    const wait = waitOf(err.status, err.retryAfterSeconds);
    if (wait) return tAuth(wait.unit === 'minutes' ? 'heldUp' : 'heldUpSeconds', wait);
    return tErrors.has(err.code) ? tErrors(err.code) : t('failed');
  }

  /** One request of the card at a time; what went wrong is shown, and `orElse` says where the card then stands. */
  async function run(work: () => Promise<void>, orElse?: (err: unknown) => void): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      await work();
    } catch (err) {
      setError(worded(err));
      orElse?.(err);
    } finally {
      setBusy(false);
    }
  }

  /** What the card shows, and the list of sessions beside it: switching the second step on ends the others. */
  const refresh = async (): Promise<void> => {
    await Promise.all([queryClient.invalidateQueries({ queryKey: ['second-factor'] }), queryClient.invalidateQueries({ queryKey: ['sessions'] })]);
  };
  const field = (event: FormEvent<HTMLFormElement>, name: string): string => String(new FormData(event.currentTarget).get(name) ?? '');

  function onPassword(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const currentPassword = field(event, 'currentPassword');
    void run(async () => setStep({ at: 'scan', setup: await api.post<SecondFactorSetup>('/users/me/second-factor/setup', { currentPassword }) }));
  }

  function onFirstCode(event: FormEvent<HTMLFormElement>, setup: SecondFactorSetup): void {
    event.preventDefault();
    const code = field(event, 'code');
    void run(
      async () => {
        const { recoveryCodes } = await api.post<RecoveryCodes>('/users/me/second-factor', { enrolment: setup.enrolment, code });
        setStep({ at: 'codes', recoveryCodes, fresh: true });
        await refresh();
      },
      // A set-up that ran out cannot be finished: it begins again.
      (err) => err instanceof ApiClientError && err.code !== 'INVALID_SECOND_FACTOR_CODE' && err.status !== 429 && setStep({ at: 'rest' }),
    );
  }

  function onProof(event: FormEvent<HTMLFormElement>, to: 'off' | 'renew'): void {
    event.preventDefault();
    const proof = { currentPassword: field(event, 'currentPassword'), code: field(event, 'code') };
    void run(async () => {
      if (to === 'off') {
        await api.delete<void>('/users/me/second-factor', proof);
        setStep({ at: 'rest' });
      } else {
        const { recoveryCodes } = await api.post<RecoveryCodes>('/users/me/second-factor/recovery-codes', proof);
        setStep({ at: 'codes', recoveryCodes, fresh: false });
      }
      await refresh();
    });
  }

  function copy(recoveryCodes: string[]): void {
    void navigator.clipboard.writeText(recoveryCodes.join('\n')).then(() => setCopied(true));
  }

  function to(next: Step): void {
    setError(null);
    setCopied(false);
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
  const on = state.data?.enabled === true;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{t('body')}</p>
        {state.isError && (
          <p role="alert" className="text-sm text-destructive">
            {t('failed')}
          </p>
        )}

        {step.at === 'rest' && state.data && (
          <>
            <p className="text-sm font-medium">
              {on && state.data.since ? t('isOn', { since: format.dateTime(new Date(state.data.since), { dateStyle: 'medium' }) }) : t('isOff')}
            </p>
            {on && (
              <p className="text-sm text-muted-foreground">
                {t('codesLeft', { count: state.data.recoveryCodesLeft })}
                {state.data.recoveryCodesLeft <= FEW_CODES && <> {t('codesLow')}</>}
              </p>
            )}
            {problem}
            <div className="flex flex-wrap gap-2">
              {on ? (
                <>
                  <Button type="button" variant="outline" onClick={() => to({ at: 'proof', to: 'renew' })}>
                    {t('newCodes')}
                  </Button>
                  <Button type="button" variant="outline" onClick={() => to({ at: 'proof', to: 'off' })}>
                    {t('switchOff')}
                  </Button>
                </>
              ) : (
                <Button type="button" onClick={() => to({ at: 'password' })}>
                  {t('setUp')}
                </Button>
              )}
            </div>
          </>
        )}

        {step.at === 'password' && (
          <form onSubmit={onPassword} className="max-w-sm space-y-3">
            <Field label={t('password')}>
              <Input name="currentPassword" type="password" required autoFocus autoComplete="current-password" />
            </Field>
            {problem}
            <div className="flex gap-2">
              <Button type="submit" disabled={busy}>
                {t('continue')}
              </Button>
              {cancel}
            </div>
          </form>
        )}

        {step.at === 'scan' && (
          <form onSubmit={(event) => onFirstCode(event, step.setup)} className="max-w-sm space-y-3">
            <AuthenticatorSetup setup={step.setup} />
            <Field label={t('code')} hint={t('codeHint')}>
              <Input name="code" required autoFocus inputMode="numeric" autoComplete="one-time-code" maxLength={12} />
            </Field>
            {problem}
            <div className="flex gap-2">
              <Button type="submit" disabled={busy}>
                {t('switchOn')}
              </Button>
              {cancel}
            </div>
          </form>
        )}

        {step.at === 'codes' && (
          <div className="space-y-3">
            {step.fresh && <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">{t('onNow')}</p>}
            <p className="text-sm font-medium">{t('recoveryTitle')}</p>
            <p className="text-sm text-muted-foreground">{t('recoveryBody')}</p>
            <ul aria-label={t('recoveryTitle')} className="grid max-w-sm grid-cols-2 gap-x-6 gap-y-1 rounded-md border border-border p-3 font-mono text-sm">
              {step.recoveryCodes.map((recoveryCode) => (
                <li key={recoveryCode}>{recoveryCode}</li>
              ))}
            </ul>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" onClick={() => copy(step.recoveryCodes)}>
                {t('copy')}
              </Button>
              <Button type="button" onClick={() => to({ at: 'rest' })}>
                {t('saved')}
              </Button>
              {copied && (
                <span role="status" className="text-xs text-muted-foreground">
                  {t('copied')}
                </span>
              )}
            </div>
          </div>
        )}

        {step.at === 'proof' && (
          <form onSubmit={(event) => onProof(event, step.to)} className="max-w-sm space-y-3">
            <p className="text-sm">{t(step.to === 'off' ? 'switchOffBody' : 'newCodesBody')}</p>
            <Field label={t('password')}>
              <Input name="currentPassword" type="password" required autoFocus autoComplete="current-password" />
            </Field>
            <Field label={t('codeOrRecovery')}>
              <Input name="code" required autoComplete="one-time-code" maxLength={40} />
            </Field>
            {problem}
            <div className="flex gap-2">
              <Button type="submit" disabled={busy}>
                {t(step.to === 'off' ? 'switchOff' : 'newCodes')}
              </Button>
              {cancel}
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
