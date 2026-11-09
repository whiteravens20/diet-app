// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { Field, Input } from '@/components/ui/input';
import { foodWeight, sharesOf, splitWhole } from '@/lib/split';
import { useFormat } from '@/lib/use-format';

/** A portion a dish is split into: what it is called, and the energy it is planned to hold where that is known. */
export interface SplitPortion {
  key: string;
  label: string;
  kcal: number | null;
}

type Way = 'whole' | 'part' | 'pieces';

const WAYS: readonly Way[] = ['whole', 'part', 'pieces'];
/** How many portions a dish split on its own may have. */
const MOST_PORTIONS = 12;

/** A number above nothing typed in a field, a comma taken for a point; null for anything else. */
const typed = (text: string): number | null => {
  const value = Number(text.trim().replace(',', '.'));
  return text.trim() !== '' && Number.isFinite(value) && value > 0 ? value : null;
};

/**
 * Splits what was cooked once into its portions, each by its share: from the
 * energy the plan gives each where `portions` are given (a dish cooked ahead),
 * otherwise portions chosen here, equal or by the energy typed for each. The
 * whole dish is weighed, or one part of it at a time, or its pieces counted;
 * a dish weighed in its pot is the scale's weight less the empty pot's. Whole
 * grams and pieces, the last portion taking what is left. Nothing is kept.
 */
export function SplitCalculator({ portions: planned }: { portions?: SplitPortion[] }) {
  const t = useTranslations('split');
  const fmt = useFormat();
  const id = useId();
  const [count, setCount] = useState(2);
  const [byKcal, setByKcal] = useState(false);
  const [kcalTexts, setKcalTexts] = useState<string[]>([]);
  const [way, setWay] = useState<Way>('whole');
  const [scaleText, setScaleText] = useState('');
  const [inPot, setInPot] = useState(false);
  const [potText, setPotText] = useState('');
  const [piecesText, setPiecesText] = useState('');

  const portions: SplitPortion[] =
    planned ??
    Array.from({ length: count }, (_, index) => ({
      key: String(index),
      label: t('portion', { n: index + 1 }),
      kcal: byKcal ? typed(kcalTexts[index] ?? '') : null,
    }));
  const kcalMissing = !planned && byKcal && portions.some((portion) => portion.kcal === null);
  const shares = sharesOf(portions.map((portion) => portion.kcal));

  const onScale = typed(scaleText);
  const emptyPot = inPot ? typed(potText) : null;
  const weighed = way !== 'pieces' && onScale !== null && (!inPot || emptyPot !== null);
  const food = weighed ? foodWeight(onScale, emptyPot) : null;
  const potTooHeavy = weighed && inPot && food === null;
  const pieces = way === 'pieces' ? typed(piecesText) : null;
  const wholePieces = pieces !== null && Number.isInteger(pieces) ? pieces : null;

  const amounts =
    kcalMissing || (way === 'pieces' ? wholePieces === null : food === null)
      ? null
      : splitWhole(way === 'pieces' ? wholePieces! : food!, shares);

  return (
    <div className="space-y-4">
      {!planned && (
        <fieldset className="space-y-3">
          <legend className="sr-only">{t('portions')}</legend>
          <Field label={t('portionCount')}>
            <select
              className="block h-10 w-full rounded-md border border-input bg-background px-3 text-sm sm:w-40"
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
            >
              {Array.from({ length: MOST_PORTIONS - 1 }, (_, index) => index + 2).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
          <label className="flex min-h-6 items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={byKcal}
              onChange={(e) => setByKcal(e.target.checked)}
            />
            {t('byKcal')}
          </label>
          {byKcal && (
            <div className="grid gap-3 sm:grid-cols-2">
              {portions.map((portion, index) => (
                <Field key={portion.key} label={t('kcalOf', { n: index + 1 })}>
                  <Input
                    inputMode="numeric"
                    value={kcalTexts[index] ?? ''}
                    onChange={(e) =>
                      setKcalTexts((texts) => {
                        const next = [...texts];
                        next[index] = e.target.value;
                        return next;
                      })
                    }
                  />
                </Field>
              ))}
            </div>
          )}
        </fieldset>
      )}

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t('wayLegend')}</legend>
        {WAYS.map((option) => (
          <div key={option} className="space-y-1">
            <label className="flex min-h-6 items-center gap-2 text-sm">
              <input
                type="radio"
                name={`${id}-way`}
                className="h-4 w-4"
                checked={way === option}
                aria-describedby={`${id}-${option}`}
                onChange={() => setWay(option)}
              />
              {t(`way.${option}`)}
            </label>
            <p id={`${id}-${option}`} className="ml-6 text-xs text-muted-foreground">
              {t(`wayHint.${option}`)}
            </p>
          </div>
        ))}
      </fieldset>

      {way === 'pieces' ? (
        <Field label={t('pieceCount')}>
          <Input
            inputMode="numeric"
            value={piecesText}
            onChange={(e) => setPiecesText(e.target.value)}
          />
        </Field>
      ) : (
        <div className="space-y-3">
          <Field label={t('onScale')}>
            <Input
              inputMode="decimal"
              value={scaleText}
              onChange={(e) => setScaleText(e.target.value)}
            />
          </Field>
          <label className="flex min-h-6 items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={inPot}
              onChange={(e) => setInPot(e.target.checked)}
            />
            {t('inPot')}
          </label>
          {inPot && (
            <Field label={t('emptyPot')} error={potTooHeavy ? t('potTooHeavy') : undefined}>
              <Input
                inputMode="decimal"
                value={potText}
                onChange={(e) => setPotText(e.target.value)}
              />
            </Field>
          )}
          {inPot && food !== null && (
            <p className="text-sm text-muted-foreground">
              {t('foodAlone', { grams: fmt.unit(food, 'gram', 0) })}
            </p>
          )}
        </div>
      )}

      <section aria-live="polite" className="space-y-2">
        <h3 className="text-sm font-medium">{t('portions')}</h3>
        <ul className="divide-y divide-border rounded-md border border-border">
          {portions.map((portion, index) => (
            <li key={portion.key} className="flex items-baseline justify-between gap-3 px-3 py-2">
              <span className="min-w-0">
                <span className="block text-sm">{portion.label}</span>
                <span className="block text-xs text-muted-foreground">
                  {kcalMissing
                    ? t('shareUnknown')
                    : portion.kcal !== null
                      ? t('shareOfKcal', {
                          share: fmt.percent(shares[index]!),
                          kcal: fmt.number(portion.kcal),
                        })
                      : t('share', { share: fmt.percent(shares[index]!) })}
                </span>
              </span>
              <span className="whitespace-nowrap text-base font-semibold tabular-nums">
                {amounts === null
                  ? '—'
                  : way === 'pieces'
                    ? t('pieces', { count: amounts[index]! })
                    : fmt.unit(amounts[index]!, 'gram', 0)}
              </span>
            </li>
          ))}
        </ul>
        {amounts !== null && way !== 'pieces' && (
          <p className="text-xs text-muted-foreground">{t('tare')}</p>
        )}
      </section>

      <p className="rounded-md bg-muted/60 p-3 text-xs text-muted-foreground">{t('risk')}</p>
    </div>
  );
}
