// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface TabItem<Id extends string> {
  id: Id;
  title: string;
  /** What the tab carries beside its title, and how that is said to those who do not see it. */
  mark?: { shown: string; said: string };
  content: () => ReactNode;
}

/**
 * The parts of a long page, one at a time. A part is rendered when it is first
 * opened and stays rendered after that, hidden, so that what was typed or
 * filtered in it, and a job it follows, are there when somebody comes back to
 * it. The arrow keys move along the tabs, and on a narrow screen the row scrolls
 * sideways.
 */
export function Tabs<Id extends string>({
  label,
  tabs,
  active,
  onSelect,
}: {
  label: string;
  tabs: TabItem<Id>[];
  active: Id;
  onSelect: (id: Id) => void;
}) {
  const base = useId();
  const buttons = useRef(new Map<Id, HTMLButtonElement>());
  const [opened, setOpened] = useState<ReadonlySet<Id>>(() => new Set([active]));
  if (!opened.has(active)) setOpened(new Set([...opened, active]));

  // The row alone moves to show the chosen tab: the page stays where it is, wherever on it the tabs stand.
  useEffect(() => {
    const button = buttons.current.get(active);
    if (!button) return;
    const row = button.parentElement!;
    const left = button.offsetLeft - row.offsetLeft;
    const right = left + button.offsetWidth;
    if (left < row.scrollLeft) row.scrollLeft = left;
    else if (right > row.scrollLeft + row.clientWidth) row.scrollLeft = right - row.clientWidth;
  }, [active]);

  const onKeyDown = (event: KeyboardEvent, index: number): void => {
    const last = tabs.length - 1;
    const keys: Record<string, number> = {
      ArrowRight: index === last ? 0 : index + 1,
      ArrowLeft: index === 0 ? last : index - 1,
      Home: 0,
      End: last,
    };
    const next = keys[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const tab = tabs[next]!;
    onSelect(tab.id);
    buttons.current.get(tab.id)?.focus();
  };

  return (
    <div className="space-y-6">
      <div
        role="tablist"
        aria-label={label}
        className={cn(
          'flex overflow-x-auto shadow-[inset_0_-1px_0_var(--color-border)]',
          // On a narrow screen the end of the row fades, which says that it goes on.
          'pr-6 [mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent)]',
          'sm:pr-0 sm:[mask-image:none]',
        )}
      >
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            ref={(button) => {
              if (button) buttons.current.set(tab.id, button);
              else buttons.current.delete(tab.id);
            }}
            type="button"
            role="tab"
            id={`${base}-tab-${tab.id}`}
            aria-selected={tab.id === active}
            aria-controls={`${base}-panel-${tab.id}`}
            tabIndex={tab.id === active ? 0 : -1}
            onClick={() => onSelect(tab.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              'inline-flex h-11 shrink-0 items-center gap-2 border-b-2 px-3 text-sm font-medium',
              'whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2',
              'focus-visible:ring-inset focus-visible:ring-ring',
              tab.id === active
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.title}
            {tab.mark && (
              <>
                <span
                  aria-hidden
                  className="rounded-full bg-muted px-1.5 text-xs tabular-nums text-foreground"
                >
                  {tab.mark.shown}
                </span>
                <span className="sr-only">{`, ${tab.mark.said}`}</span>
              </>
            )}
          </button>
        ))}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`${base}-panel-${tab.id}`}
          aria-labelledby={`${base}-tab-${tab.id}`}
          hidden={tab.id !== active}
          className="space-y-6"
        >
          {opened.has(tab.id) && tab.content()}
        </div>
      ))}
    </div>
  );
}
