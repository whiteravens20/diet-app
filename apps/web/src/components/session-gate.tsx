// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { session } from '@/lib/session';

type Standing = 'ready' | 'waiting' | 'unreachable';

const standing = (): Standing => (session.accessToken !== null ? 'ready' : session.unreachable ? 'unreachable' : 'waiting');

/**
 * Lets the pages of a signed-in account render once the page holds an access
 * token, and not before: a page that was just loaded has none, and gets one
 * with one request. Until then nothing asks the API for anything, so no page
 * shows what an unanswered request leaves behind.
 *
 * A browser without a session is sent to sign in. A session that could not
 * be reached for another reason (the server is busy or away) is no reason to
 * sign anybody out: the reader is told, and can try again.
 */
export function SessionGate({ children }: { children: ReactNode }) {
  const t = useTranslations('auth');
  const tCommon = useTranslations('common');
  // The server knows of no token, and the first render in the browser agrees with it.
  const now = useSyncExternalStore(session.subscribe, standing, (): Standing => 'waiting');
  const [trying, setTrying] = useState(false);

  useEffect(() => {
    if (session.accessToken === null) {
      if (session.exists()) void session.refresh();
      else session.leave();
    }
    // A page the browser kept in memory and shows again (the Back button) is
    // as it was left, by whoever was signed in then. It is loaded anew.
    const shownAgain = (event: PageTransitionEvent): void => {
      if (event.persisted) window.location.reload();
    };
    window.addEventListener('pageshow', shownAgain);
    return () => window.removeEventListener('pageshow', shownAgain);
  }, []);

  if (now === 'ready') return children;
  if (now === 'unreachable') {
    const again = (): void => {
      setTrying(true);
      void session.refresh().finally(() => setTrying(false));
    };
    return (
      <Card className="mx-auto mt-16 max-w-xl">
        <CardContent className="flex flex-col items-center gap-4 py-10 text-center">
          <p role="alert" className="text-sm">
            {t('sessionUnreachable')}
          </p>
          <Button type="button" variant="outline" size="sm" disabled={trying} onClick={again}>
            {tCommon('retry')}
          </Button>
        </CardContent>
      </Card>
    );
  }
  return <Skeleton className="h-40 max-w-2xl" />;
}
