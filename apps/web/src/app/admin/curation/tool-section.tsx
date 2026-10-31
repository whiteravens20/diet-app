// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useId, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';

/** A tool of the queue and its form, closed until it is wanted or at work: the drafts are what the page is for. */
export function ToolSection({
  title,
  working = false,
  children,
}: {
  title: string;
  working?: boolean;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="rounded-md border border-border">
      <details className="group" open={working || undefined}>
        <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 px-3 py-2 [&::-webkit-details-marker]:hidden">
          <ChevronRight
            aria-hidden
            className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
          />
          <h4 id={titleId} className="text-sm font-medium">
            {title}
          </h4>
        </summary>
        <div className="space-y-3 px-3 pb-3">{children}</div>
      </details>
    </section>
  );
}
