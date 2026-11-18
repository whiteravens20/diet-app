// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useErrorText } from '@/lib/use-error-text';

/**
 * What a page shows in the place of its content when the content could not be
 * loaded: why, and a way to try again. A page that showed its empty state
 * here would tell somebody that they have nothing, when it only knows that it
 * could not ask.
 */
export function LoadFailed({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const t = useTranslations('common');
  const errorText = useErrorText();
  return (
    <Card className="mx-auto mt-16 max-w-xl">
      <CardContent className="flex flex-col items-center gap-4 py-10 text-center">
        <p role="alert" className="text-sm">
          {errorText(error, t('error'))}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          {t('retry')}
        </Button>
      </CardContent>
    </Card>
  );
}

/** As much of a read as this file asks of it. */
export interface Read {
  isError: boolean;
  error: unknown;
  data: unknown;
  isPlaceholderData: boolean;
  refetch: () => unknown;
}

/** Whether a read still holds an answer of its own, whatever its last try came to. */
export const kept = (read: Pick<Read, 'data' | 'isPlaceholderData'>): boolean =>
  read.data !== undefined && !read.isPlaceholderData;

/** A read that failed with nothing to show for it: its place has only the failure to say. */
export const unread = (read: Pick<Read, 'isError' | 'data' | 'isPlaceholderData'>): boolean =>
  read.isError && !kept(read);

/**
 * Why reads failed, with one way to try them all again. A read that failed
 * again while its earlier answer stands is said here, and the place keeps
 * what it shows, since a list open in a shop is worth more than a notice that
 * the network dropped. A read that never answered is left to the place that
 * shows it (`LoadFailed`), unless that place is this note (`unanswered`): a
 * card or a search whose empty state would otherwise say there is nothing,
 * when it only knows that it could not ask. Nothing when no read failed so.
 */
export function ReadsFailed({
  reads,
  unanswered = false,
}: {
  reads: Read[];
  unanswered?: boolean;
}) {
  const t = useTranslations('common');
  const errorText = useErrorText();
  const failed = reads.filter((read) => read.isError && (unanswered || kept(read)));
  if (failed.length === 0) return null;
  const old = failed.some(kept);
  return (
    <p
      role="alert"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground"
    >
      <span>
        {errorText(failed[0]!.error, t('error'))}
        {old && ` ${t('shownFromBefore')}`}
      </span>
      <button
        type="button"
        className="font-medium text-foreground underline underline-offset-2"
        onClick={() => {
          for (const read of failed) void read.refetch();
        }}
      >
        {t('retry')}
      </button>
    </p>
  );
}
