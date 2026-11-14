// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ActivityLevel,
  DietType,
  Profile,
  ProfilePatch,
  ProfilePreferencesPatch,
  Sex,
  WeeklyLossTarget,
  WeightReminderCadence,
  WeightUnit,
} from '@diet-app/shared';
import { api } from '@/lib/api';
import { useErrorText } from '@/lib/use-error-text';
import { shownToOne, toKilograms } from '@/lib/weight-unit';
import { A_FIRST_SPLIT, splitAddsUp, splitIn } from '@/components/profile-fields';
import { kindLimitsIn } from './kind-limit-fields';
import { labelLimitsIn } from './label-limit-fields';

/*
 * A profile's form that keeps each change as it is made, with no button to
 * press: a choice, a box and a switch the moment they change, a field typed
 * into once it is left. Each change is sent alone, by itself: what the form
 * does not change of the profile, its preferences above all, stays as the
 * profile has it, whoever changed it meanwhile. The changes go one after
 * another, in the order they were made.
 */

/**
 * A weight typed in the unit of the account, in kilograms; null for a field
 * left empty. A field that still shows what the profile has gives back
 * exactly that: a weight that went through pounds and back would otherwise
 * move by a hair with every change.
 */
export function weightIn(
  field: FormDataEntryValue | null,
  before: number | null | undefined,
  unit: WeightUnit,
): number | null {
  if (field === null || String(field).trim() === '') return null;
  const typed = Number(field);
  return before != null && typed === shownToOne(before, unit) ? before : toKilograms(typed, unit);
}

/** The part of a profile one field of its form changes: what is kept together goes together. */
type Part =
  | 'name'
  | 'age'
  | 'sex'
  | 'heightCm'
  | 'weight'
  | 'activityLevel'
  | 'weeklyLossTarget'
  | 'targetWeight'
  | 'waterTracking'
  | 'waterTarget'
  | 'manualCalorieTarget'
  | 'acknowledgeRisk'
  | 'weightReminderCadence'
  | 'cookingReminders'
  | 'waterReminders'
  | 'dietType'
  | 'mealCount'
  | 'split'
  | 'maxConsecutiveDaysSameMeal'
  | 'maxTimesPerWeekSameMeal'
  | 'inventoryBiasResetEvery'
  | 'kindLimits'
  | 'labelLimits';

const PARTS_BY_NAME: Record<string, Part> = {
  splitProtein: 'split',
  splitFat: 'split',
  splitCarbs: 'split',
  maxMealsPerDaySameKind: 'kindLimits',
  maxMealsPerWeekSameKind: 'kindLimits',
  kindLimitKind: 'kindLimits',
  kindLimitPerDay: 'kindLimits',
  kindLimitPerWeek: 'kindLimits',
  saltAtMost: 'labelLimits',
  saltAtMostOn: 'labelLimits',
  fiberAtLeast: 'labelLimits',
  fiberAtLeastOn: 'labelLimits',
  saturatedFatAtMost: 'labelLimits',
  saturatedFatAtMostOn: 'labelLimits',
  sugarsAtMost: 'labelLimits',
  sugarsAtMostOn: 'labelLimits',
};
const OWN_PARTS: ReadonlySet<string> = new Set<Part>([
  'name',
  'age',
  'sex',
  'heightCm',
  'weight',
  'activityLevel',
  'weeklyLossTarget',
  'targetWeight',
  'waterTracking',
  'waterTarget',
  'manualCalorieTarget',
  'acknowledgeRisk',
  'weightReminderCadence',
  'cookingReminders',
  'waterReminders',
  'dietType',
  'mealCount',
  'maxConsecutiveDaysSameMeal',
  'maxTimesPerWeekSameMeal',
  'inventoryBiasResetEvery',
]);

/** The part of the profile a field of the form, by its name, changes; none for a field that is no part of it. */
function partOf(name: string): Part | undefined {
  return PARTS_BY_NAME[name] ?? (OWN_PARTS.has(name) ? (name as Part) : undefined);
}

/** What a change sends: some parts of the profile, or some of its preferences. */
type Change =
  { to: 'profile'; patch: ProfilePatch } | { to: 'preferences'; patch: ProfilePreferencesPatch };

/** A number of a field; null for one left empty. */
const numberOrNull = (field: FormDataEntryValue | null): number | null =>
  field === null || String(field).trim() === '' ? null : Number(field);

/**
 * What a part of the form holds, as the change of the profile that keeps it.
 * `kept` is the profile as it is kept now. Null where the part holds nothing
 * that could be kept: a split that does not add up.
 */
function changeOf(part: Part, fields: FormData, kept: Profile, unit: WeightUnit): Change | null {
  const own = (patch: ProfilePatch): Change => ({ to: 'profile', patch });
  const preferences = (patch: ProfilePreferencesPatch): Change => ({ to: 'preferences', patch });
  switch (part) {
    case 'name':
      return own({ name: String(fields.get('name')).trim() });
    case 'age':
      return own({ age: Number(fields.get('age')) });
    case 'heightCm':
      return own({ heightCm: Number(fields.get('heightCm')) });
    case 'mealCount':
      return own({ mealCount: Number(fields.get('mealCount')) });
    case 'sex':
      return own({ sex: (fields.get('sex') as Sex | '') || null });
    case 'weight':
      return own({
        weightKg: weightIn(fields.get('weight'), kept.weightKg, unit) ?? kept.weightKg,
      });
    case 'targetWeight':
      return own({
        targetWeightKg: weightIn(fields.get('targetWeight'), kept.targetWeightKg, unit),
      });
    case 'activityLevel':
      return own({ activityLevel: fields.get('activityLevel') as ActivityLevel });
    case 'weeklyLossTarget':
      return own({
        weeklyLossTarget: (fields.get('weeklyLossTarget') as WeeklyLossTarget | '') || null,
      });
    case 'waterTracking':
      return own({ waterTracking: fields.get('waterTracking') === 'on' });
    case 'cookingReminders':
      return own({ cookingReminders: fields.get('cookingReminders') === 'on' });
    case 'waterReminders':
      return own({ waterReminders: fields.get('waterReminders') === 'on' });
    case 'acknowledgeRisk':
      return own({ acknowledgeRisk: fields.get('acknowledgeRisk') === 'on' });
    case 'waterTarget':
      return own({ waterTargetMl: numberOrNull(fields.get('waterTarget')) });
    case 'manualCalorieTarget':
      return own({ manualCalorieTarget: numberOrNull(fields.get('manualCalorieTarget')) });
    case 'weightReminderCadence':
      return own({
        weightReminderCadence: fields.get('weightReminderCadence') as WeightReminderCadence,
      });
    case 'dietType': {
      const dietType = fields.get('dietType') as DietType;
      // The custom diet comes with its split: the one the profile keeps, or the one the form begins with.
      return own(
        dietType === 'custom'
          ? { dietType, customMacroSplit: kept.customMacroSplit ?? A_FIRST_SPLIT }
          : { dietType },
      );
    }
    case 'split':
      return splitAddsUp(fields) ? own({ customMacroSplit: splitIn(fields, null) }) : null;
    case 'maxConsecutiveDaysSameMeal':
      return preferences({ maxConsecutiveDaysSameMeal: Number(fields.get(part)) });
    case 'maxTimesPerWeekSameMeal':
      return preferences({ maxTimesPerWeekSameMeal: Number(fields.get(part)) });
    case 'inventoryBiasResetEvery':
      return preferences({ inventoryBiasResetEvery: Number(fields.get(part)) });
    case 'kindLimits':
      return preferences(kindLimitsIn(fields));
    case 'labelLimits':
      return preferences({ labelLimits: labelLimitsIn(fields) });
  }
}

/** Whether a field takes its change the moment it is made: a choice, a box, a switch. A field typed into waits until it is left. */
const changesAtOnce = (field: HTMLInputElement | HTMLSelectElement): boolean =>
  field instanceof HTMLSelectElement || field.type === 'checkbox' || field.type === 'radio';

export interface Autosave {
  /** What the form says of its changes: being kept, kept, or one of them not kept. */
  status: 'idle' | 'saving' | 'saved' | 'failed';
  /** Why the part a field changes was not kept, where it was not; by the part's name. */
  errorOf: (part: string) => string | undefined;
  /** For the form: a change of a field. */
  onChange: (event: React.FormEvent<HTMLFormElement>) => void;
  /** For the form: a field left. */
  onBlur: (event: React.FocusEvent<HTMLFormElement>) => void;
  /** For the form: Enter in a field keeps what it holds, as leaving it would. */
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  /** A part changed without an event of a field of its own (a row of exceptions taken away): kept once the form shows it. */
  changed: (part: Part) => void;
  /** Keeps what the field being typed in holds, and waits for every change on its way; whether all of them were kept. */
  settle: () => Promise<boolean>;
}

/**
 * The changes of the form of `profile` as they are made: nothing while there
 * is no profile, as for a form that makes a new one. `form` is the form;
 * `onKept` hears the profile as each change left it.
 */
export function useAutosave(
  profile: Profile | null,
  unit: WeightUnit,
  form: React.RefObject<HTMLFormElement | null>,
  onKept: (profile: Profile) => void,
): Autosave {
  const t = useTranslations('profile');
  const errorText = useErrorText();
  const qc = useQueryClient();
  const kept = useRef(profile);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const typed = useRef(new Set<Part>());
  // The parts not kept, as the changes on their way leave them: what the form shows of them follows.
  const notKept = useRef(new Set<Part>());
  const [sending, setSending] = useState(0);
  const [errors, setErrors] = useState<ReadonlyMap<Part, string>>(new Map());
  const [savedOnce, setSavedOnce] = useState(false);
  // The form of another profile begins with nothing typed, nothing on its way and nothing refused.
  const [of, setOf] = useState(profile?.id);
  if (of !== profile?.id) {
    setOf(profile?.id);
    setErrors(new Map());
    setSavedOnce(false);
  }
  useEffect(() => {
    kept.current = profile;
    typed.current.clear();
    notKept.current.clear();
    // Only another profile begins again: the same one comes back as each change leaves it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.id]);

  /** Why the fields of `part` cannot be kept as they are: the first that holds what it may not. */
  const refusalOf = useCallback(
    (part: Part): string | undefined => {
      const fields = [...(form.current?.elements ?? [])].filter(
        (field): field is HTMLInputElement =>
          (field instanceof HTMLInputElement || field instanceof HTMLSelectElement) &&
          !field.disabled &&
          partOf(field.name) === part,
      );
      const wrong = fields.find((field) => !field.checkValidity());
      if (!wrong) return undefined;
      if (wrong.validity.valueMissing || wrong.validity.patternMismatch)
        return t('autosave.required');
      return t('autosave.between', { min: wrong.min, max: wrong.max });
    },
    [form, t],
  );

  const keep = useCallback(
    (part: Part) => {
      queue.current = queue.current.then(async () => {
        const profile = kept.current;
        if (!profile) return;
        const fields = form.current ? new FormData(form.current) : null;
        const refused = refusalOf(part);
        const change = fields && !refused ? changeOf(part, fields, profile, unit) : null;
        if (!change) {
          notKept.current.add(part);
          setErrors((now) => new Map(now).set(part, refused ?? t('splitSumRefused')));
          return;
        }
        setSending((n) => n + 1);
        try {
          const answer = await api.request<Profile>(
            change.to === 'profile'
              ? `/profiles/${profile.id}`
              : `/profiles/${profile.id}/preferences`,
            // Kept even when the page is being left: a field is left as the page goes too.
            { method: 'PATCH', body: JSON.stringify(change.patch), keepalive: true },
          );
          kept.current = answer;
          qc.setQueryData<Profile[]>(['profiles'], (shown) =>
            shown?.map((other) => (other.id === answer.id ? answer : other)),
          );
          void qc.invalidateQueries({ queryKey: ['calories'] });
          onKept(answer);
          notKept.current.delete(part);
          setErrors((now) => {
            if (!now.has(part)) return now;
            const next = new Map(now);
            next.delete(part);
            return next;
          });
          setSavedOnce(true);
        } catch (error) {
          notKept.current.add(part);
          setErrors((now) => new Map(now).set(part, errorText(error, t('autosave.notKept'))));
        } finally {
          setSending((n) => n - 1);
        }
      });
    },
    [errorText, form, onKept, qc, refusalOf, t, unit],
  );

  /** A part kept once the form shows what the change made of it: a box that shows a field, a row taken away. */
  const changed = useCallback(
    (part: Part) => {
      setTimeout(() => keep(part), 0);
    },
    [keep],
  );

  const onChange = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      const field = event.target as HTMLInputElement | HTMLSelectElement;
      const part = partOf(field.name);
      if (!part) return;
      if (changesAtOnce(field)) changed(part);
      else typed.current.add(part);
    },
    [changed],
  );

  const keepTyped = useCallback(
    (part: Part | undefined) => {
      if (!part || !typed.current.has(part)) return;
      typed.current.delete(part);
      keep(part);
    },
    [keep],
  );

  const onBlur = useCallback(
    (event: React.FocusEvent<HTMLFormElement>) => {
      const field = event.target as unknown as HTMLInputElement;
      keepTyped(partOf(field.name ?? ''));
    },
    [keepTyped],
  );

  const onSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      for (const part of [...typed.current]) keepTyped(part);
    },
    [keepTyped],
  );

  const settle = useCallback(async () => {
    for (const part of [...typed.current]) keepTyped(part);
    await queue.current;
    return notKept.current.size === 0;
  }, [keepTyped]);

  // What is typed and not yet kept is kept as the page goes: a tab closed, the browser sent elsewhere.
  useEffect(() => {
    const leaving = () => {
      for (const part of [...typed.current]) keepTyped(part);
    };
    window.addEventListener('pagehide', leaving);
    return () => window.removeEventListener('pagehide', leaving);
  }, [keepTyped]);

  const status = sending > 0 ? 'saving' : errors.size > 0 ? 'failed' : savedOnce ? 'saved' : 'idle';
  return {
    status,
    errorOf: (part) => errors.get(part as Part),
    onChange,
    onBlur,
    onSubmit,
    changed,
    settle,
  };
}
