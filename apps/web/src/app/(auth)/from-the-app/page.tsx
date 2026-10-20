// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import type { AuthResponse, BrowserCodeAccount } from '@diet-app/shared';
import { apiClient } from '@/lib/http';
import { returnPath, signInPath } from '@/lib/return-path';
import { session } from '@/lib/session';
import { useErrorText } from '@/lib/use-error-text';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/** Asks with the cookies of the browser and no access token: the session the browser has, if any, is not what signs it in. */
const plain = apiClient('');

type Stage =
  | { kind: 'reading' }
  | { kind: 'asking'; code: string; next: string; account: BrowserCodeAccount }
  | { kind: 'signing-in' }
  | { kind: 'failed'; why: string; next: string }
  | { kind: 'missing'; next: string };

/**
 * Where an application opens the web application signed in. The address's
 * fragment holds a code, good for a minute and once, and the page to go on
 * to. The code leaves the address and the history at once; the page shows
 * whose account the code is for and signs the browser in only when its
 * reader says so, so that a link with somebody else's code signs nobody in
 * to the sender's account unawares.
 */
export default function FromTheAppPage() {
  const t = useTranslations('fromTheApp');
  const errorText = useErrorText();
  const [stage, setStage] = useState<Stage>({ kind: 'reading' });
  // The code is good once: the effect runs twice in development, the request once.
  const read = useRef(false);

  useEffect(() => {
    if (read.current) return;
    read.current = true;
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const code = fragment.get('code');
    const next = returnPath(fragment.get('next'));
    window.history.replaceState(null, '', window.location.pathname);
    if (!code) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the fragment is the browser's alone, read once after mount: what it holds decides the first stage
      setStage({ kind: 'missing', next });
      return;
    }
    plain
      .post<BrowserCodeAccount>('/auth/browser-sign-in/account', { code })
      .then((account) => setStage({ kind: 'asking', code, next, account }))
      .catch((e: unknown) => setStage({ kind: 'failed', why: errorText(e, t('failed')), next }));
  }, [errorText, t]);

  async function signIn(code: string, next: string) {
    setStage({ kind: 'signing-in' });
    try {
      await plain.post<AuthResponse>('/auth/browser-sign-in', { code });
      session.replaced(next);
    } catch (e) {
      setStage({ kind: 'failed', why: errorText(e, t('failed')), next });
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-xl">{t('title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {(stage.kind === 'reading' || stage.kind === 'signing-in') && (
          <p role="status" className="text-muted-foreground">
            {stage.kind === 'reading' ? t('reading') : t('signingIn')}
          </p>
        )}
        {stage.kind === 'asking' && (
          <>
            <p>{t.rich('question', { email: stage.account.email, b: (chunks) => <strong className="break-all">{chunks}</strong> })}</p>
            <p className="text-muted-foreground">{stage.account.displayName}</p>
            <p className="text-muted-foreground">{t('onlyYours')}</p>
            <p className="text-muted-foreground">{t('replaces')}</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={() => void signIn(stage.code, stage.next)}>
                {t('signIn')}
              </Button>
              <Button type="button" variant="outline" onClick={() => session.load('/')}>
                {t('cancel')}
              </Button>
            </div>
          </>
        )}
        {(stage.kind === 'failed' || stage.kind === 'missing') && (
          <>
            <p role="alert">{stage.kind === 'failed' ? stage.why : t('missing')}</p>
            <p className="text-center">
              <Link href={signInPath(stage.next)} className="text-primary underline underline-offset-2">
                {t('signInHere')}
              </Link>
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
