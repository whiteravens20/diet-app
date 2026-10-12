// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { MealPlan } from '@diet-app/shared';
import { useAmount } from '@/lib/ingredient-format';
import { useFormat } from '@/lib/use-format';
import { dishOf, lastDayOf, servingsOf, type PlanWords } from './plan-export';

/**
 * A plan as a sheet of paper: its days one under another, each with its
 * meals, what they hold and what goes into them. The sheet is shown to the
 * printer alone (`print-sheet` in the global styles hides the page behind it
 * there, and hides the sheet on a screen), so what is printed is the plan and
 * not the application around it. The browser prints it, or keeps it as a PDF:
 * with the page's own fonts, which have every letter the plan is written in.
 *
 * It asks the browser to print once it is drawn, and tells whoever showed it
 * when the browser is done.
 */
export function PlanPrintSheet({ plan, dietLabel, words, onDone }: { plan: MealPlan; dietLabel: string; words: PlanWords; onDone: () => void }) {
  const t = useTranslations('mealPlans.export');
  const fmt = useFormat();
  const amount = useAmount();

  useEffect(() => {
    window.addEventListener('afterprint', onDone);
    window.print();
    return () => window.removeEventListener('afterprint', onDone);
  }, [onDone]);

  const [, meal, dish, servings, energy, protein, fat, carbs] = words.head;
  return createPortal(
    <div className="print-sheet bg-white p-6 text-sm text-black">
      <h1 className="text-xl font-semibold">{t('sheetTitle', { dates: fmt.dates(plan.startDate, lastDayOf(plan)), diet: dietLabel })}</h1>
      <p className="mt-1 text-xs">
        {t('sheetAverage', { kcal: plan.averageDailyNutrition.calories, protein: plan.averageDailyNutrition.protein, fat: plan.averageDailyNutrition.fat, carbs: plan.averageDailyNutrition.carbs })}
      </p>
      {plan.days.map((day) => (
        <section key={day.id} className="mt-5 break-inside-avoid">
          <h2 className="flex items-baseline justify-between gap-4 border-b border-black pb-1 text-base font-semibold">
            <span>{fmt.day(day.date)}</span>
            <span className="text-xs font-normal">{day.skipped ? words.skipped : t('sheetDay', { kcal: day.dayNutrition.calories, target: day.calorieTarget })}</span>
          </h2>
          {!day.skipped && (
            // The columns are as wide on every day, and no wider than the paper: a long word is broken, not printed past the edge.
            <table className="mt-1 w-full table-fixed border-collapse break-words text-left text-xs">
              <thead>
                <tr>
                  <th scope="col" className="w-[14%] py-1 pr-2 font-semibold">{meal}</th>
                  <th scope="col" className="py-1 pr-2 font-semibold">{dish}</th>
                  <th scope="col" className="w-[10%] py-1 pr-2 text-right font-semibold">{servings}</th>
                  <th scope="col" className="w-[8%] py-1 pr-2 text-right font-semibold">{energy}</th>
                  <th scope="col" className="w-[10%] py-1 pr-2 text-right font-semibold">{protein}</th>
                  <th scope="col" className="w-[9%] py-1 pr-2 text-right font-semibold">{fat}</th>
                  <th scope="col" className="w-[14%] py-1 text-right font-semibold">{carbs}</th>
                </tr>
              </thead>
              <tbody>
                {day.meals.map((planned) => (
                  <tr key={planned.id} className="border-t border-neutral-300 align-top">
                    <td className="py-1 pr-2">{words.meal(planned.mealType)}</td>
                    <td className="py-1 pr-2">
                      <span className="font-medium">{dishOf(planned, words)}</span>
                      {planned.ingredients.length > 0 && (
                        <span className="block text-[10px] leading-snug">{fmt.list(planned.ingredients.map((line) => `${line.name} ${amount(line.display.quantity, line.display.unit)}`))}</span>
                      )}
                    </td>
                    <td className="py-1 pr-2 text-right tabular-nums">{fmt.number(servingsOf(planned), 2)}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{fmt.number(planned.nutrition.calories)}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{fmt.number(planned.nutrition.protein)}</td>
                    <td className="py-1 pr-2 text-right tabular-nums">{fmt.number(planned.nutrition.fat)}</td>
                    <td className="py-1 text-right tabular-nums">{fmt.number(planned.nutrition.carbs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ))}
    </div>,
    document.body,
  );
}
