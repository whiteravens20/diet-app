// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useFormat } from '@/lib/use-format';

/** How long a removal can be taken back before it is sent. */
export const UNDO_FOR_MS = 6000;

/**
 * A removal of something cheap to make again (an entry of the diary, a row of the pantry, a recipe's mark): it is
 * gone from the page at once, and sent only once the moments to take it back are over. Nothing is asked first; a
 * removal taken back was never sent. A second removal sends the first at once, and so does leaving the page, or
 * the browser's tab being closed.
 */
export function useRemovedLater<T>(send: (item: T) => void) {
  const [waiting, setWaiting] = useState<T | null>(null);
  const held = useRef<T | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sending = useRef(send);
  useEffect(() => {
    sending.current = send;
  }, [send]);

  const settle = useCallback(() => {
    clearTimeout(timer.current);
    const item = held.current;
    held.current = null;
    setWaiting(null);
    if (item) sending.current(item);
  }, []);

  const remove = useCallback(
    (item: T) => {
      settle();
      held.current = item;
      setWaiting(item);
      timer.current = setTimeout(settle, UNDO_FOR_MS);
    },
    [settle],
  );

  const undo = useCallback(() => {
    clearTimeout(timer.current);
    held.current = null;
    setWaiting(null);
  }, []);

  // Leaving the page, or closing it, does not take a removal back.
  useEffect(() => {
    window.addEventListener('pagehide', settle);
    return () => {
      window.removeEventListener('pagehide', settle);
      settle();
    };
  }, [settle]);

  return { waiting, remove, undo };
}

/** What was removed, and the way to take it back while it waits to be sent. */
export function RemovedBar({ name, onUndo }: { name: string; onUndo: () => void }) {
  const t = useTranslations('common');
  const fmt = useFormat();
  return (
    // Over the bar of an address not confirmed, where one stands at the bottom of the screen.
    <div
      role="status"
      className="fixed bottom-[calc(1rem+var(--bottom-bar,0px))] right-4 z-50 flex max-w-sm items-center gap-3 rounded-lg border border-border bg-background p-3 shadow-lg print:hidden"
    >
      <p className="min-w-0 flex-1 text-sm">{t('removed', { name: fmt.text(name) })}</p>
      <Button type="button" size="sm" variant="outline" onClick={onUndo}>
        {t('undo')}
      </Button>
    </div>
  );
}
