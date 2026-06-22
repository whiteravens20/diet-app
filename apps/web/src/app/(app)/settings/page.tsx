'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import {
  type AiMode,
  type AiProvider,
  type AiProviderConfig,
  type AiProviderConfigInput,
  type AiQuotaStatus,
  type AiTestConnectionResponse,
  type Palette,
  type SessionUser,
  type Theme,
} from '@diet-app/shared';
import { api, ApiClientError, tokenStore } from '@/lib/api';
import { useConfig } from '@/lib/use-config';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { DisclaimerNotice } from '@/components/disclaimer-notice';
import { LanguageSwitcher } from '@/components/language-switcher';
import { DEFAULT_PALETTE, SUPPORTED_PALETTES } from '@/lib/palette';
import { usePalette } from '@/app/providers';
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
      <PaletteCard initial={me.palette} />
      <AiAssistantCard me={me} tErrors={tErrors} />
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

// Swatch colours rendered next to each palette name in the picker. Tied to
// the primary token of each palette so the chip preview matches the actual
// scheme without needing to render a hidden DOM. Order matches `Palette` enum.
const PALETTE_SWATCHES: Record<Palette, string> = {
  default: 'oklch(0.62 0.15 155)',
  ocean: 'oklch(0.6 0.15 240)',
  forest: 'oklch(0.52 0.13 145)',
  sunset: 'oklch(0.65 0.16 50)',
  mono: 'oklch(0.3 0 0)',
  rose: 'oklch(0.6 0.17 5)',
};

function PaletteCard({ initial }: { initial: Palette }) {
  const t = useTranslations('settings');
  const tPalette = useTranslations('settings.paletteOption');
  const { palette: live, setPalette } = usePalette();
  // The provider's `live` value is initialised from the SSR cookie, which may
  // disagree with the server-stored `initial` on a freshly signed-in device.
  // Prefer `live` once it diverges from `initial` (the user picked something
  // here) — otherwise show the server's preference.
  const value: Palette = live === DEFAULT_PALETTE && initial !== DEFAULT_PALETTE ? initial : live;

  async function pick(next: Palette) {
    setPalette(next); // applies <html data-palette> + cookie immediately
    try {
      await api.patch('/users/me', { palette: next });
    } catch {
      // Best-effort cross-device sync — visual is already applied via cookie.
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('palette')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex flex-wrap gap-2">
          {SUPPORTED_PALETTES.map((p) => (
            <Button
              key={p}
              type="button"
              size="sm"
              variant={value === p ? 'primary' : 'outline'}
              onClick={() => void pick(p)}
              className="gap-2"
            >
              <span
                aria-hidden
                className="inline-block h-3 w-3 rounded-full border border-border"
                style={{ backgroundColor: PALETTE_SWATCHES[p] }}
              />
              {tPalette(p)}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{t('paletteSyncHint')}</p>
      </CardContent>
    </Card>
  );
}

function AiAssistantCard({
  me,
  tErrors,
}: {
  me: SessionUser;
  tErrors: ReturnType<typeof useTranslations<'errors'>>;
}) {
  const t = useTranslations('settings');
  const qc = useQueryClient();
  const quota = useQuery({
    queryKey: ['ai-quota'],
    queryFn: () => api.get<AiQuotaStatus>('/ai/quota'),
  });
  // Shared cache key with AiProvidersCard — no extra round-trip. Used to
  // gate the BYOK option: switching to byok with zero enabled rows would
  // silently fall back to deterministic, which is the wrong UX.
  const providers = useQuery({
    queryKey: ['ai-providers'],
    queryFn: () => api.get<AiProviderConfig[]>('/ai/providers'),
  });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: (aiMode: AiMode) =>
      api.patch<SessionUser>('/users/me', { aiMode }),
    onSuccess: () => {
      setSaved(true);
      qc.invalidateQueries({ queryKey: ['session'] });
      qc.invalidateQueries({ queryKey: ['ai-quota'] });
      window.setTimeout(() => setSaved(false), 2000);
    },
    onError: (err) =>
      setError(
        err instanceof ApiClientError
          ? tErrors.has(err.code)
            ? tErrors(err.code)
            : err.message
          : t('aiModeFailed'),
      ),
  });

  const status = quota.data;
  // Admin mode is offered only when the operator has set both
  // AI_DEFAULT_PROVIDER and AI_DEFAULT_MODEL AND the env-configured monthly
  // limit is > 0. The two failure modes get different copy so the operator
  // can tell "not set up" from "set up but not shared with users."
  const adminProviderConfigured = status?.adminProviderConfigured === true;
  const adminSharingEnabled = (status?.limit ?? 0) > 0;
  const adminAvailable = quota.isSuccess && adminProviderConfigured && adminSharingEnabled;
  // Same idea for BYOK: only meaningful once the providers list resolved.
  // When the user has zero enabled keys the radio is disabled so they can't
  // flip into a mode that would silently fall back to deterministic.
  const enabledProviderCount = providers.data?.filter((p) => p.enabled).length ?? 0;
  const byokAvailable = providers.isSuccess && enabledProviderCount > 0;

  function pick(mode: AiMode) {
    setError(null);
    if (mode === me.aiMode) return;
    save.mutate(mode);
  }

  const modes: AiMode[] = adminAvailable ? ['none', 'admin', 'byok'] : ['none', 'byok'];

  function isModeDisabled(mode: AiMode): boolean {
    if (mode === 'byok') return !byokAvailable;
    return false;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('aiAssistant')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{t('aiAssistantSubhead')}</p>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t('aiMode')}</legend>
          {modes.map((mode) => {
            const disabled = isModeDisabled(mode);
            return (
              <label
                key={mode}
                className={cn(
                  'flex items-start gap-3 rounded-md border border-border px-3 py-2 text-sm transition-colors',
                  disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
                  me.aiMode === mode && 'border-primary bg-primary/5',
                )}
              >
                <input
                  type="radio"
                  name="aiMode"
                  value={mode}
                  checked={me.aiMode === mode}
                  onChange={() => pick(mode)}
                  disabled={save.isPending || disabled}
                  className="mt-1"
                />
                <span className="flex flex-col gap-0.5">
                  <span className="font-medium">
                    {mode === 'none'
                      ? t('aiModeNone')
                      : mode === 'admin'
                        ? t('aiModeAdmin')
                        : t('aiModeByok')}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {mode === 'none'
                      ? t('aiModeNoneHint')
                      : mode === 'admin'
                        ? t('aiModeAdminHint', { limit: status?.limit ?? 10 })
                        : t('aiModeByokHint')}
                  </span>
                  {mode === 'byok' && !byokAvailable && providers.isSuccess && (
                    <span className="text-xs italic text-muted-foreground">
                      {t('aiModeByokUnavailable')}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
          {quota.isSuccess && !adminAvailable && (
            <p className="text-xs text-muted-foreground italic">
              {adminProviderConfigured
                ? t('aiModeAdminDisabled')
                : t('aiModeAdminUnavailable')}
            </p>
          )}
        </fieldset>

        {me.aiMode !== 'none' && <DisclaimerNotice bodyKey="aiActivated" />}

        {me.aiMode === 'admin' && status != null && (
          <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
            <p className="font-medium">{t('aiQuotaHeading')}</p>
            <p>
              {t('aiQuotaUsed', {
                used: status.used,
                limit: status.limit,
              })}
            </p>
            {status.resetAt ? (
              <p className="text-xs text-muted-foreground">
                {t('aiQuotaResetAt', {
                  date: new Date(status.resetAt).toLocaleString(),
                })}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">{t('aiQuotaUnused')}</p>
            )}
          </div>
        )}

        {save.isPending && (
          <p className="text-xs text-muted-foreground">{t('aiModeSaving')}</p>
        )}
        {saved && (
          <p className="text-xs text-emerald-600 dark:text-emerald-400">
            {t('aiModeSaved')}
          </p>
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}

function AiProvidersCard({ tErrors }: { tErrors: ReturnType<typeof useTranslations<'errors'>> }) {
  const t = useTranslations('settings');
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
    // Backend auto-flips aiMode byok → admin when the last provider goes;
    // refetch the session so the radio reflects the new mode immediately.
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ai-providers'] });
      qc.invalidateQueries({ queryKey: ['session'] });
      qc.invalidateQueries({ queryKey: ['ai-quota'] });
    },
    onError: (err) =>
      setError(
        err instanceof ApiClientError
          ? tErrors.has(err.code)
            ? tErrors(err.code)
            : err.message
          : t('aiDeleteFailed'),
      ),
  });

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
          <ProviderForm
            onCancel={() => {
              setEditing(false);
              setError(null);
            }}
            onSubmit={(dto) => save.mutate(dto)}
            saving={save.isPending}
            error={error}
          />
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

/**
 * BYOK provider form with a Test-connection probe. The Test button hits
 * `/ai/test` with the current provider + credentials, surfaces the
 * provider's error verbatim on failure, or populates a model dropdown from
 * the returned list on success so the user picks a real model instead of
 * typing one. Saving without a successful test is still allowed (the user
 * may know the model id), but the dropdown is the happy path.
 */
function ProviderForm({
  onCancel,
  onSubmit,
  saving,
  error,
}: {
  onCancel: () => void;
  onSubmit: (dto: AiProviderConfigInput) => void;
  saving: boolean;
  error: string | null;
}) {
  const t = useTranslations('settings');
  const tCommon = useTranslations('common');
  const [provider, setProvider] = useState<AiProvider>('openai');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [priority, setPriority] = useState(0);
  const [testResult, setTestResult] = useState<AiTestConnectionResponse | null>(null);

  const test = useMutation({
    mutationFn: () =>
      api.post<AiTestConnectionResponse>('/ai/test', {
        provider,
        apiKey: apiKey.trim() || undefined,
        baseUrl: baseUrl.trim() || undefined,
        model: model.trim() || undefined,
      }),
    onSuccess: (res) => setTestResult(res),
    onError: () =>
      setTestResult({
        ok: false,
        models: [],
        error: t('aiTestFailed', { error: '?' }),
      }),
  });

  function reset() {
    setTestResult(null);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit({
      provider,
      model: model.trim(),
      apiKey: apiKey.trim() || undefined,
      baseUrl: baseUrl.trim() || undefined,
      priority,
      enabled: true,
    });
  }

  const isOllama = provider === 'ollama';

  return (
    <form onSubmit={submit} className="grid max-w-2xl gap-3 sm:grid-cols-2">
      <div
        className="sm:col-span-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-900 dark:text-amber-200"
        role="note"
      >
        <p className="font-medium">{t('aiModelWarningTitle')}</p>
        <p className="mt-1">{t('aiModelWarning')}</p>
      </div>
      <Field label={t('aiProvider')}>
        <select
          name="provider"
          required
          className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm"
          value={provider}
          onChange={(e) => {
            setProvider(e.target.value as AiProvider);
            reset();
          }}
        >
          {PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </Field>
      {testResult?.ok && testResult.models.length > 0 ? (
        <Field label={t('aiPickModel')}>
          <select
            required
            className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          >
            <option value="">—</option>
            {testResult.models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <Field label={t('aiModel')}>
          <Input
            name="model"
            required
            placeholder={isOllama ? 'llama3.1:8b' : 'gpt-4o-mini'}
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
              reset();
            }}
          />
        </Field>
      )}
      {isOllama ? (
        <Field label={t('aiOllamaUrl')}>
          <Input
            name="baseUrl"
            type="url"
            required
            pattern="https?://.+"
            title={t('aiOllamaUrlInvalid')}
            placeholder="http://localhost:11434"
            value={baseUrl}
            onChange={(e) => {
              setBaseUrl(e.target.value);
              reset();
            }}
          />
        </Field>
      ) : (
        <Field label={t('aiApiKey')}>
          <Input
            name="apiKey"
            type="password"
            required
            placeholder="sk-…"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              reset();
            }}
          />
        </Field>
      )}
      <Field label={t('aiPriority')}>
        <Input
          name="priority"
          type="number"
          min={0}
          max={100}
          value={priority}
          onChange={(e) => setPriority(Number(e.target.value))}
        />
      </Field>
      <div className="flex flex-wrap items-end gap-2 sm:col-span-2">
        <Button type="submit" disabled={saving}>
          {saving ? t('aiSaving') : t('aiSave')}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={test.isPending}
          onClick={() => test.mutate()}
        >
          {test.isPending ? t('aiTesting') : t('aiTestConnection')}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {tCommon('cancel')}
        </Button>
        <p className="ml-auto text-xs text-muted-foreground">{t('aiPriorityHint')}</p>
      </div>
      {testResult && (
        <p
          className={cn(
            'text-xs sm:col-span-2',
            testResult.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive',
          )}
        >
          {testResult.ok ? t('aiTestOk') : t('aiTestFailed', { error: testResult.error ?? '?' })}
        </p>
      )}
      {error && <p className="text-xs text-destructive sm:col-span-2">{error}</p>}
    </form>
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
  const tCommon = useTranslations('common');
  const tErrors = useTranslations('errors');
  const config = useConfig();
  const emailEnabled = config.data?.email.enabled ?? false;
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [resendDone, setResendDone] = useState(false);

  function mapError(err: unknown, fallback: string): string {
    return err instanceof ApiClientError
      ? tErrors.has(err.code)
        ? tErrors(err.code)
        : err.message
      : fallback;
  }

  const change = useMutation({
    mutationFn: (body: { newEmail: string; currentPassword: string }) =>
      api.post<void>('/users/me/email', body),
    onSuccess: () => {
      setSent(true);
      setEditing(false);
    },
    onError: (err) => setError(mapError(err, t('changeEmailFailed'))),
  });

  const resend = useMutation({
    mutationFn: () => api.post<void>('/users/me/email/resend-verification'),
    onSuccess: () => setResendDone(true),
    onError: (err) => setError(mapError(err, t('resendVerificationFailed'))),
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
              <p className="text-xs text-emerald-600 dark:text-emerald-400">
                {t('resendVerificationSent')}
              </p>
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
          <p className="text-xs text-emerald-600 dark:text-emerald-400">{t('changeEmailSent')}</p>
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
