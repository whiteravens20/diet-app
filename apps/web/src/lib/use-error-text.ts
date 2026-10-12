// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { ApiClientError, waitOf } from './http';

/**
 * A request that failed, in the reader's language. Every screen words a
 * failure through this, whoever asked (an account, the administrator, a
 * reviewer):
 *
 *  - a request that was held up says for how long, when the server said;
 *  - a refusal says what its code stands for, with the fields a refused form
 *    named;
 *  - a code this version has no words for is shown as the API put it, which
 *    is English but says something;
 *  - anything else (no answer that could be read, an error of the page's
 *    own) is `fallback`, or the general sentence.
 *
 * The function is the same from one render to the next while the language
 * stays, so it can be named among the dependencies of a callback.
 */
export function useErrorText(): (err: unknown, fallback?: string) => string {
  const t = useTranslations('errors');
  return useCallback(
    (err, fallback) => {
      if (!(err instanceof ApiClientError)) return fallback ?? t('GENERIC');
      const wait = waitOf(err.status, err.retryAfterSeconds);
      if (wait) return t(wait.unit === 'minutes' ? 'HELD_UP_MINUTES' : 'HELD_UP_SECONDS', { count: wait.count });
      if (err.code === 'VALIDATION_FAILED' && err.issues && err.issues.length > 0) {
        const fields = [...new Set(err.issues.map((issue) => issue.path).filter(Boolean))];
        if (fields.length > 0) return t('VALIDATION_FAILED_FIELDS', { fields: fields.join(', ') });
      }
      if (t.has(err.code)) return t(err.code);
      // `ERROR` is no code of the API's: the answer was not one of its refusals.
      if (err.code !== 'ERROR' && err.message) return err.message;
      return fallback ?? t('GENERIC');
    },
    [t],
  );
}
