// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import {
  MAX_MEALS_PER_DAY_SAME_KIND,
  MAX_MEALS_PER_WEEK_SAME_KIND,
  ProteinKind,
  type KindLimit,
  type ProfilePreferences,
} from '@diet-app/shared';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';

type KindLimits = Pick<
  ProfilePreferences,
  'maxMealsPerDaySameKind' | 'maxMealsPerWeekSameKind' | 'kindLimits'
>;

/** A row of exceptions: the kind it is for, and what it held when the form was opened. */
interface Row {
  key: number;
  kind: ProteinKind;
  initial?: KindLimit;
}

/** What a field of the form holds as a number; null for one left empty. */
const numberIn = (field: FormDataEntryValue | null | undefined): number | null =>
  field == null || String(field).trim() === '' ? null : Number(field);

/**
 * The limits on meals with one kind of protein, as the form holds them: the
 * profile's two numbers, empty for none, and the kinds held to numbers of their
 * own, a number left empty being the profile's. An exception with neither
 * number says nothing, and is left out.
 */
export function kindLimitsIn(fields: FormData): KindLimits {
  const perDay = fields.getAll('kindLimitPerDay');
  const perWeek = fields.getAll('kindLimitPerWeek');
  return {
    maxMealsPerDaySameKind: numberIn(fields.get('maxMealsPerDaySameKind')),
    maxMealsPerWeekSameKind: numberIn(fields.get('maxMealsPerWeekSameKind')),
    kindLimits: fields
      .getAll('kindLimitKind')
      .map((kind, row): KindLimit => ({
        kind: kind as ProteinKind,
        perDay: numberIn(perDay[row]),
        perWeek: numberIn(perWeek[row]),
      }))
      .filter((limit) => limit.perDay !== null || limit.perWeek !== null),
  };
}

/** The fields of the limits on meals with one kind of protein: two numbers for every kind, and exceptions for some. */
export function KindLimitFields({ initial }: { initial: KindLimits }) {
  const t = useTranslations('profile');
  const tKind = useTranslations('enums.proteinKind');
  // Each row keeps a key of its own, so that a row taken out takes what was typed in it along.
  const [rows, setRows] = useState<Row[]>(() =>
    initial.kindLimits.map((limit, key) => ({ key, kind: limit.kind, initial: limit })),
  );
  const [nextKey, setNextKey] = useState(initial.kindLimits.length);
  const unused = ProteinKind.options.filter((kind) => !rows.some((row) => row.kind === kind));

  return (
    <>
      <Field label={t('maxMealsPerDaySameKind')}>
        <Input
          name="maxMealsPerDaySameKind"
          type="number"
          min={1}
          max={MAX_MEALS_PER_DAY_SAME_KIND}
          placeholder={t('noLimit')}
          defaultValue={initial.maxMealsPerDaySameKind ?? ''}
        />
      </Field>
      <Field label={t('maxMealsPerWeekSameKind')}>
        <Input
          name="maxMealsPerWeekSameKind"
          type="number"
          min={1}
          max={MAX_MEALS_PER_WEEK_SAME_KIND}
          placeholder={t('noLimit')}
          defaultValue={initial.maxMealsPerWeekSameKind ?? ''}
        />
      </Field>
      <div className="space-y-1 text-xs text-muted-foreground sm:col-span-2">
        <p>{t('sameKindHint')}</p>
        <p>{t('sameKindBlocksHint')}</p>
      </div>
      <fieldset className="space-y-2 sm:col-span-2">
        <legend className="text-sm font-medium">{t('kindLimits')}</legend>
        <p className="text-xs text-muted-foreground">{t('kindLimitsHint')}</p>
        {rows.map((row) => (
          <div
            key={row.key}
            className="flex flex-wrap items-end gap-2 rounded-md border border-border/60 p-2"
          >
            <label className="space-y-1">
              <span className="block text-xs">{t('kindLimitKind')}</span>
              <select
                name="kindLimitKind"
                value={row.kind}
                onChange={(e) =>
                  setRows(
                    rows.map((other) =>
                      other.key === row.key
                        ? { ...other, kind: e.target.value as ProteinKind }
                        : other,
                    ),
                  )
                }
                className="h-10 rounded-md border border-input bg-background px-3 text-sm"
              >
                {ProteinKind.options.map((kind) => (
                  <option
                    key={kind}
                    value={kind}
                    disabled={kind !== row.kind && rows.some((other) => other.kind === kind)}
                  >
                    {tKind(kind)}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1">
              <span className="block text-xs">{t('kindLimitPerDay')}</span>
              <Input
                name="kindLimitPerDay"
                type="number"
                min={1}
                max={MAX_MEALS_PER_DAY_SAME_KIND}
                placeholder={t('sameAsAbove')}
                defaultValue={row.initial?.perDay ?? ''}
                className="w-32"
              />
            </label>
            <label className="space-y-1">
              <span className="block text-xs">{t('kindLimitPerWeek')}</span>
              <Input
                name="kindLimitPerWeek"
                type="number"
                min={1}
                max={MAX_MEALS_PER_WEEK_SAME_KIND}
                placeholder={t('sameAsAbove')}
                defaultValue={row.initial?.perWeek ?? ''}
                className="w-32"
              />
            </label>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={t('removeKindLimit', { kind: tKind(row.kind) })}
              onClick={() => setRows(rows.filter((other) => other.key !== row.key))}
            >
              {t('removeKindLimitShort')}
            </Button>
          </div>
        ))}
        {unused.length > 0 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setRows([...rows, { key: nextKey, kind: unused[0]! }]);
              setNextKey(nextKey + 1);
            }}
          >
            {t('addKindLimit')}
          </Button>
        )}
      </fieldset>
    </>
  );
}
