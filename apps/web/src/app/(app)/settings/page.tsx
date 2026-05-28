'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import {
  type AiProvider,
  type AiProviderConfig,
  type AiProviderConfigInput,
  type SessionUser,
  type Theme,
} from '@diet-app/shared';
import { api, ApiClientError, tokenStore } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { LanguageSwitcher } from '@/components/language-switcher';
import { cn } from '@/lib/utils';

const PROVIDERS: AiProvider[] = ['openai', 'anthropic', 'openrouter', 'ollama'];

export default function SettingsPage() {
  const t = useTranslations('settings');
  const tErrors = useTranslations('errors');
  const qc = useQueryClient();
  const router = useRouter();
  const session = useQuery({
    queryKey: ['session'],
    queryFn: () => api.get<SessionUser>('/users/me'),
  });

  if (session.isLoading) {
    return <p className="text-sm text-muted-foreground">{t('subhead')}</p>;
  }
  if (!session.data) return null;
  const me = session.data;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subhead')}</p>
      </header>

      <ProfileCard me={me} onSaved={() => qc.invalidateQueries({ queryKey: ['session'] })} />
      <LanguageCard />
      <ThemeCard initial={me.theme} />
      <AiProvidersCard tErrors={tErrors} />
      <PasswordCard onChanged={() => router.push('/login')} />
      <EmailCard me={me} />
      <DangerZoneCard
        me={me}
        onDeleted={() => {
          tokenStore.clear();
          router.push('/');
        }}
      />
    </div>
  );
}

function ProfileCard({ me, onSaved }: { me: SessionUser; onSaved: () => void }) {
  const t = useTranslations('settings');
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
    onError: (err) =>
      setError(err instanceof ApiClientError ? err.message : t('profileFailed')),
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
            <p className="text-xs text-emerald-600 dark:text-emerald-400">{t('profileSaved')}</p>
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </form>
      </CardContent>
    </Card>
  );
}

function LanguageCard() {
  const t = useTranslations('settings');
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('language')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <LanguageSwitcher />
        <p className="text-xs text-muted-foreground">{t('languageSyncHint')}</p>
      </CardContent>
    </Card>
  );
}

function ThemeCard({ initial }: { initial: Theme }) {
  const t = useTranslations('settings');
  const { setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [value, setValue] = useState<Theme>(initial);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setMounted(true), []);

  async function pick(next: Theme) {
    setValue(next);
    setTheme(next);
    try {
      await api.patch('/users/me', { theme: next });
    } catch {
      // Best-effort sync — next-themes already changed the visual; surface
      // nothing if the persistence call fails (next login resyncs anyway).
    }
  }

  if (!mounted) return <Card><CardContent className="h-16" /></Card>;

  const options: { value: Theme; label: string }[] = [
    { value: 'light', label: t('themeLight') },
    { value: 'dark', label: t('themeDark') },
    { value: 'system', label: t('themeSystem') },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('theme')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex gap-2">
          {options.map((o) => (
            <Button
              key={o.value}
              type="button"
              size="sm"
              variant={value === o.value ? 'primary' : 'outline'}
              onClick={() => void pick(o.value)}
            >
              {o.label}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{t('themeSyncHint')}</p>
      </CardContent>
    </Card>
  );
}

function AiProvidersCard({ tErrors }: { tErrors: ReturnType<typeof useTranslations<'errors'>> }) {
  const t = useTranslations('settings');
  const tCommon = useTranslations('common');
  const qc = useQueryClient();
  const providers = useQuery({
    queryKey: ['ai-providers'],
    queryFn: () => api.get<AiProviderConfig[]>('/ai/providers'),
  });
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (dto: AiProviderConfigInput) => api.put<AiProviderConfig>('/ai/providers', dto),
    onSuccess: () => {
      setEditing(false);
      qc.invalidateQueries({ queryKey: ['ai-providers'] });
    },
    onError: (err) =>
      setError(
        err instanceof ApiClientError
          ? tErrors.has(err.code)
            ? tErrors(err.code)
            : err.message
          : t('aiFailed'),
      ),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete<void>(`/ai/providers/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ai-providers'] }),
    onError: (err) =>
      setError(
        err instanceof ApiClientError
          ? tErrors.has(err.code)
            ? tErrors(err.code)
            : err.message
          : t('aiDeleteFailed'),
      ),
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const f = new FormData(event.currentTarget);
    save.mutate({
      provider: f.get('provider') as AiProvider,
      model: String(f.get('model') ?? '').trim(),
      apiKey: String(f.get('apiKey') ?? '').trim() || undefined,
      priority: Number(f.get('priority') ?? 0),
      enabled: true,
    });
  }

  const list = providers.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('aiProviders')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{t('aiSubhead')}</p>
        {list.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">{t('aiNoProviders')}</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {list.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <div>
                  <span className="font-medium capitalize">{p.provider}</span>{' '}
                  <span className="text-xs text-muted-foreground">· {p.model}</span>
                  {p.isAdminDefault && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      ({t('aiAdminDefault')})
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground">
                    {p.hasKey ? t('aiHasKey') : t('aiNoKey')}
                  </span>
                  {!p.isAdminDefault && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="text-destructive"
                      disabled={remove.isPending}
                      onClick={() => {
                        if (window.confirm(t('aiDeleteConfirm'))) remove.mutate(p.id);
                      }}
                    >
                      {t('aiDelete')}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        {editing ? (
          <form onSubmit={onSubmit} className="grid max-w-2xl gap-3 sm:grid-cols-2">
            <Field label={t('aiProvider')}>
              <select
                name="provider"
                required
                className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm"
                defaultValue="openai"
              >
                {PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('aiModel')}>
              <Input name="model" required placeholder="gpt-4o-mini" />
            </Field>
            <Field label={t('aiApiKey')}>
              <Input name="apiKey" type="password" placeholder="sk-…" autoComplete="off" />
            </Field>
            <Field label={t('aiPriority')}>
              <Input name="priority" type="number" min={0} max={100} defaultValue={0} />
            </Field>
            <div className="flex items-end gap-2 sm:col-span-2">
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? t('aiSaving') : t('aiSave')}
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
              <p className="ml-auto text-xs text-muted-foreground">{t('aiPriorityHint')}</p>
            </div>
            {error && <p className="text-xs text-destructive sm:col-span-2">{error}</p>}
          </form>
        ) : (
          <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
            {t('aiAddProvider')}
          </Button>
        )}
        {!editing && error && <p className="text-xs text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}

function PasswordCard({ onChanged }: { onChanged: () => void }) {
  const t = useTranslations('settings');
  const tErrors = useTranslations('errors');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const change = useMutation({
    mutationFn: (body: { currentPassword: string; newPassword: string }) =>
      api.post<void>('/users/me/password', body),
    onSuccess: () => {
      setDone(true);
      // Server invalidated active sessions; clear local + send to login.
      tokenStore.clear();
      window.setTimeout(onChanged, 1200);
    },
    onError: (err) =>
      setError(
        err instanceof ApiClientError
          ? tErrors.has(err.code)
            ? tErrors(err.code)
            : err.message
          : t('passwordFailed'),
      ),
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
            <Input name="currentPassword" type="password" required autoComplete="current-password" />
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
            {done && (
              <p className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">
                {t('passwordChanged')}
              </p>
            )}
            {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function EmailCard({ me }: { me: SessionUser }) {
  const t = useTranslations('settings');
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('email')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        <p className="font-mono text-sm">{me.email}</p>
        <p className="text-xs text-muted-foreground">
          {me.emailVerified ? t('emailVerified') : t('emailUnverified')} · {t('emailHint')}
        </p>
      </CardContent>
    </Card>
  );
}

function DangerZoneCard({ me, onDeleted }: { me: SessionUser; onDeleted: () => void }) {
  const t = useTranslations('settings');
  const tCommon = useTranslations('common');
  const tErrors = useTranslations('errors');
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const remove = useMutation({
    mutationFn: () => api.delete<void>('/users/me'),
    // The API uses a Body for the delete-confirm; api.delete only accepts a
    // path, so route through the underlying request helper via POST sentinel —
    // simpler: build a fetch directly.
    onSuccess: onDeleted,
    onError: (err) =>
      setError(
        err instanceof ApiClientError
          ? tErrors.has(err.code)
            ? tErrors(err.code)
            : err.message
          : t('deleteFailed'),
      ),
  });

  async function confirm() {
    setError(null);
    if (email.trim().toLowerCase() !== me.email.toLowerCase() || !password) return;
    try {
      // The DELETE endpoint expects a body — bypass api.delete (no body support)
      // and call fetch directly. Token is read from the same store.
      const res = await fetch('/api/users/me', {
        method: 'DELETE',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${tokenStore.access ?? ''}`,
        },
        body: JSON.stringify({ currentPassword: password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { code?: string; error?: string; message?: string };
        const code = body.code ?? body.error;
        setError(code && tErrors.has(code) ? tErrors(code) : body.message ?? t('deleteFailed'));
        return;
      }
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('deleteFailed'));
    }
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
                onClick={() => void confirm()}
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
