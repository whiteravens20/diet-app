// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

/** The name an account shows. */
import { useMutation } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import {
  type SessionUser,
} from '@diet-app/shared';
import { api } from '@/lib/api';
import { useErrorText } from '@/lib/use-error-text';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';

export function ProfileCard({ me, onSaved }: { me: SessionUser; onSaved: () => void }) {
  const t = useTranslations('settings');
  const errorText = useErrorText();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: (displayName: string) =>
      api.patch<SessionUser>('/users/me', { displayName }),
    onSuccess: () => {
      setSaved(true);
      onSaved();
      window.setTimeout(() => setSaved(false), 2000);
    },
    onError: (err) => setError(errorText(err, t('profileFailed'))),
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSaved(false);
    const form = new FormData(event.currentTarget);
    const next = String(form.get('displayName') ?? '').trim();
    if (next && next !== me.displayName) save.mutate(next);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('profile')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex max-w-md flex-wrap items-end gap-3">
          <Field label={t('displayName')}>
            <Input
              name="displayName"
              required
              minLength={1}
              maxLength={80}
              defaultValue={me.displayName}
            />
          </Field>
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? t('saveProfile') + '…' : t('saveProfile')}
          </Button>
          {saved && (
            <p className="text-xs text-success">{t('profileSaved')}</p>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </form>
      </CardContent>
    </Card>
  );
}
