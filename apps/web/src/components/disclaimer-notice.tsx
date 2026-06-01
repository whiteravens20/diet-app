import { Info } from 'lucide-react';
import { useTranslations } from 'next-intl';

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
  className,
}: {
  /**
   * i18n key under `disclaimers.*` — for example `'aiPlans'`, `'enginePlans'`,
   * `'aiRecipeDraft'`, `'aiActivated'`. The key resolves to the disclaimer
   * body; the shared report-a-bug line is appended automatically.
   */
  bodyKey: 'aiPlans' | 'enginePlans' | 'aiRecipeDraft' | 'aiActivated';
  className?: string;
}) {
  const t = useTranslations('disclaimers');
  return (
    <aside
      role="note"
      className={
        'flex max-w-2xl items-start gap-3 rounded-md border border-primary/20 bg-primary/5 px-4 py-3 text-sm ' +
        (className ?? '')
      }
    >
      <Info size={16} className="mt-0.5 shrink-0 text-primary" aria-hidden />
      <div className="space-y-1">
        <p className="leading-relaxed">{t(bodyKey)}</p>
        <p className="text-xs text-muted-foreground">
          {t.rich('bugReport', {
            link: (chunks) => (
              <a
                href="https://github.com/whiteravens20/diet-app/issues/new"
                target="_blank"
                rel="noreferrer"
                className="text-primary underline-offset-2 hover:underline"
              >
                {chunks}
              </a>
            ),
          })}
        </p>
      </div>
    </aside>
  );
}
