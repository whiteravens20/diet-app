// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { LoaderCircle, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { adminApi } from '@/lib/admin-api';
import { useDraftErrorText } from '@/lib/use-draft-error';

/**
 * "Usuń szkice bez składnika w katalogu": every draft of a name, of any decision but shipped, whose ingredient this
 * instance's catalogue does not have, removed at once once the administrator has read how many go and that it cannot
 * be undone. With [count] where it is known (the queue's figures); the ship's result asks the server when pressed.
 */
export function RemoveWithoutIngredient({
  count,
  onRemoved,
}: {
  count: number | null;
  /** The drafts went: whoever shows them reads them again. */
  onRemoved: () => void | Promise<void>;
}) {
  const t = useTranslations('admin.curation');
  const errorText = useDraftErrorText();
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const remove = async (): Promise<void> => {
    setBusy(true);
    setSaid(null);
    setError(null);
    try {
      const shown = count ?? (await adminApi.overview()).names.withoutIngredient;
      if (shown === 0) setSaid(t('removeMissingNone'));
      else if (window.confirm(t('removeMissingConfirm', { count: shown }))) {
        const { removed } = await adminApi.removeNamesWithoutIngredient();
        setSaid(t('removeMissingDone', { count: removed }));
        await onRemoved();
      }
    } catch (err) {
      setError(errorText(err, String(err)));
    }
    setBusy(false);
  };

  return (
    // In the colours of the page, also under the warning of what a ship held back.
    <div className="space-y-1 text-xs text-foreground">
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => void remove()}
        className="gap-2"
      >
        {busy ? (
          <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <X className="h-3.5 w-3.5" />
        )}
        {count === null ? t('removeMissing') : t('removeMissingCount', { count })}
      </Button>
      {said && (
        <p role="status" className="text-muted-foreground">
          {said}
        </p>
      )}
      {error && <p className="text-destructive">{error}</p>}
    </div>
  );
}
