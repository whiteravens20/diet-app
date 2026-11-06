// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { useTranslations } from 'next-intl';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

/** Text input primitive. It takes what an input takes, a `ref` to it among the rest. */
export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'h-10 w-full rounded-md border border-input bg-background px-3 text-sm',
        'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2',
        'focus-visible:ring-ring transition-shadow',
        className,
      )}
      {...props}
    />
  );
}

/**
 * The word that says a field may stay empty, cut into the top edge of its frame at the right: above
 * the edge it has the surface the field stands on (a card's, through `--field-surface`, or the
 * page's), below it the field's own, so the edge seems to stop at the word. It is the frame's
 * `::after`, so it is read with the field's name and leaves the label's own text as it is.
 */
const OPTIONAL_MARK =
  'after:pointer-events-none after:absolute after:right-2 after:top-0 after:-translate-y-1/2 after:select-none ' +
  'after:bg-[linear-gradient(to_bottom,var(--field-surface,var(--background))_50%,var(--background)_50%)] ' +
  'after:px-1 after:text-2xs after:leading-none after:text-muted-foreground after:content-[attr(data-optional)]';

/** A frame around a field that may stay empty, which says so in its top edge. */
export function OptionalFrame({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  const t = useTranslations('common');
  return (
    <span data-optional={t('optional')} className={cn('relative block', OPTIONAL_MARK, className)}>
      {children}
    </span>
  );
}

/**
 * A labelled field wrapper. Optional `hint` renders as muted helper text below the input, `error` as
 * what is wrong with what it holds; an `optional` field, one that may stay empty, says so in its frame.
 */
export function Field({
  label,
  hint,
  error,
  optional = false,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | undefined;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      {optional ? <OptionalFrame>{children}</OptionalFrame> : children}
      {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      {error && (
        <span role="alert" className="block text-xs text-destructive">
          {error}
        </span>
      )}
    </label>
  );
}
