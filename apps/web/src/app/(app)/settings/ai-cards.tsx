// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

/** What an account lets a model do, and the providers it brings of its own. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import {
  type AiDataPolicy,
  type AiMode,
  type AiProvider,
  type AiProviderConfig,
  type AiProviderConfigInput,
  type AiQuotaStatus,
  type AiTestConnectionResponse,
  type SessionUser,
} from '@diet-app/shared';
import { api } from '@/lib/api';
import { useConfig } from '@/lib/use-config';
import { useErrorText } from '@/lib/use-error-text';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ReadsFailed, unread } from '@/components/load-failed';
import { Field, Input } from '@/components/ui/input';
import { PasswordField } from '@/components/ui/password-field';
import { DisclaimerNotice } from '@/components/disclaimer-notice';
import { OperatorContact } from '@/components/operator-contact';
import { cn } from '@/lib/utils';
import { useFormat } from '@/lib/use-format';

const PROVIDERS: AiProvider[] = ['openai', 'anthropic', 'openrouter', 'ollama'];

/** The choices of OpenRouter's endpoints, the default first, with their texts. */
const DATA_POLICIES = [
  { policy: 'no_training', label: 'aiDataPolicyNoTraining', hint: 'aiDataPolicyNoTrainingHint' },
  { policy: 'no_retention', label: 'aiDataPolicyNoRetention', hint: 'aiDataPolicyNoRetentionHint' },
  { policy: 'any', label: 'aiDataPolicyAny', hint: 'aiDataPolicyAnyHint' },
] as const satisfies readonly { policy: AiDataPolicy; label: string; hint: string }[];

export function AiAssistantCard({ me }: { me: SessionUser }) {
  const t = useTranslations('settings');
  const errorText = useErrorText();
  const fmt = useFormat();
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
  // The terms of the instance's own AI as the instance publishes them: none where it offers none.
  const terms = useConfig().data?.ai.operator ?? null;
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: (aiMode: AiMode) => api.patch<SessionUser>('/users/me', { aiMode }),
    onSuccess: () => {
      setSaved(true);
      qc.invalidateQueries({ queryKey: ['session'] });
      qc.invalidateQueries({ queryKey: ['ai-quota'] });
      window.setTimeout(() => setSaved(false), 2000);
    },
    onError: (err) => setError(errorText(err, t('aiModeFailed'))),
  });

  const status = quota.data;
  // Admin mode is offered only when the operator has set both
  // AI_DEFAULT_PROVIDER and AI_DEFAULT_MODEL AND the env-configured monthly
  // limit is > 0. The two failure modes get different copy so the operator
  // can tell "not set up" from "set up but not shared with users."
  const adminProviderConfigured = status?.adminProviderConfigured === true;
  const adminSharingEnabled = (status?.limit ?? 0) > 0;
  const adminAvailable = quota.isSuccess && adminProviderConfigured && adminSharingEnabled;
  // The operator decides which accounts may use its provider: the option is
  // there, and off, for one that may not, with what it takes to get it.
  const adminAccess = status?.adminAccess ?? 'granted';
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
    if (mode === 'admin') return adminAccess !== 'granted';
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
              {adminProviderConfigured ? t('aiModeAdminDisabled') : t('aiModeAdminUnavailable')}
            </p>
          )}
          {adminAvailable && adminAccess !== 'granted' && (
            <div className="space-y-1 text-xs text-muted-foreground">
              <p className="italic">
                {adminAccess === 'email_unconfirmed'
                  ? t('aiModeAdminConfirmEmail')
                  : t('aiModeAdminNotApproved')}
              </p>
              {adminAccess === 'not_approved' && (
                <OperatorContact notPublished={t('aiModeAdminNoContact')} />
              )}
            </div>
          )}
        </fieldset>

        {terms && (
          <div className="space-y-1 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">{t('aiInstanceTerms')}</p>
            <p>{t(`aiInstanceAccess.${terms.access}`)}</p>
            <p>
              {t('aiInstanceLimits', {
                monthly: terms.monthlyLimit,
                instance: terms.instanceMonthlyLimit,
              })}
            </p>
            {terms.dataPolicy && <p>{t(`aiInstancePolicy.${terms.dataPolicy}`)}</p>}
          </div>
        )}

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
            {status.adminAccess !== 'granted' ? (
              <p className="text-xs text-muted-foreground">{t('aiQuotaNoAccess')}</p>
            ) : status.resetAt ? (
              <p className="text-xs text-muted-foreground">
                {t('aiQuotaResetAt', {
                  date: fmt.moment(status.resetAt),
                })}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">{t('aiQuotaUnused')}</p>
            )}
            {status.adminAccess === 'granted' && status.newUntil && (
              <p className="text-xs text-muted-foreground">
                {t(
                  status.newAccountsLimitReached ? 'aiQuotaNewAccountsUsedUp' : 'aiQuotaNewAccount',
                  { date: fmt.moment(status.newUntil) },
                )}
              </p>
            )}
          </div>
        )}

        {save.isPending && <p className="text-xs text-muted-foreground">{t('aiModeSaving')}</p>}
        {saved && <p className="text-xs text-success">{t('aiModeSaved')}</p>}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}

export function AiProvidersCard() {
  const t = useTranslations('settings');
  const errorText = useErrorText();
  const qc = useQueryClient();
  const providers = useQuery({
    queryKey: ['ai-providers'],
    queryFn: () => api.get<AiProviderConfig[]>('/ai/providers'),
  });
  /** The form open: for a provider to add, or for a saved one to change. */
  const [editing, setEditing] = useState<AiProviderConfig | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (dto: AiProviderConfigInput) => api.put<AiProviderConfig>('/ai/providers', dto),
    onSuccess: () => {
      setEditing(null);
      qc.invalidateQueries({ queryKey: ['ai-providers'] });
    },
    onError: (err) => setError(errorText(err, t('aiFailed'))),
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
    onError: (err) => setError(errorText(err, t('aiDeleteFailed'))),
  });

  const list = providers.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('aiProviders')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{t('aiSubhead')}</p>
        {unread(providers) ? (
          <ReadsFailed reads={[providers]} unanswered />
        ) : list.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">{t('aiNoProviders')}</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {list.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <div>
                  <span className="font-medium capitalize">{p.provider}</span>{' '}
                  <span className="text-xs text-muted-foreground">· {p.model}</span>
                  {p.dataPolicy && (
                    <span className="block text-xs text-muted-foreground">
                      {t(DATA_POLICIES.find((c) => c.policy === p.dataPolicy)!.label)}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 text-xs">
                  {p.keyUnreadable ? (
                    <span className="text-destructive">{t('aiKeyUnreadable')}</span>
                  ) : (
                    <span className="text-muted-foreground">
                      {p.hasKey ? t('aiHasKey') : t('aiNoKey')}
                    </span>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setError(null);
                      setEditing(p);
                    }}
                  >
                    {t('aiChange')}
                  </Button>
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
                </div>
              </li>
            ))}
          </ul>
        )}

        {editing ? (
          <ProviderForm
            // A form of its own for each entry: one opened for another starts from that one's choices.
            key={editing === 'new' ? 'new' : editing.id}
            saved={list}
            entry={editing === 'new' ? undefined : editing}
            onCancel={() => {
              setEditing(null);
              setError(null);
            }}
            onSubmit={(dto) => save.mutate(dto)}
            saving={save.isPending}
            error={error}
          />
        ) : (
          <Button type="button" variant="outline" size="sm" onClick={() => setEditing('new')}>
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
 *
 * Opened for a saved entry, it starts from that entry's model, choice and
 * priority, with the provider fixed. A provider whose key is saved and can be
 * read needs none typed: an empty field keeps it, for the save and for the
 * test alike, and a key typed replaces it.
 */
function ProviderForm({
  saved,
  entry,
  onCancel,
  onSubmit,
  saving,
  error,
}: {
  /** The account's saved configurations: a new save of one starts from its choices. */
  saved: AiProviderConfig[];
  /** The saved configuration being changed; none when a provider is added. */
  entry?: AiProviderConfig | undefined;
  onCancel: () => void;
  onSubmit: (dto: AiProviderConfigInput) => void;
  saving: boolean;
  error: string | null;
}) {
  const t = useTranslations('settings');
  const tCommon = useTranslations('common');
  const [provider, setProvider] = useState<AiProvider>(entry?.provider ?? 'openai');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(entry?.baseUrl ?? '');
  const [model, setModel] = useState(entry?.model ?? '');
  const [priority, setPriority] = useState(entry?.priority ?? 0);
  const [dataPolicy, setDataPolicy] = useState<AiDataPolicy>(
    () => saved.find((p) => p.provider === 'openrouter')?.dataPolicy ?? 'no_training',
  );
  // The key saved for the provider chosen, as long as it can be read.
  const keyKept = saved.some((p) => p.provider === provider && p.hasKey && !p.keyUnreadable);
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
      dataPolicy: provider === 'openrouter' ? dataPolicy : undefined,
      priority,
      enabled: true,
    });
  }

  const isOllama = provider === 'ollama';

  return (
    <form onSubmit={submit} className="grid max-w-2xl gap-3 sm:grid-cols-2">
      <div
        className="sm:col-span-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-warning"
        role="note"
      >
        <p className="font-medium">{t('aiModelWarningTitle')}</p>
        <p className="mt-1">{t('aiModelWarning')}</p>
      </div>
      <Field label={t('aiProvider')}>
        <select
          name="provider"
          required
          disabled={entry !== undefined}
          className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm disabled:opacity-70"
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
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
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
        <PasswordField
          label={t('aiApiKey')}
          secret="key"
          name="apiKey"
          required={!keyKept}
          hint={keyKept ? t('aiKeyKept') : undefined}
          placeholder="sk-…"
          autoComplete="off"
          value={apiKey}
          onChange={(e) => {
            setApiKey(e.target.value);
            reset();
          }}
        />
      )}
      {provider === 'openrouter' && (
        <fieldset className="space-y-2 sm:col-span-2">
          <legend className="text-sm font-medium">{t('aiDataPolicy')}</legend>
          {DATA_POLICIES.map((choice) => (
            <label
              key={choice.policy}
              className={cn(
                'flex cursor-pointer items-start gap-3 rounded-md border border-border px-3 py-2 text-sm transition-colors',
                dataPolicy === choice.policy && 'border-primary bg-primary/5',
              )}
            >
              <input
                type="radio"
                name="dataPolicy"
                value={choice.policy}
                checked={dataPolicy === choice.policy}
                onChange={() => setDataPolicy(choice.policy)}
                className="mt-1"
              />
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">{t(choice.label)}</span>
                <span className="text-xs text-muted-foreground">{t(choice.hint)}</span>
              </span>
            </label>
          ))}
          <p className="text-xs text-muted-foreground">{t('aiDataPolicyRefused')}</p>
        </fieldset>
      )}
      <Field label={t('aiPriority')} optional>
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
            testResult.ok ? 'text-success' : 'text-destructive',
          )}
        >
          {testResult.ok ? t('aiTestOk') : t('aiTestFailed', { error: testResult.error ?? '?' })}
        </p>
      )}
      {error && <p className="text-xs text-destructive sm:col-span-2">{error}</p>}
    </form>
  );
}
