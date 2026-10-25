// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useState } from 'react';
import {
  DEFAULT_PROFILES_PER_ACCOUNT,
  DEFAULT_WEEKLY_AMOUNT_PER_INGREDIENT,
  MAX_WEEKLY_AMOUNT_PER_INGREDIENT,
  MIN_WEEKLY_AMOUNT_PER_INGREDIENT,
  type Profile,
  type ProfileInput,
  type ProfilePreferencesPatch,
  type WeightReminderCadence,
} from '@diet-app/shared';
import { CUISINES } from '@diet-app/shared/constants';
import { api } from '@/lib/api';
import { figuresOf, riskOf } from '@/lib/typed-figures';
import { useProfileForm } from '@/lib/use-profile-form';
import { useConfig } from '@/lib/use-config';
import { useErrorText } from '@/lib/use-error-text';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AllergenPicker } from '@/components/allergen-picker';
import { IngredientPicker } from '@/components/ingredient-picker';
import { Field, Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { CaloriePreviewPanel, useCaloriePreview } from '@/components/calorie-preview';
import { BodyFields, DietFields, OwnTargetField, PaceChoice, RiskBox, splitAddsUp, splitIn } from '@/components/profile-fields';
import { LoadFailed } from '@/components/load-failed';
import { useFormat } from '@/lib/use-format';
import { boundsIn, shownToOne, shownWeight, toKilograms, useWeightUnit } from '@/lib/weight-unit';


/** Fetched for an account that has no profile yet: nobody else is shown the steps. */
const FirstProfile = dynamic(() => import('./first-profile').then((steps) => steps.FirstProfile), {
  ssr: false,
  loading: () => <Skeleton className="h-96 max-w-4xl" />,
});

/** Profile manager — create, edit and delete the account's profiles. */
export default function ProfilePage() {
  const t = useTranslations('profile');
  const tCommon = useTranslations('common');
  const tDiet = useTranslations('enums.dietType');
  const tCuisine = useTranslations('enums.cuisine');
  const tWizard = useTranslations('profile.wizard');
  const errorText = useErrorText();
  const qc = useQueryClient();
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: () => api.get<Profile[]>('/profiles') });
  const [error, setError] = useState<string | null>(null);
  // null = the form creates a new profile; a Profile = the form edits it.
  const [editing, setEditing] = useState<Profile | null>(null);
  // Weights are shown and typed in the unit of the account; the API keeps kilograms.
  const unit = useWeightUnit();
  // What the form holds, as it was last typed: the figures a calorie target is
  // worked out from, and why losing weight is a risk for the body they
  // describe, when a loss is asked for. Until something is typed, both are the
  // profile's own.
  const formKey = editing?.id ?? 'new';
  const { form, typed, onChange } = useProfileForm(formKey, unit);
  const risk = typed ? typed.reasons : editing ? riskOf(editing) : [];
  const shown = useCaloriePreview(typed ? typed.figures : editing ? figuresOf(editing) : null);
  // The profile the steps of a first profile have just made: the page says what comes next.
  const [made, setMade] = useState<Profile | null>(null);
  // Creation is opt-in: the form stays hidden until the user clicks "Add".
  const [creating, setCreating] = useState(false);

  const list = profiles.data ?? [];
  const fmt = useFormat();
  const weightBounds = boundsIn(unit);
  /**
   * A weight of the form, in kilograms; null for a field left empty. A field
   * that still shows what the profile had gives back exactly that: a weight
   * that went through pounds and back would otherwise move by a hair with
   * every save.
   */
  const weightTyped = (field: FormDataEntryValue | null, before: number | null | undefined): number | null => {
    if (field === null || String(field).trim() === '') return null;
    const typed = Number(field);
    return before != null && typed === shownToOne(before, unit) ? before : toKilograms(typed, unit);
  };
  // How many profiles an account may hold is the instance's to say.
  const maxProfiles = useConfig().data?.accounts.maxProfiles ?? DEFAULT_PROFILES_PER_ACCOUNT;
  const atLimit = list.length >= maxProfiles;

  /** Profile data feeds the calorie engine — refresh everything derived from it. */
  function recalculate() {
    qc.invalidateQueries({ queryKey: ['profiles'] });
    qc.invalidateQueries({ queryKey: ['calories'] });
  }

  const save = useMutation({
    mutationFn: (input: ProfileInput) =>
      editing
        ? api.put<Profile>(`/profiles/${editing.id}`, input)
        : api.post<Profile>('/profiles', input),
    onSuccess: () => {
      recalculate();
      setEditing(null);
      setCreating(false);
    },
    onError: (e) =>
      setError(errorText(e, t('saveFailed'))),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete<void>(`/profiles/${id}`),
    onSuccess: () => {
      recalculate();
      setEditing(null);
    },
    onError: (e) =>
      setError(errorText(e, t('deleteFailed'))),
  });

  // Change preferences in place: only the part that changed is sent, and the rest of the profile stays as it is.
  // What is on its way to the API is shown from the moment it was chosen, in the same breath as the click: a box that
  // was ticked looks ticked. It is taken back when the API refuses it.
  const [sending, setSending] = useState<{ id: string; preferences: ProfilePreferencesPatch } | null>(null);
  const savePrefs = useMutation({
    mutationFn: (v: { profile: Profile; preferences: ProfilePreferencesPatch }) => api.patch<Profile>(`/profiles/${v.profile.id}/preferences`, v.preferences),
    onSuccess: (saved) => {
      // The answer is the profile as it is now: shown before the list is read again, so that nothing flickers back.
      qc.setQueryData<Profile[]>(['profiles'], (shown) => shown?.map((p) => (p.id === saved.id ? saved : p)));
      recalculate();
    },
    onError: (e) => setError(errorText(e, t('prefsSaveFailed'))),
    onSettled: () => setSending(null),
  });
  const changePrefs = (profile: Profile, preferences: ProfilePreferencesPatch) => {
    setError(null);
    setSending({ id: profile.id, preferences });
    savePrefs.mutate({ profile, preferences });
  };
  /** The preferences of a profile as the page shows them: what is kept, with what is being sent on top. */
  const preferencesOf = (profile: Profile): Profile['preferences'] => (sending?.id === profile.id ? { ...profile.preferences, ...sending.preferences } : profile.preferences);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const f = new FormData(event.currentTarget);
    // The form says under the three shares what they add up to; a split that does not add up is not sent.
    if (!splitAddsUp(f)) {
      setError(t('splitSumRefused'));
      return;
    }
    save.mutate({
      name: String(f.get('name')),
      age: Number(f.get('age')),
      sex: (f.get('sex') as 'male' | 'female') || null,
      heightCm: Number(f.get('heightCm')),
      weightKg: weightTyped(f.get('weight'), editing?.weightKg) ?? 0,
      targetWeightKg: weightTyped(f.get('targetWeight'), editing?.targetWeightKg),
      activityLevel: f.get('activityLevel') as ProfileInput['activityLevel'],
      dietType: f.get('dietType') as ProfileInput['dietType'],
      // The split of the custom diet, as the form shows it; on another diet the profile keeps the one it has.
      customMacroSplit: splitIn(f, editing?.customMacroSplit ?? null),
      weeklyLossTarget: (f.get('weeklyLossTarget') as ProfileInput['weeklyLossTarget']) || null,
      manualCalorieTarget: f.get('manualCalorieTarget')
        ? Number(f.get('manualCalorieTarget'))
        : null,
      // Sent only by a form that showed the warning: ticked is yes, not ticked takes the word back.
      ...(risk.length > 0 ? { acknowledgeRisk: f.get('acknowledgeRisk') === 'on' } : {}),
      mealCount: Number(f.get('mealCount')),
      weightReminderCadence:
        (f.get('weightReminderCadence') as WeightReminderCadence) ?? 'weekly',
      // Preserve preferences on edit; new profiles start with an empty set
      // (the cap defaults mirror packages/shared/src/profile.ts).
      preferences: {
        ...(editing?.preferences ?? {
          favoriteIngredientIds: [],
          excludedIngredientIds: [],
          allergens: [],
          dislikedIngredientIds: [],
          preferredCuisines: [],
          maxConsecutiveDaysSameMeal: 2,
          maxTimesPerWeekSameMeal: 3,
          maxWeeklyAmountPerIngredient: DEFAULT_WEEKLY_AMOUNT_PER_INGREDIENT,
          inventoryBiasResetEvery: 5,
        }),
        maxConsecutiveDaysSameMeal: Number(f.get('maxConsecutiveDaysSameMeal')) || 2,
        maxTimesPerWeekSameMeal: Number(f.get('maxTimesPerWeekSameMeal')) || 3,
        maxWeeklyAmountPerIngredient: Number(f.get('maxWeeklyAmountPerIngredient')) || DEFAULT_WEEKLY_AMOUNT_PER_INGREDIENT,
        inventoryBiasResetEvery: Math.max(
          0,
          Math.min(20, Number(f.get('inventoryBiasResetEvery')) || 0),
        ),
      },
    });
  }

  function onDelete(p: Profile) {
    setError(null);
    if (window.confirm(t('deleteConfirm', { name: p.name }))) {
      remove.mutate(p.id);
    }
  }

  // Form is opt-in: shown only while editing an existing profile or after the
  // user explicitly clicks "Add profile".
  const showForm = editing !== null || creating;
  const canCreate = !creating && editing === null && !atLimit;

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">
          {t('subhead', { max: maxProfiles })}
        </p>
      </header>

      {/* A change that was refused outside the form (a preference, a profile that could not be deleted) is said here: the form shows its own. */}
      {error && !showForm && (
        <p role="alert" className="max-w-2xl text-sm text-destructive">
          {error}
        </p>
      )}

      {profiles.isLoading ? (
        <Skeleton className="h-24 max-w-2xl" />
      ) : profiles.isError ? (
        <LoadFailed error={profiles.error} onRetry={() => void profiles.refetch()} />
      ) : (
        list.length > 0 && (
          <div className="grid max-w-2xl gap-3 sm:grid-cols-2">
            {list.map((p) => (
              <Card key={p.id} className="flex flex-col gap-3 p-4">
                <div>
                  <p className="font-medium">{p.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {t('summary', {
                      age: p.age,
                      height: p.heightCm,
                      weight: fmt.unit(shownWeight(p.weightKg, unit), unit === 'lb' ? 'pound' : 'kilogram', 1),
                      dietType: tDiet(p.dietType),
                    })}
                  </p>
                </div>
                <div className="mt-auto flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setError(null);
                      setEditing(p);
                    }}
                  >
                    {tCommon('edit')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    onClick={() => onDelete(p)}
                    disabled={remove.isPending}
                  >
                    {tCommon('delete')}
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        )
      )}

      {/* The first profile of an account is set up step by step; one more is added in the form. */}
      {profiles.isSuccess && list.length === 0 && (
        <FirstProfile
          onMade={(first) => {
            setError(null);
            setMade(first);
          }}
        />
      )}

      {made && list.some((p) => p.id === made.id) && (
        <Card className="max-w-2xl border-primary/40">
          <CardHeader>
            <CardTitle>{tWizard('made', { name: made.name })}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">{tWizard('madeNext')}</p>
            <Link href={`/meal-plans?profile=${made.id}`} className={buttonVariants({ size: 'md' })}>
              {tWizard('madeCta')}
            </Link>
          </CardContent>
        </Card>
      )}

      {canCreate && list.length > 0 && (
        <div className="max-w-2xl">
          <Button
            type="button"
            onClick={() => {
              setError(null);
              setCreating(true);
            }}
          >
            {t('addProfile')}
          </Button>
        </div>
      )}

      {!showForm && atLimit && (
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t('atLimit', { max: maxProfiles })}
        </p>
      )}

      {showForm && (
        <Card className="max-w-2xl">
          <CardHeader>
            <CardTitle>{editing ? t('editing', { name: editing.name }) : t('newProfile')}</CardTitle>
          </CardHeader>
          <CardContent>
            {/* Re-mount on edit-target change so default values reset. */}
            <form
              key={formKey}
              ref={form}
              onSubmit={onSubmit}
              onChange={onChange}
              className="grid gap-4 sm:grid-cols-2"
            >
              <Field label={t('name')} hint={t('nameHint')}>
                <Input name="name" required pattern=".*\S.*" maxLength={80} defaultValue={editing?.name} />
              </Field>
              <BodyFields initial={editing ?? undefined} unit={unit} />
              <DietFields diet={editing?.dietType ?? 'balanced'} mealCount={editing?.mealCount ?? 3} split={editing?.customMacroSplit ?? null} />
              <PaceChoice initial={editing ? editing.weeklyLossTarget : '0.5'} paces={shown.preview?.paces} unit={unit} className="sm:col-span-2" />
              <Field label={t('targetWeight', { unit })} hint={t('targetWeightHint')}>
                <Input
                  key={unit}
                  name="targetWeight"
                  type="number"
                  inputMode="decimal"
                  min={weightBounds.min}
                  max={weightBounds.max}
                  step="0.1"
                  defaultValue={editing?.targetWeightKg != null ? shownToOne(editing.targetWeightKg, unit) : ''}
                />
              </Field>
              <OwnTargetField initial={editing?.manualCalorieTarget ?? null} />
              <RiskBox reasons={risk} acknowledged={editing?.riskAcknowledgedAt != null} className="sm:col-span-2" />
              <Field
                label={t('weightReminderCadence')}
                hint={t('weightReminderCadenceHint')}
              >
                <select
                  name="weightReminderCadence"
                  defaultValue={editing?.weightReminderCadence ?? 'weekly'}
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="off">{t('weightReminderOff')}</option>
                  <option value="daily">{t('weightReminderDaily')}</option>
                  <option value="weekly">{t('weightReminderWeekly')}</option>
                </select>
              </Field>
              <Field label={t('maxConsecutiveDaysSameMeal')} hint={t('maxConsecutiveDaysSameMealHint')}>
                <Input
                  name="maxConsecutiveDaysSameMeal"
                  type="number"
                  required
                  min={1}
                  max={7}
                  defaultValue={editing?.preferences.maxConsecutiveDaysSameMeal ?? 2}
                />
              </Field>
              <Field label={t('maxTimesPerWeekSameMeal')} hint={t('maxTimesPerWeekSameMealHint')}>
                <Input
                  name="maxTimesPerWeekSameMeal"
                  type="number"
                  required
                  min={1}
                  max={7}
                  defaultValue={editing?.preferences.maxTimesPerWeekSameMeal ?? 3}
                />
              </Field>
              <Field label={t('maxWeeklyAmountPerIngredient')} hint={t('maxWeeklyAmountPerIngredientHint')}>
                <Input
                  name="maxWeeklyAmountPerIngredient"
                  type="number"
                  required
                  min={MIN_WEEKLY_AMOUNT_PER_INGREDIENT}
                  max={MAX_WEEKLY_AMOUNT_PER_INGREDIENT}
                  step={100}
                  defaultValue={editing?.preferences.maxWeeklyAmountPerIngredient ?? DEFAULT_WEEKLY_AMOUNT_PER_INGREDIENT}
                />
              </Field>
              <Field
                label={t('inventoryBiasResetEvery')}
                hint={t('inventoryBiasResetEveryHint')}
              >
                <Input
                  name="inventoryBiasResetEvery"
                  type="number"
                  required
                  min={0}
                  max={20}
                  defaultValue={editing?.preferences.inventoryBiasResetEvery ?? 5}
                />
              </Field>
              <CaloriePreviewPanel {...shown} className="sm:col-span-2" />
              <div className="flex items-center gap-3 sm:col-span-2">
                <Button type="submit" disabled={save.isPending}>
                  {save.isPending
                    ? t('saving')
                    : editing
                      ? t('saveChanges')
                      : t('createProfile')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setError(null);
                    setEditing(null);
                    setCreating(false);
                  }}
                >
                  {tCommon('cancel')}
                </Button>
                {error && <p className="text-sm text-destructive">{error}</p>}
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {list.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold tracking-tight">{t('preferencesTitle')}</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">{t('preferencesSubhead')}</p>
          {list.map((p) => (
            <Card key={`prefs-${p.id}`} className="max-w-2xl">
              <CardHeader>
                <CardTitle className="text-base">{p.name}</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-6 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <AllergenPicker
                    label={t('allergensLabel')}
                    hint={t('allergensHint')}
                    selected={preferencesOf(p).allergens}
                    disabled={savePrefs.isPending}
                    onChange={(allergens) =>
                      changePrefs(p, { allergens })
                    }
                  />
                </div>
                <IngredientPicker
                  label={t('favouritesLabel')}
                  hint={t('favouritesHint')}
                  ids={preferencesOf(p).favoriteIngredientIds}
                  disabled={savePrefs.isPending}
                  onChange={(ids) =>
                    changePrefs(p, { favoriteIngredientIds: ids })
                  }
                />
                <fieldset className="space-y-1.5 sm:col-span-2">
                  <legend className="text-sm font-medium">{t('cuisinesLabel')}</legend>
                  <p className="text-xs text-muted-foreground">{t('cuisinesHint')}</p>
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    {CUISINES.map((cuisine) => (
                      <label key={cuisine} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="h-4 w-4"
                          checked={preferencesOf(p).preferredCuisines.includes(cuisine)}
                          disabled={savePrefs.isPending}
                          onChange={(e) =>
                            // In the order the application lists them, whatever order they were ticked in.
                            changePrefs(p, { preferredCuisines: CUISINES.filter((other) => (other === cuisine ? e.target.checked : preferencesOf(p).preferredCuisines.includes(other))) })
                          }
                        />
                        {tCuisine(cuisine)}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <IngredientPicker
                  label={t('dislikedLabel')}
                  hint={t('dislikedHint')}
                  ids={preferencesOf(p).dislikedIngredientIds}
                  disabled={savePrefs.isPending}
                  onChange={(ids) =>
                    changePrefs(p, { dislikedIngredientIds: ids })
                  }
                />
                <IngredientPicker
                  label={t('avoidLabel')}
                  hint={t('avoidHint')}
                  ids={preferencesOf(p).excludedIngredientIds}
                  disabled={savePrefs.isPending}
                  onChange={(ids) =>
                    changePrefs(p, { excludedIngredientIds: ids })
                  }
                />
              </CardContent>
            </Card>
          ))}
        </section>
      )}
    </div>
  );
}
