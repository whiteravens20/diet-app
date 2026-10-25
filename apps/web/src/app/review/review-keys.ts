// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useEffect, useRef, useSyncExternalStore, type KeyboardEvent, type RefObject } from 'react';

/** Where a reviewer's browser keeps that the keys are on. */
const WANTED = 'diet-app.review.keys';

// What was chosen on this page, in a browser that keeps nothing for it.
let unkept: boolean | null = null;
const listeners = new Set<() => void>();

function kept(): boolean {
  try {
    return localStorage.getItem(WANTED) === 'on';
  } catch {
    return false;
  }
}

function watch(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

/**
 * Whether the reviewer turned the keys on, and the way to turn them on and
 * off. They are off until asked for: a reviewer cannot take a decision back,
 * and with the keys on a letter typed while the draft has the focus is one.
 * The choice stays in the browser it was made in.
 */
export function useReviewKeysWanted(): [boolean, (wanted: boolean) => void] {
  const wanted = useSyncExternalStore(
    watch,
    () => unkept ?? kept(),
    () => false,
  );
  const choose = (next: boolean): void => {
    try {
      if (next) localStorage.setItem(WANTED, 'on');
      else localStorage.removeItem(WANTED);
      unkept = null;
    } catch {
      unkept = next;
    }
    listeners.forEach((listener) => listener());
  };
  return [wanted, choose];
}

/** What the keys of a draft under review do. */
export interface ReviewKeys {
  /** Whether the letters do anything: the reviewer turned the keys on. */
  enabled: boolean;
  /** Whether the draft takes the focus as it comes up. */
  takesFocus: boolean;
  approve: () => void;
  reject: () => void;
  /** Left out while nothing was typed that could be saved. */
  save?: () => void;
  /** Left out at the last draft of the page, and at the first. */
  next?: () => void;
  previous?: () => void;
  /** No key does anything while a request is under way. */
  busy: boolean;
}

/**
 * The keys of the draft a reviewer is looking at: A approves, R rejects, S
 * saves, the right arrow or J goes to the next draft and the left arrow or K
 * to the one before.
 *
 * They act only while the draft itself has the focus, never while something
 * is being typed into one of its fields: a letter typed into a title is a
 * letter. Escape in a field gives the focus back to the draft. A key held
 * with Ctrl, Alt or the command key is the browser's.
 *
 * With the keys off the draft can still take the focus as it comes up, so
 * that the focus is not lost with the button that was pressed on the draft
 * before; it is then no stop of the Tab key. A draft that takes the focus is
 * brought to the top of the view: it is read from its title.
 */
export function useReviewKeys(keys: ReviewKeys): {
  ref: RefObject<HTMLDivElement | null>;
  tabIndex: 0 | -1;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
} {
  const ref = useRef<HTMLDivElement>(null);
  // As it was when the draft came up: turning the keys on moves no focus.
  const takesFocus = useRef(keys.takesFocus);
  useEffect(() => {
    if (!takesFocus.current) return;
    ref.current?.focus({ preventScroll: true });
    ref.current?.scrollIntoView({ block: 'start' });
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!keys.enabled) return;
    const onTheDraft = event.target === event.currentTarget;
    if (event.key === 'Escape' && !onTheDraft) {
      event.currentTarget.focus();
      return;
    }
    if (!onTheDraft || event.ctrlKey || event.metaKey || event.altKey || keys.busy) return;
    const act = {
      a: keys.approve,
      r: keys.reject,
      s: keys.save,
      j: keys.next,
      arrowright: keys.next,
      k: keys.previous,
      arrowleft: keys.previous,
    }[event.key.toLowerCase()];
    if (!act) return;
    event.preventDefault();
    act();
  };
  return { ref, tabIndex: keys.enabled ? 0 : -1, onKeyDown };
}
