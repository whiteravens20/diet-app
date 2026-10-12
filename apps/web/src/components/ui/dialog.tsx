// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * A window over the page that has to be answered or closed before the page
 * is used again. It is the browser's own `<dialog>`, opened as a modal one,
 * so the browser does what such a window owes its user: the focus moves into
 * it and stays in it, the page behind takes no key and no click, Esc closes
 * it, and the focus goes back to what opened it. A click beside the window
 * closes it too, and the page behind does not scroll while it is open.
 *
 * What is inside is rendered only while the window is open.
 */
export function Dialog({
  open,
  onClose,
  label,
  className,
  children,
}: {
  open: boolean;
  /** Told when the window is to close: by Esc, by a click beside it, or by whatever inside calls for it. */
  onClose: () => void;
  /** What the window is, for somebody who does not see it. */
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  // Closed here, before the element leaves the page, so that the browser can
  // put the focus back where it was: an element that is merely removed takes
  // the focus with it.
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog || !open) return;
    dialog.showModal();
    return () => dialog.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    const before = root.style.overflow;
    root.style.overflow = 'hidden';
    return () => {
      root.style.overflow = before;
    };
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-label={label}
      // The browser closes the window on Esc by itself; this tells whoever opened it.
      onClose={onClose}
      // The window fills its own box, so a click that lands on the element itself landed beside it, on the backdrop.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className={cn(
        'dialog m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-2xl overflow-y-auto rounded-lg border border-border bg-background p-0 text-foreground shadow-xl',
        'backdrop:bg-black/40',
        className,
      )}
    >
      {open && children}
    </dialog>
  );
}
