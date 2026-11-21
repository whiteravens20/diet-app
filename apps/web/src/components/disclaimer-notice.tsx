// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Info } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { SOURCE_URL } from '@/lib/project-links';

type BodyKey = 'aiPlans' | 'enginePlans' | 'aiRecipeDraft' | 'aiActivated';

/** What a disclaimer says beyond its caution, where it says more: under "How it works", as the plans page folds its note. */
const MORE: Partial<Record<BodyKey, 'enginePlansMore'>> = { enginePlans: 'enginePlansMore' };

/**
 * Soft, neutral disclaimer box reused across surfaces that touch AI or
 * algorithmic decisions affecting the user's diet. Two variants live on the
 * meal-plans dashboard; a third on the AI recipe-draft modal; a fourth in
 * Settings when the user activates AI. All four read from the
 * `disclaimers.*` namespace so the wording can be tuned in one place and the
 * "open an issue" link rendering is shared.
 */
export function DisclaimerNotice({
  bodyKey,
  folded = false,
  className,
}: {
  /**
   * i18n key under `disclaimers.*` — for example `'aiPlans'`, `'enginePlans'`,
   * `'aiRecipeDraft'`, `'aiActivated'`. The key resolves to the disclaimer
   * body; the shared report-a-bug line is appended automatically.
   */
  bodyKey: BodyKey;
  /**
   * The caution alone stands open, and what more the body says, with the report-a-bug line, is under "How it works";
   * a body that says no more stands whole.
   */
  folded?: boolean;
  className?: string;
}) {
  const t = useTranslations('disclaimers');
  const tCommon = useTranslations('common');
  const more = MORE[bodyKey];
  const bugReport = (
    <p className="text-xs text-muted-foreground">
      {t.rich('bugReport', {
        link: (chunks) => (
          <a
            href={`${SOURCE_URL}/issues/new`}
            target="_blank"
            rel="noreferrer"
            className="text-primary underline underline-offset-2"
          >
            {chunks}
          </a>
        ),
      })}
    </p>
  );
  return (
    <aside
      role="note"
      className={
        'flex items-start gap-3 rounded-md border border-primary/20 bg-primary/5 px-4 py-3 text-sm ' +
        (className ?? '')
      }
    >
      <Info size={16} className="mt-0.5 shrink-0 text-primary" aria-hidden />
      <div className="space-y-1">
        <p className="leading-relaxed">{t(bodyKey)}</p>
        {folded && more ? (
          <details className="text-xs text-muted-foreground">
            <summary className="w-fit cursor-pointer py-1">{tCommon('howItWorks')}</summary>
            <div className="mt-1 space-y-1">
              <p className="leading-relaxed">{t(more)}</p>
              {bugReport}
            </div>
          </details>
        ) : (
          bugReport
        )}
      </div>
    </aside>
  );
}
