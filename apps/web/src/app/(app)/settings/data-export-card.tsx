// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useMutation } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { api } from '@/lib/api';
import { localDate } from '@/lib/http';
import { saveFile } from '@/lib/save-file';
import { useErrorText } from '@/lib/use-error-text';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/** How the file ends when all of it arrived: the API writes this last. */
const WHOLE = '"complete":true}';

/**
 * Everything the account holds, as one file to keep: its profiles and what
 * was logged, kept, marked, planned and listed for them. The API writes the
 * file piece by piece, and one that was cut short on its way is not handed
 * on as if it were whole.
 */
export function DataExportCard() {
  const t = useTranslations('settings');
  const errorText = useErrorText();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const download = useMutation({
    mutationFn: async () => {
      const file = await api.download('/users/me/export');
      const end = await file.slice(-WHOLE.length).text();
      if (end !== WHOLE) throw new Error('The file is not whole.');
      return file;
    },
    onMutate: () => {
      setError(null);
      setSaved(false);
    },
    onSuccess: (file) => {
      saveFile(file, `diet-app-account-${localDate()}.json`);
      setSaved(true);
    },
    onError: (err) => setError(errorText(err, t('dataExportFailed'))),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('dataExport')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{t('dataExportBody')}</p>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" onClick={() => download.mutate()} disabled={download.isPending}>
            {download.isPending ? t('dataExportPreparing') : t('dataExportButton')}
          </Button>
          {/* Read out as well as shown: a file that went to the downloads folder cannot be seen on the page. */}
          <p role="status" className="text-sm text-muted-foreground">
            {saved ? t('dataExportSaved') : ''}
          </p>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
