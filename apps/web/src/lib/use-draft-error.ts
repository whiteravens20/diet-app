// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import { AdminApiError } from './admin-api';
import { draftProblemsOf, limitOf, placeOf } from './draft-problems';
import { ReviewApiError } from './review-api';

/**
 * A failed request about a draft, in the reader's language: every problem the
 * API named when it refused the content, else the text of the refusal's code,
 * else what the API said.
 */
export function useDraftErrorText(): (err: unknown, fallback: string) => string {
  const t = useTranslations('draftProblems');
  const tErrors = useTranslations('errors');
  return (err, fallback) => {
    const refusal = err instanceof AdminApiError || err instanceof ReviewApiError ? err : null;
    if (refusal?.code === 'DRAFT_INVALID') {
      const problems = draftProblemsOf(refusal.details);
      if (problems.length > 0) {
        const lines = problems.map((problem) => {
          const place = placeOf(problem.path);
          const where = t(`field.${place.field}`, { locale: place.locale, n: place.n });
          const what = t.has(`rule.${problem.rule}`) ? t(`rule.${problem.rule}`, { max: limitOf(problem.rule, place.field) }) : problem.rule;
          return t('line', { where, what });
        });
        return `${t('intro')} ${lines.join('; ')}`;
      }
    }
    if (refusal?.code && tErrors.has(refusal.code)) return tErrors(refusal.code);
    return err instanceof Error ? err.message : fallback;
  };
}
