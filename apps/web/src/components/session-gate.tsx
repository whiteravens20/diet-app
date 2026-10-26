// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { OfflineNotice, ReplayedNotice } from '@/components/offline-notice';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { offline, type Replayed } from '@/lib/offline';
import { session } from '@/lib/session';

type Standing = 'ready' | 'waiting' | 'unreachable';

const standing = (): Standing =>
  session.accessToken !== null ? 'ready' : session.unreachable ? 'unreachable' : 'waiting';

/**
 * Lets the pages of a signed-in account render once the page holds an access
 * token, and not before: a page that was just loaded has none, and gets one
 * with one request. Until then nothing asks the API for anything, so no page
 * shows what an unanswered request leaves behind.
 *
 * A browser without a session is sent to sign in. A session that could not
 * be reached for another reason (the server is busy or away) is no reason to
 * sign anybody out: the reader is told, and can try again.
 *
 * Where the browser kept what the account read last (`lib/offline.ts`), the
 * pages are shown from that while the server cannot be reached, under a line
 * that says so. When it is back, the ticks that waited are sent, and every
 * page reads what it shows anew.
 */
export function SessionGate({ children }: { children: ReactNode }) {
  const t = useTranslations('auth');
  const tCommon = useTranslations('common');
  // The server knows of no token, and the first render in the browser agrees with it.
  const now = useSyncExternalStore(session.subscribe, standing, (): Standing => 'waiting');
  const [trying, setTrying] = useState(false);
  const queryClient = useQueryClient();
  // Whether the browser keeps answers for this account, whether the pages are being shown from them, and how many ticks wait.
  const kept = useSyncExternalStore(
    offline.subscribe,
    () => offline.account !== null,
    () => false,
  );
  const fromKept = useSyncExternalStore(
    offline.subscribe,
    () => offline.serving,
    () => false,
  );
  const waiting = useSyncExternalStore(
    offline.subscribe,
    () => offline.waiting.length,
    () => 0,
  );
  const [replayed, setReplayed] = useState<Replayed | null>(null);
  // The server is out of reach: for the session, or for what the pages asked last.
  const cut = now === 'unreachable' || fromKept;
  const wasCut = useRef(false);

  // The browser says it has a network again: the session is asked for, and the pages read anew.
  useEffect(() => {
    if (!cut) return;
    const back = (): void => {
      if (session.accessToken === null) void session.refresh();
      void queryClient.invalidateQueries();
    };
    window.addEventListener('online', back);
    return () => window.removeEventListener('online', back);
  }, [cut, queryClient]);

  // In reach, after having been out of it or with ticks left from another visit: what waited is sent, then everything is read anew.
  useEffect(() => {
    if (cut) {
      wasCut.current = true;
      return;
    }
    if (now !== 'ready') return;
    const back = wasCut.current;
    wasCut.current = false;
    if (!back && offline.waiting.length === 0) return;
    void offline
      .replay((tick) =>
        api.patch(`/shopping-lists/${tick.listId}/items/${tick.itemId}`, { checked: tick.checked }),
      )
      .then((result) => {
        if (result.sent + result.refused > 0) setReplayed(result);
        return queryClient.invalidateQueries();
      });
  }, [cut, now, queryClient]);

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

  const again = (): void => {
    setTrying(true);
    void (
      session.accessToken === null ? session.refresh() : queryClient.invalidateQueries()
    ).finally(() => setTrying(false));
  };
  // The pages, with what there is to say over them. They keep their place whatever is said, so that nothing they hold is lost when a line comes or goes.
  if (now === 'ready' || (now === 'unreachable' && kept)) {
    return (
      <>
        {cut && <OfflineNotice waiting={waiting} trying={trying} onRetry={again} />}
        {!cut && replayed && <ReplayedNotice result={replayed} onClose={() => setReplayed(null)} />}
        {children}
      </>
    );
  }
  if (now === 'unreachable') {
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
