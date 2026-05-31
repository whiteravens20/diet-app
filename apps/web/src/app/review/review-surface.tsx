'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { LogOut } from 'lucide-react';
import type { Locale, ReviewerSessionDto } from '@diet-app/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import {
  ReviewApiError,
  reviewApi,
  type ReviewStatusDto,
} from '@/lib/review-api';
import { ReviewQueue } from './review-queue';

type View = 'loading' | 'disabled' | 'login' | 'session' | 'unreachable';

/**
 * Top-level controller for `/review` — picks between disabled / login /
 * authenticated session states.
 */
export function ReviewSurface() {
  const t = useTranslations('review');
  const [view, setView] = useState<View>('loading');
  const [status, setStatus] = useState<ReviewStatusDto | null>(null);
  const [session, setSession] = useState<ReviewerSessionDto | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [s, sess] = await Promise.all([reviewApi.status(), reviewApi.session()]);
      setStatus(s);
      if (!s.enabled || !s.passwordSet) {
        setView('disabled');
        return;
      }
      if (sess.session) {
        setSession(sess.session);
        setView('session');
      } else {
        setSession(null);
        setView('login');
      }
    } catch {
      setView('unreachable');
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await refresh();
    })();
  }, [refresh]);

  if (view === 'loading') {
    return <p className="text-sm text-muted-foreground">{t('loading')}</p>;
  }
  if (view === 'unreachable') {
    return (
      <Card className="border-destructive/40 bg-destructive/5">
        <CardContent className="space-y-3 pt-6 text-sm">
          <p>{t('unreachable')}</p>
          <Button variant="outline" size="sm" onClick={() => void refresh()}>
            {t('retry')}
          </Button>
        </CardContent>
      </Card>
    );
  }
  if (view === 'disabled' || !status) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('disabledTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          {t('disabledExplain')}
        </CardContent>
      </Card>
    );
  }
  if (view === 'login') {
    return <ReviewLoginForm onLoggedIn={() => void refresh()} />;
  }
  if (session) {
    return (
      <ReviewSession
        session={session}
        locales={status.locales}
        onLogout={async () => {
          try {
            await reviewApi.logout();
          } catch {
            // Logout failure is harmless; we'll refresh anyway.
          }
          await refresh();
        }}
      />
    );
  }
  return null;
}

function ReviewLoginForm({ onLoggedIn }: { onLoggedIn: () => void }) {
  const t = useTranslations('review');
  const [password, setPassword] = useState('');
  const [label, setLabel] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (password.length === 0 || label.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      await reviewApi.login({ password, label });
      onLoggedIn();
    } catch (err) {
      if (err instanceof ReviewApiError && err.code === 'INVALID_REVIEWER_PASSWORD') {
        setError(t('loginBadPassword'));
      } else {
        setError(err instanceof Error ? err.message : t('loginFailed'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card className="mx-auto max-w-md">
      <CardHeader>
        <CardTitle>{t('loginTitle')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={(e) => void submit(e)} className="space-y-4">
          <Field label={t('loginLabel')}>
            <Input
              autoComplete="off"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t('loginLabelPlaceholder')}
              maxLength={80}
            />
          </Field>
          <Field label={t('loginPassword')}>
            <Input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              maxLength={200}
            />
          </Field>
          <Button
            type="submit"
            className="w-full"
            disabled={submitting || password.length === 0 || label.length === 0}
          >
            {submitting ? t('loginSubmitting') : t('login')}
          </Button>
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <p className="text-xs text-muted-foreground">{t('loginHint')}</p>
        </form>
      </CardContent>
    </Card>
  );
}

function ReviewSession({
  session,
  locales,
  onLogout,
}: {
  session: ReviewerSessionDto;
  locales: Locale[];
  onLogout: () => Promise<void>;
}) {
  const t = useTranslations('review');
  const tLocale = useTranslations('review.locales');
  const [locale, setLocale] = useState<Locale | null>(locales[0] ?? null);
  const [kind, setKind] = useState<'recipe' | 'ingredient-name'>('recipe');

  const localeOptions = useMemo(() => locales, [locales]);

  if (!locale) {
    return (
      <Card>
        <CardContent className="pt-6 text-sm text-muted-foreground">
          {t('noLocales')}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
          <div className="flex flex-wrap items-center gap-3">
            <div>
              <p className="text-sm font-medium">{session.label}</p>
              <p className="text-xs text-muted-foreground">
                {t('sessionSince', { date: new Date(session.issuedAt).toLocaleString() })}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-1 rounded-md border bg-muted/30 p-1">
              {localeOptions.map((l) => (
                <button
                  key={l}
                  type="button"
                  onClick={() => setLocale(l)}
                  className={`rounded px-3 py-1 text-xs uppercase tracking-wide ${
                    locale === l
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-muted'
                  }`}
                >
                  {tLocale(l)}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1 rounded-md border bg-muted/30 p-1">
              <button
                type="button"
                onClick={() => setKind('recipe')}
                className={`rounded px-3 py-1 text-xs ${
                  kind === 'recipe'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted'
                }`}
              >
                {t('kindRecipe')}
              </button>
              <button
                type="button"
                onClick={() => setKind('ingredient-name')}
                className={`rounded px-3 py-1 text-xs ${
                  kind === 'ingredient-name'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted'
                }`}
              >
                {t('kindIngredientName')}
              </button>
            </div>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={() => void onLogout()}>
            <LogOut className="mr-1 h-3 w-3" />
            {t('logout')}
          </Button>
        </CardContent>
      </Card>

      <ReviewQueue locale={locale} kind={kind} />
    </div>
  );
}
