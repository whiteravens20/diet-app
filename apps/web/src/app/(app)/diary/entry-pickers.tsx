// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import { useId } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { useFormat } from '@/lib/use-format';
import { FoundList } from './found-list';

/*
 * What the diary's window and the plan's window for a meal of one's own pick a recipe or an ingredient with: a
 * search, what it found, and what was picked with a way back to the search.
 */

/** What was picked, and a way back to the search. */
export function Picked({
  name,
  about,
  onAgain,
}: {
  name: string;
  about: string;
  onAgain: () => void;
}) {
  const t = useTranslations('diary');
  const fmt = useFormat();
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
      <div className="min-w-0">
        <p className="break-words text-sm font-medium">{fmt.text(name)}</p>
        <p className="text-xs text-muted-foreground">{about}</p>
      </div>
      <Button type="button" variant="ghost" size="sm" onClick={onAgain}>
        {t('changePick')}
      </Button>
    </div>
  );
}

/** A search of what the window offers, and what it found as buttons to pick. */
export function Search({
  label,
  value,
  onChange,
  searching,
  loading,
  failed,
  found,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  searching: boolean;
  loading: boolean;
  /** The search did not get an answer: that says nothing of what there is. */
  failed: boolean;
  found: { id: string; name: string; about: string; pick: () => void }[];
}) {
  const t = useTranslations('diary');
  const id = useId();
  return (
    <div className="space-y-2">
      <Field label={label} hint={t('searchHint')}>
        <Input
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-controls={`${id}-found`}
          maxLength={200}
        />
      </Field>
      <div id={`${id}-found`} aria-live="polite">
        {searching && !loading && failed && (
          <p role="alert" className="text-sm text-destructive">
            {t('searchFailed')}
          </p>
        )}
        {searching && !loading && !failed && found.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('noResults')}</p>
        )}
        {found.length > 0 && <FoundList found={found} />}
      </div>
    </div>
  );
}
