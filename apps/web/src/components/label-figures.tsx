// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.
'use client';

import type { LabelFigure, LabelLimitNote, LabelNutrient, LabelTotals } from '@diet-app/shared';
import { useTranslations } from 'next-intl';
import { Fragment } from 'react';
import { cn } from '@/lib/utils';
import { useFormat } from '@/lib/use-format';
import { DOT } from '@/lib/figure-line';

/** The four, in the order they are shown. */
const NUTRIENTS: readonly LabelNutrient[] = ['fiber', 'sugars', 'salt', 'saturatedFat'];

/**
 * A figure as a person reads it: "6 g", "≥ 13.1 g" for a sum a part of which gives no figure,
 * "—" where nothing of it does. The API worked it out and rounded it; nothing here does.
 */
function useFigure(): (figure: LabelFigure | null) => string {
  const fmt = useFormat();
  return (figure) =>
    figure === null ? '—' : `${figure.atLeast ? '≥ ' : ''}${fmt.unit(figure.grams, 'gram', 1)}`;
}

/** Fibre, sugars, salt and saturated fat of a serving: a value above its name, as the macronutrients are shown. */
export function LabelGrid({ totals }: { totals: LabelTotals }) {
  const t = useTranslations('labelFigures');
  const figure = useFigure();
  return (
    <>
      <div className="mt-4 grid grid-cols-2 gap-4 text-center sm:grid-cols-4">
        {NUTRIENTS.map((nutrient) => (
          <div key={nutrient}>
            <p className="font-semibold tabular-nums">{figure(totals[nutrient])}</p>
            <p className="text-xs text-muted-foreground">{t(nutrient)}</p>
          </div>
        ))}
      </div>
      <LabelLegend totals={totals} />
    </>
  );
}

/**
 * The same in one line, for a day or a meal: "Fibre 12 g · Sugars ≥ 26.2 g · …". A name keeps
 * its figure on its line; the line breaks at the dots between them, which stand outside, as
 * WebKit breaks at no space a `nowrap` holds.
 */
export function LabelLine({ totals, className }: { totals: LabelTotals; className?: string }) {
  const t = useTranslations('labelFigures');
  const figure = useFigure();
  return (
    <p className={cn('text-xs text-muted-foreground', className)}>
      {NUTRIENTS.map((nutrient, index) => (
        <Fragment key={nutrient}>
          {index > 0 && DOT}
          <span className="whitespace-nowrap">
            {t(nutrient)} <span className="tabular-nums">{figure(totals[nutrient])}</span>
          </span>
        </Fragment>
      ))}
    </p>
  );
}

/** What "≥" and "—" stand for, said once under the figures that use them. */
export function LabelLegend({ totals, className }: { totals: LabelTotals; className?: string }) {
  const t = useTranslations('labelFigures');
  const figures = NUTRIENTS.map((nutrient) => totals[nutrient]);
  const atLeast = figures.some((figure) => figure?.atLeast);
  const unknown = figures.some((figure) => figure === null);
  if (!atLeast && !unknown) return null;
  return (
    <p className={cn('mt-2 text-xs text-muted-foreground', className)}>
      {[atLeast && t('legendAtLeast'), unknown && t('legendUnknown')].filter(Boolean).join(' ')}
    </p>
  );
}

/** The limits of the profile that a day crosses, a line each. */
export function LabelNotes({ notes, className }: { notes: LabelLimitNote[]; className?: string }) {
  const t = useTranslations('labelFigures');
  const fmt = useFormat();
  const figure = useFigure();
  if (notes.length === 0) return null;
  return (
    <ul className={cn('space-y-0.5 text-xs text-warning', className)}>
      {notes.map((note) => (
        <li key={note.nutrient}>
          {t(note.kind === 'atMost' ? 'noteAtMost' : 'noteAtLeast', {
            name: t(note.nutrient),
            value: figure(note.figure),
            limit: fmt.unit(note.limit, 'gram', 1),
          })}
        </li>
      ))}
    </ul>
  );
}
