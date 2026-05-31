'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Copy, ShieldCheck, ShieldOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import {
  AdminApiError,
  adminApi,
  type InstanceSettingsDto,
} from '@/lib/admin-api';

/**
 * Admin card that manages the Phase H reviewer interface — toggle, password,
 * and the shareable `/review` URL the operator hands to invited reviewers.
 *
 * The reviewer interface itself lives at `/review` (a public Next.js route).
 * Toggling this off makes the guard refuse every active session instantly;
 * clearing the password disables login.
 */
export function ReviewerConfigCard() {
  const t = useTranslations('admin.reviewer');
  const [settings, setSettings] = useState<InstanceSettingsDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [passwordInput, setPasswordInput] = useState('');
  const [savingToggle, setSavingToggle] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const s = await adminApi.instanceSettings();
        setSettings(s);
      } catch (err) {
        setError(err instanceof Error ? err.message : t('loadFailed'));
      } finally {
        setLoading(false);
      }
    })();
  }, [t]);

  const reviewUrl =
    typeof window === 'undefined'
      ? '/review'
      : new URL('/review', window.location.origin).toString();

  const toggle = async (next: boolean): Promise<void> => {
    setSavingToggle(true);
    setError(null);
    try {
      const updated = await adminApi.patchInstanceSettings({ reviewerEnabled: next });
      setSettings(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('toggleFailed'));
    } finally {
      setSavingToggle(false);
    }
  };

  const setPassword = async (next: string): Promise<void> => {
    setSavingPassword(true);
    setError(null);
    try {
      const updated = await adminApi.patchInstanceSettings({ reviewerPassword: next });
      setSettings(updated);
      setPasswordInput('');
    } catch (err) {
      if (err instanceof AdminApiError && err.status === 400) {
        setError(t('passwordTooLong'));
      } else {
        setError(err instanceof Error ? err.message : t('passwordSaveFailed'));
      }
    } finally {
      setSavingPassword(false);
    }
  };

  const copyUrl = (): void => {
    if (typeof window === 'undefined') return;
    void navigator.clipboard.writeText(reviewUrl).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  const enabled = settings?.reviewerEnabled === true;
  const passwordSet = settings?.reviewerPasswordSet === true;
  const fullyOn = enabled && passwordSet;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {fullyOn ? (
            <ShieldCheck className="h-5 w-5 text-emerald-500" />
          ) : (
            <ShieldOff className="h-5 w-5 text-muted-foreground" />
          )}
          {t('title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-sm text-muted-foreground">{t('explain')}</p>

        {loading ? (
          <p className="text-sm text-muted-foreground">{t('loading')}</p>
        ) : (
          <>
            <div className="flex items-start justify-between gap-3 rounded-md border bg-muted/40 px-3 py-2">
              <div className="space-y-0.5">
                <p className="text-sm font-medium">{t('statusLabel')}</p>
                <p className="text-sm text-muted-foreground">
                  {fullyOn
                    ? t('statusEnabled')
                    : enabled && !passwordSet
                      ? t('statusEnabledNoPassword')
                      : t('statusDisabled')}
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant={enabled ? 'outline' : 'primary'}
                onClick={() => void toggle(!enabled)}
                disabled={savingToggle}
              >
                {enabled ? t('disable') : t('enable')}
              </Button>
            </div>

            {fullyOn ? (
              <div className="space-y-2 rounded-md border border-emerald-500/40 bg-emerald-500/5 px-3 py-2">
                <p className="text-sm font-medium">{t('shareTitle')}</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 truncate rounded bg-background px-2 py-1 text-xs">
                    {reviewUrl}
                  </code>
                  <Button type="button" size="sm" variant="outline" onClick={copyUrl}>
                    <Copy className="mr-1 h-3 w-3" />
                    {copied ? t('copied') : t('copy')}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">{t('shareHint')}</p>
              </div>
            ) : null}

            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (passwordInput.length === 0) return;
                void setPassword(passwordInput);
              }}
            >
              <Field label={passwordSet ? t('rotatePassword') : t('setPassword')}>
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={passwordInput}
                  onChange={(e) => setPasswordInput(e.target.value)}
                  placeholder={t('passwordPlaceholder')}
                  maxLength={200}
                />
              </Field>
              <div className="flex items-center gap-2">
                <Button
                  type="submit"
                  size="sm"
                  disabled={savingPassword || passwordInput.length === 0}
                >
                  {savingPassword ? t('saving') : t('savePassword')}
                </Button>
                {passwordSet ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void setPassword('')}
                    disabled={savingPassword}
                  >
                    {t('clearPassword')}
                  </Button>
                ) : null}
              </div>
            </form>

            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
