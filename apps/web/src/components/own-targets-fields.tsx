// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { PROTEIN_PER_KG, SPLIT_SHARE_LIMITS, type MacroSplit } from '@diet-app/shared';
import {
  gramsAt,
  insideLimits,
  kcalOfGrams,
  perKgSplit,
  splitOfGrams,
  type PerKgSplit,
} from '@/lib/own-split';
import { Field, Input } from '@/components/ui/input';

/*
 * The custom diet's targets, as the forms of a profile and the form of a plan
 * ask for them, and what a form reads of them.
 */

/** The limits of a split, as the sentence that says them takes them. */
const limitsWords = () => ({
  proteinMin: SPLIT_SHARE_LIMITS.protein.min,
  proteinMax: SPLIT_SHARE_LIMITS.protein.max,
  fatMin: SPLIT_SHARE_LIMITS.fat.min,
  fatMax: SPLIT_SHARE_LIMITS.fat.max,
  carbsMin: SPLIT_SHARE_LIMITS.carbs.min,
  carbsMax: SPLIT_SHARE_LIMITS.carbs.max,
});

/**
 * A split that adds up around `fat`, protein as near `protein` as the limits
 * let it be and carbohydrate the rest: what protein per kilogram sends until
 * the form knows the target and the weight it is worked out at, so that the
 * figures stay ones the target can be worked out from.
 */
function splitAround(protein: number, fat: number): Record<keyof MacroSplit, string> {
  const kept = Math.min(
    Math.min(SPLIT_SHARE_LIMITS.protein.max, 100 - fat - SPLIT_SHARE_LIMITS.carbs.min),
    Math.max(
      Math.max(SPLIT_SHARE_LIMITS.protein.min, 100 - fat - SPLIT_SHARE_LIMITS.carbs.max),
      protein,
    ),
  );
  return { protein: String(kept), fat: String(fat), carbs: String(100 - kept - fat) };
}

/** Three numbers as their fields hold them. */
const typedOf = (parts: Record<keyof MacroSplit, number>): Record<keyof MacroSplit, string> => ({
  protein: String(parts.protein),
  fat: String(parts.fat),
  carbs: String(parts.carbs),
});

/** The split a profile that goes to the custom diet begins with: the balanced diet's. */
export const A_FIRST_SPLIT: MacroSplit = { protein: 25, fat: 30, carbs: 45 };

/** The custom diet's targets as a profile keeps them: the split in whole per cent, and protein per kilogram where protein is set so. */
export interface OwnTargets {
  customMacroSplit: MacroSplit;
  customProteinPerKg: number | null;
}

/**
 * What is wrong with the targets `OwnTargetsFields` hold in a form, or null
 * where nothing is: three shares that do not add up to a hundred, grams whose
 * shares go past a limit of a split, or protein per kilogram that does not
 * fit the target and the weight.
 */
export function ownTargetsFault(fields: FormData): 'sum' | 'limits' | 'perKg' | null {
  if (fields.get('customSplitHeld') === 'yes') return 'perKg';
  if (fields.get('customSplitOff') === 'yes') return 'limits';
  const { protein, fat, carbs } = ownTargetsOf(fields).customMacroSplit;
  return protein + fat + carbs === 100 ? null : 'sum';
}

/** The same for a form whose diet is a field of its own: nothing is wrong on every diet but the custom one. */
export function ownTargetsProblem(fields: FormData): 'sum' | 'limits' | 'perKg' | null {
  return fields.get('dietType') === 'custom' ? ownTargetsFault(fields) : null;
}

/** The targets `OwnTargetsFields` hold in a form, whichever way they were typed in. */
export function ownTargetsOf(fields: FormData): OwnTargets {
  return {
    customMacroSplit: {
      protein: Number(fields.get('splitProtein')),
      fat: Number(fields.get('splitFat')),
      carbs: Number(fields.get('splitCarbs')),
    },
    customProteinPerKg:
      fields.get('customWay') === 'perKg' ? Number(fields.get('customProteinPerKg')) : null,
  };
}

/** The split a form holds for the custom diet; `kept` (the one a profile has for when it goes back) on every other. */
export function splitIn(fields: FormData, kept: MacroSplit | null): MacroSplit | null {
  return fields.get('dietType') === 'custom' ? ownTargetsOf(fields).customMacroSplit : kept;
}

/** What a form says when it does not send the custom diet's targets, by what is wrong with them (`ownTargetsFault`). */
export const OWN_TARGETS_REFUSED = {
  sum: 'splitSumRefused',
  limits: 'splitLimitsRefused',
  perKg: 'perKgRefused',
} as const;

/** The custom diet's protein per kilogram a form holds, null for the way of the split; `kept` on every other diet. */
export function proteinPerKgIn(fields: FormData, kept: number | null): number | null {
  return fields.get('dietType') === 'custom' ? ownTargetsOf(fields).customProteinPerKg : kept;
}

/**
 * The custom diet's targets, as every form that asks for them shows them: the
 * way they are set (the split of calories, typed in per cent or in grams, or
 * protein per kilogram of the weight with fat's share), the fields of that
 * way, and what they come to at the `target` and the `weightKg` the form
 * knows. Hidden fields carry the split in whole per cent, whatever the way,
 * so a form reads it alike (`ownTargetsOf`, `ownTargetsFault`).
 */
export function OwnTargetsFields({
  split: firstSplit,
  perKg: firstPerKg = null,
  target = null,
  weightKg = null,
  errorOf,
  note,
  planTarget = null,
  className = 'sm:col-span-2',
}: {
  split: MacroSplit | null;
  /** The protein per kilogram the profile keeps; null for the way of the split. */
  perKg?: number | null;
  /** The day's calorie target the targets come to, and the weight they hold: what grams are worked out at. */
  target?: number | null;
  weightKg?: number | null;
  /** Why a change of the targets was not kept, for a form that keeps each change as it is made. */
  errorOf?: (field: string) => string | undefined;
  /** What the form that shows the targets says of them besides, under their hint. */
  note?: string;
  /** A target of a plan's own, which the plan is made to instead of `target`: protein held at a limit there is said. */
  planTarget?: number | null;
  className?: string;
}) {
  const t = useTranslations('profile');
  // The three shares as they are typed, so that the form can say what they add up to before it is sent.
  const [split, setSplit] = useState<Record<keyof MacroSplit, string>>(() =>
    typedOf(firstSplit ?? A_FIRST_SPLIT),
  );
  const sum = Number(split.protein) + Number(split.fat) + Number(split.carbs);
  // The custom diet's way, and the unit its split is typed in.
  const [way, setWay] = useState<'split' | 'perKg'>(firstPerKg != null ? 'perKg' : 'split');
  const [unit, setUnit] = useState<'percent' | 'grams'>('percent');
  const [grams, setGrams] = useState<Record<keyof MacroSplit, string>>({
    protein: '',
    fat: '',
    carbs: '',
  });
  const [perKg, setPerKg] = useState(String(firstPerKg ?? PROTEIN_PER_KG.first));
  const [perKgFat, setPerKgFat] = useState(String((firstSplit ?? A_FIRST_SPLIT).fat));
  const known = target != null && target > 0 && weightKg != null && weightKg > 0;
  const typedGrams = {
    protein: Number(grams.protein),
    fat: Number(grams.fat),
    carbs: Number(grams.carbs),
  };
  const ofGrams = unit === 'grams' ? splitOfGrams(typedGrams) : null;
  // What protein per kilogram comes to is worked out only from figures inside their fields' bounds, protein by tenths of
  // a gram: what is typed past them is said by the field, and an empty field is no figure.
  const typedPerKg = perKg.trim() === '' ? Number.NaN : Number(perKg);
  const typedFat = perKgFat.trim() === '' ? Number.NaN : Number(perKgFat);
  const typedFits =
    typedPerKg >= PROTEIN_PER_KG.min &&
    typedPerKg <= PROTEIN_PER_KG.max &&
    Math.abs(typedPerKg * 10 - Math.round(typedPerKg * 10)) < 1e-9 &&
    Number.isInteger(typedFat) &&
    typedFat >= SPLIT_SHARE_LIMITS.fat.min &&
    typedFat <= SPLIT_SHARE_LIMITS.fat.max;
  const ofPerKg =
    way === 'perKg' && known && typedFits
      ? perKgSplit(typedPerKg, typedFat, weightKg, target)
      : null;
  const atPlan =
    way === 'perKg' && typedFits && planTarget && weightKg && weightKg > 0
      ? perKgSplit(typedPerKg, typedFat, weightKg, planTarget)
      : null;
  // What the form sends as the split: as typed in per cent, the shares of the grams, or what protein per kilogram comes to.
  const sent: Record<keyof MacroSplit, string> =
    way === 'perKg'
      ? ofPerKg
        ? {
            protein: String(ofPerKg.split.protein),
            fat: perKgFat,
            carbs: String(ofPerKg.split.carbs),
          }
        : splitAround(Number(split.protein), Number(perKgFat))
      : unit === 'grams'
        ? ofGrams
          ? typedOf(ofGrams)
          : { protein: '', fat: '', carbs: '' }
        : split;
  /** Grams for the split as it stands, at the target where the form knows one. */
  const toGrams = () => {
    if (target == null || !(target > 0)) return;
    const at = gramsAt(
      { protein: Number(split.protein), fat: Number(split.fat), carbs: Number(split.carbs) },
      target,
    );
    setGrams(typedOf(at));
  };
  return (
    <fieldset className={`space-y-3 ${className}`}>
      <legend className="text-sm font-medium">{t('customSplit')}</legend>
      <p className="text-xs text-muted-foreground">{t('customSplitHint')}</p>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
      <div
        role="radiogroup"
        aria-label={t('customWay')}
        className="flex flex-wrap gap-x-4 gap-y-2 text-sm"
      >
        <span className="w-full text-muted-foreground sm:w-auto">{t('customWay')}</span>
        {(['split', 'perKg'] as const).map((one) => (
          <label key={one} className="inline-flex items-center gap-2">
            <input
              type="radio"
              name="customWay"
              value={one}
              checked={way === one}
              onChange={() => {
                // Protein per kilogram begins with the fat of the split as it is typed.
                const fat = unit === 'grams' ? ofGrams?.fat : Number(split.fat);
                if (one === 'perKg' && fat !== undefined && Number.isInteger(fat) && fat > 0)
                  setPerKgFat(String(fat));
                setWay(one);
              }}
            />
            {t(one === 'split' ? 'customWaySplit' : 'customWayPerKg')}
          </label>
        ))}
      </div>
      {way === 'split' && (
        <>
          <div
            role="radiogroup"
            aria-label={t('customUnit')}
            className="flex flex-wrap gap-x-4 gap-y-2 text-sm"
          >
            <span className="w-full text-muted-foreground sm:w-auto">{t('customUnit')}</span>
            {(['percent', 'grams'] as const).map((one) => (
              <label key={one} className="inline-flex items-center gap-2">
                <input
                  type="radio"
                  name="customUnit"
                  value={one}
                  checked={unit === one}
                  onChange={() => {
                    if (one === 'grams') toGrams();
                    else if (ofGrams && insideLimits(ofGrams)) setSplit(typedOf(ofGrams));
                    setUnit(one);
                  }}
                />
                {t(one === 'percent' ? 'customUnitPercent' : 'customUnitGrams')}
              </label>
            ))}
          </div>
          <div className="grid grid-cols-3 items-end gap-3">
            {(['protein', 'fat', 'carbs'] as const).map((part) =>
              unit === 'percent' ? (
                <Field key={part} label={t(`split.${part}`)}>
                  <Input
                    name={`split${part[0]!.toUpperCase()}${part.slice(1)}`}
                    type="number"
                    inputMode="numeric"
                    required
                    min={SPLIT_SHARE_LIMITS[part].min}
                    max={SPLIT_SHARE_LIMITS[part].max}
                    step={1}
                    value={split[part]}
                    onChange={(e) => setSplit({ ...split, [part]: e.target.value })}
                  />
                </Field>
              ) : (
                <Field key={part} label={t(`splitGrams.${part}`)}>
                  <Input
                    name={`grams${part[0]!.toUpperCase()}${part.slice(1)}`}
                    type="number"
                    inputMode="numeric"
                    required
                    min={1}
                    max={2000}
                    step={1}
                    value={grams[part]}
                    onChange={(e) => setGrams({ ...grams, [part]: e.target.value })}
                  />
                </Field>
              ),
            )}
          </div>
          {/* Said while it is typed: a form that is refused for its sum should have said the sum. */}
          {unit === 'percent' ? (
            <p
              aria-live="polite"
              className={sum === 100 ? 'text-xs text-muted-foreground' : 'text-xs text-warning'}
            >
              {t(sum === 100 ? 'splitSum' : 'splitSumOff', { sum })}
            </p>
          ) : (
            ofGrams && (
              <div aria-live="polite" className="space-y-1 text-xs">
                <p className="text-muted-foreground">
                  {t('gramsShares', { kcal: Math.round(kcalOfGrams(typedGrams)), ...ofGrams })}
                </p>
                {insideLimits(ofGrams) ? (
                  target != null &&
                  target > 0 && (
                    <p className="text-muted-foreground">
                      {t('gramsAtTarget', { target, ...gramsAt(ofGrams, target) })}
                    </p>
                  )
                ) : (
                  <p className="text-warning">{t('splitOutOfLimits', limitsWords())}</p>
                )}
              </div>
            )
          )}
        </>
      )}
      {way === 'perKg' && (
        <>
          <div className="grid grid-cols-2 items-end gap-3">
            <Field label={t('perKgProtein')}>
              <Input
                name="customProteinPerKg"
                type="number"
                inputMode="decimal"
                required
                min={PROTEIN_PER_KG.min}
                max={PROTEIN_PER_KG.max}
                step={0.1}
                value={perKg}
                onChange={(e) => setPerKg(e.target.value)}
              />
            </Field>
            <Field label={t('perKgFat')}>
              <Input
                name="perKgFat"
                type="number"
                inputMode="numeric"
                required
                min={SPLIT_SHARE_LIMITS.fat.min}
                max={SPLIT_SHARE_LIMITS.fat.max}
                step={1}
                value={perKgFat}
                onChange={(e) => setPerKgFat(e.target.value)}
              />
            </Field>
          </div>
          <div aria-live="polite" className="space-y-1 text-xs">
            {ofPerKg ? (
              <>
                <p className="text-muted-foreground">
                  {t('perKgLine', {
                    // Held at a limit, the grams the limit keeps: those the share beside them stands for.
                    protein: Math.round(ofPerKg.held ? ofPerKg.keptGrams : ofPerKg.protein),
                    share: ofPerKg.split.protein,
                    target: target!,
                    carbs: ofPerKg.split.carbs,
                  })}
                </p>
                {ofPerKg.held && (
                  <p className="text-warning">
                    {ofPerKg.fits
                      ? t('perKgFits', { from: ofPerKg.fits.from, to: ofPerKg.fits.to })
                      : t('perKgNoFit')}
                  </p>
                )}
                {!ofPerKg.held && atPlan?.held && (
                  <PlanTargetHeld kcal={planTarget!} perKg={Number(perKg)} at={atPlan} />
                )}
              </>
            ) : (
              // Waited for only while the figures typed are good: a wrong one is said by its field.
              typedFits && <p className="text-muted-foreground">{t('perKgWaiting')}</p>
            )}
          </div>
        </>
      )}
      {/* What the form sends of the custom diet, whichever way it is typed in. */}
      {(way === 'perKg' || unit === 'grams') && (
        <>
          <input type="hidden" name="splitProtein" value={sent.protein} />
          <input type="hidden" name="splitFat" value={sent.fat} />
          <input type="hidden" name="splitCarbs" value={sent.carbs} />
        </>
      )}
      {way === 'perKg' && ofPerKg?.held && (
        <input type="hidden" name="customSplitHeld" value="yes" />
      )}
      {way === 'split' && unit === 'grams' && (!ofGrams || !insideLimits(ofGrams)) && (
        <input type="hidden" name="customSplitOff" value="yes" />
      )}
      {errorOf?.('split') && (
        <p role="alert" className="text-xs text-destructive">
          {errorOf('split')}
        </p>
      )}
      {errorOf?.('customProteinPerKg') && (
        <p role="alert" className="text-xs text-destructive">
          {errorOf('customProteinPerKg')}
        </p>
      )}
    </fieldset>
  );
}

/**
 * What a plan made to a target of its own says where protein per kilogram goes
 * past a limit of a split at that target: the plan holds protein at the limit,
 * as many grams a day as that leaves.
 */
export function PlanTargetHeld({
  kcal,
  perKg,
  at,
}: {
  kcal: number;
  perKg: number;
  at: PerKgSplit;
}) {
  const t = useTranslations('profile');
  return (
    <p className="text-xs text-warning">
      {t('perKgHeldAtPlan', { kcal, perKg, grams: Math.round(at.keptGrams) })}
    </p>
  );
}
