// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { draftProblemsOf, limitOf, placeOf, type DraftProblem } from './draft-problems';
import { ApiClientError } from './http';
import { useErrorText } from './use-error-text';

/** One problem the API named in a draft: the field, and the rule it breaks. */
function useProblemLine(): (problem: DraftProblem) => string {
  const t = useTranslations('draftProblems');
  return useCallback(
    (problem) => {
      const place = placeOf(problem.path);
      const where = t(`field.${place.field}`, { locale: place.locale, n: place.n });
      const what = t.has(`rule.${problem.rule}`) ? t(`rule.${problem.rule}`, { max: limitOf(problem.rule, place.field) }) : problem.rule;
      return t('line', { where, what });
    },
    [t],
  );
}

/**
 * Why a draft did not ship, in the reader's language. The API names the
 * reason as `<rule>` or `<rule>: <detail>`; a rule this version has no words
 * for is shown as the API wrote it.
 */
export function useSkipReasonText(): (reason: string) => string {
  const t = useTranslations('admin.curation.shipSkipReasons');
  const problemLine = useProblemLine();
  return useCallback(
    (reason) => {
      const at = reason.indexOf(': ');
      const rule = at === -1 ? reason : reason.slice(0, at);
      if (!t.has(rule)) return reason;
      let detail = at === -1 ? '' : reason.slice(at + 2);
      if (rule === 'invalid-draft') {
        // Each entry is `<path>: <rule>`, as a refused edit names its problems.
        detail = detail
          .split('; ')
          .map((entry) => {
            const cut = entry.lastIndexOf(': ');
            return cut === -1 ? entry : problemLine({ path: entry.slice(0, cut), rule: entry.slice(cut + 2) });
          })
          .join('; ');
      }
      return t(rule, { detail });
    },
    [t, problemLine],
  );
}

/**
 * A failed request about a draft, in the reader's language: every problem the
 * API named when it refused the content, the reason a draft may not ship, else
 * what any failed request says (`useErrorText`).
 *
 * The function is the same from one render to the next while the language
 * stays, so it can be named among the dependencies of a callback.
 */
export function useDraftErrorText(): (err: unknown, fallback: string) => string {
  const t = useTranslations('draftProblems');
  const tErrors = useTranslations('errors');
  const problemLine = useProblemLine();
  const skipReason = useSkipReasonText();
  const errorText = useErrorText();
  return useCallback(
    (err, fallback) => {
      const refusal = err instanceof ApiClientError ? err : null;
      if (refusal?.code === 'DRAFT_INVALID') {
        const problems = draftProblemsOf(refusal.details);
        if (problems.length > 0) return `${t('intro')} ${problems.map(problemLine).join('; ')}`;
      }
      if (refusal?.code === 'DRAFT_NOT_SHIPPABLE' && typeof refusal.details?.reason === 'string') {
        return `${tErrors('DRAFT_NOT_SHIPPABLE')} ${skipReason(refusal.details.reason)}`;
      }
      // An error of the page's own says what it is; a failed request is worded as everywhere.
      return errorText(err, err instanceof Error && !refusal ? err.message : fallback);
    },
    [t, tErrors, problemLine, skipReason, errorText],
  );
}
