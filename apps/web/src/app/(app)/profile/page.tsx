// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import {
  DEFAULT_WEEKLY_AMOUNT_PER_INGREDIENT,
  MAX_CALORIE_TARGET,
  DEFAULT_PROFILES_PER_ACCOUNT,
  MAX_WEEKLY_AMOUNT_PER_INGREDIENT,
  MIN_CALORIE_TARGET,
  MIN_WEEKLY_AMOUNT_PER_INGREDIENT,
  riskOfLosingWeight,
  type DietType,
  type Profile,
  type ProfileInput,
  type ProfilePreferencesPatch,
  type WeightReminderCadence,
  SPLIT_SHARE_LIMITS,
  type MacroSplit,
} from '@diet-app/shared';
import { api } from '@/lib/api';
import { NAMED_DIETS, supplyOf } from '@/lib/catalogue';
import { useConfig } from '@/lib/use-config';
import { useErrorText } from '@/lib/use-error-text';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AllergenPicker } from '@/components/allergen-picker';
import { IngredientPicker } from '@/components/ingredient-picker';
import { Field, Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { SupplyNote } from '@/components/supply-note';
import { LoadFailed } from '@/components/load-failed';

type Risk = ReturnType<typeof riskOfLosingWeight>[number];

/** The risk a loss goal carries for a body, or none when no loss is asked for. */
function riskOf(body: { age: number; heightCm: number; weightKg: number; weeklyLossTarget: string | null; manualCalorieTarget: number | null }): Risk[] {
  const asksForLoss = body.weeklyLossTarget !== null || body.manualCalorieTarget !== null;
  if (!asksForLoss || !(body.age > 0 && body.heightCm > 0 && body.weightKg > 0)) return [];
  return riskOfLosingWeight(body);
}

/** The same, for what the form holds at this moment. */
function riskIn(form: HTMLFormElement): Risk[] {
  const f = new FormData(form);
  return riskOf({
    age: Number(f.get('age')),
    heightCm: Number(f.get('heightCm')),
    weightKg: Number(f.get('weightKg')),
    weeklyLossTarget: String(f.get('weeklyLossTarget') ?? '') || null,
    manualCalorieTarget: f.get('manualCalorieTarget') ? Number(f.get('manualCalorieTarget')) : null,
  });
}

const selectClass = 'h-10 w-full rounded-md border border-input bg-background px-3 text-sm';

const ACTIVITY_LEVELS = [
  'sedentary',
  'light',
  'moderate',
  'active',
  'very_active',
] as const;

/** Profile manager — create, edit and delete the account's profiles. */
export default function ProfilePage() {
  const t = useTranslations('profile');
  const tCommon = useTranslations('common');
  const tDiet = useTranslations('enums.dietType');
  const tActivity = useTranslations('enums.activityLevel');
  const tSex = useTranslations('enums.sex');
  const errorText = useErrorText();
  const qc = useQueryClient();
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: () => api.get<Profile[]>('/profiles') });
  const [error, setError] = useState<string | null>(null);
  // null = the form creates a new profile; a Profile = the form edits it.
  const [editing, setEditing] = useState<Profile | null>(null);
  // Why losing weight is a risk for the body the form describes, when it asks
  // for a loss: as typed, or as saved while nothing was typed yet.
  const [typedRisk, setTypedRisk] = useState<{ form: string; reasons: Risk[] } | null>(null);
  const formKey = editing?.id ?? 'new';
  const risk = typedRisk?.form === formKey ? typedRisk.reasons : editing ? riskOf(editing) : [];
  // Creation is opt-in: the form stays hidden until the user clicks "Add".
  const [creating, setCreating] = useState(false);

  const list = profiles.data ?? [];
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
  const savePrefs = useMutation({
    mutationFn: (v: { profile: Profile; preferences: ProfilePreferencesPatch }) => api.patch<Profile>(`/profiles/${v.profile.id}/preferences`, v.preferences),
    onSuccess: recalculate,
    onError: (e) =>
      setError(errorText(e, t('prefsSaveFailed'))),
  });

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const f = new FormData(event.currentTarget);
    // The form says under the three shares what they add up to; a split that does not add up is not sent.
    if (f.get('dietType') === 'custom' && Number(f.get('splitProtein')) + Number(f.get('splitFat')) + Number(f.get('splitCarbs')) !== 100) {
      setError(t('splitSumRefused'));
      return;
    }
    save.mutate({
      name: String(f.get('name')),
      age: Number(f.get('age')),
      sex: (f.get('sex') as 'male' | 'female') || null,
      heightCm: Number(f.get('heightCm')),
      weightKg: Number(f.get('weightKg')),
      activityLevel: f.get('activityLevel') as ProfileInput['activityLevel'],
      dietType: f.get('dietType') as ProfileInput['dietType'],
      // The split of the custom diet, as the form shows it; on another diet the profile keeps the one it has.
      customMacroSplit:
        f.get('dietType') === 'custom'
          ? { protein: Number(f.get('splitProtein')), fat: Number(f.get('splitFat')), carbs: Number(f.get('splitCarbs')) }
          : (editing?.customMacroSplit ?? null),
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
          dislikedFoods: [],
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
                      weight: p.weightKg,
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

      {canCreate && (
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
              key={editing?.id ?? 'new'}
              onSubmit={onSubmit}
              onChange={(event) => setTypedRisk({ form: formKey, reasons: riskIn(event.currentTarget) })}
              className="grid gap-4 sm:grid-cols-2"
            >
              <Field label={t('name')}>
                <Input name="name" required placeholder="Default" defaultValue={editing?.name} />
              </Field>
              <Field label={t('age')}>
                <Input
                  name="age"
                  type="number"
                  required
                  min={13}
                  max={120}
                  defaultValue={editing?.age ?? 30}
                />
              </Field>
              <Field label={t('sex')}>
                <select name="sex" className={selectClass} defaultValue={editing?.sex ?? ''}>
                  <option value="">{t('preferNotToSay')}</option>
                  <option value="male">{tSex('male')}</option>
                  <option value="female">{tSex('female')}</option>
                </select>
              </Field>
              <Field label={t('heightCm')}>
                <Input
                  name="heightCm"
                  type="number"
                  required
                  min={100}
                  max={250}
                  defaultValue={editing?.heightCm ?? 175}
                />
              </Field>
              <Field label={t('weightKg')}>
                <Input
                  name="weightKg"
                  type="number"
                  required
                  min={30}
                  max={400}
                  defaultValue={editing?.weightKg ?? 75}
                />
              </Field>
              <Field label={t('activityLevel')}>
                <select
                  name="activityLevel"
                  className={selectClass}
                  defaultValue={editing?.activityLevel ?? 'moderate'}
                >
                  {ACTIVITY_LEVELS.map((a) => (
                    <option key={a} value={a}>
                      {tActivity(a)}
                    </option>
                  ))}
                </select>
              </Field>
              <DietAndMealCount diet={editing?.dietType ?? 'balanced'} mealCount={editing?.mealCount ?? 3} split={editing?.customMacroSplit ?? null} />
              <Field label={t('weeklyLossTarget')}>
                <select
                  name="weeklyLossTarget"
                  className={selectClass}
                  defaultValue={editing?.weeklyLossTarget ?? '0.5'}
                >
                  <option value="">{t('maintain')}</option>
                  <option value="0.25">0.25</option>
                  <option value="0.5">0.5</option>
                  <option value="0.75">0.75</option>
                  <option value="1.0">1.0</option>
                </select>
              </Field>
              <Field label={t('manualKcalOverride')}>
                <Input
                  name="manualCalorieTarget"
                  type="number"
                  min={MIN_CALORIE_TARGET}
                  max={MAX_CALORIE_TARGET}
                  placeholder={t('auto')}
                  defaultValue={editing?.manualCalorieTarget ?? ''}
                />
              </Field>
              {risk.length > 0 && (
                <div className="space-y-2 rounded-lg border border-warning/40 bg-warning/5 px-4 py-3 text-sm sm:col-span-2">
                  {risk.map((reason) => (
                    <p key={reason}>{t(`risk.${reason}`)}</p>
                  ))}
                  <p className="text-muted-foreground">{t('risk.held')}</p>
                  <label className="flex items-start gap-2 font-medium">
                    <input type="checkbox" name="acknowledgeRisk" className="mt-1" defaultChecked={editing?.riskAcknowledgedAt != null} />
                    {t('risk.acknowledge')}
                  </label>
                </div>
              )}
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
                    selected={p.preferences.allergens}
                    disabled={savePrefs.isPending}
                    onChange={(allergens) =>
                      savePrefs.mutate({
                        profile: p,
                        preferences: { allergens },
                      })
                    }
                  />
                </div>
                <IngredientPicker
                  label={t('favouritesLabel')}
                  hint={t('favouritesHint')}
                  ids={p.preferences.favoriteIngredientIds}
                  disabled={savePrefs.isPending}
                  onChange={(ids) =>
                    savePrefs.mutate({
                      profile: p,
                      preferences: { favoriteIngredientIds: ids },
                    })
                  }
                />
                <IngredientPicker
                  label={t('avoidLabel')}
                  hint={t('avoidHint')}
                  ids={p.preferences.excludedIngredientIds}
                  disabled={savePrefs.isPending}
                  onChange={(ids) =>
                    savePrefs.mutate({
                      profile: p,
                      preferences: { excludedIngredientIds: ids },
                    })
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

/** The split a profile that goes to the custom diet begins with: the balanced diet's. */
const A_FIRST_SPLIT: MacroSplit = { protein: 25, fat: 30, carbs: 45 };

/**
 * The diet and the number of meals a day. Each diet is marked when the
 * catalogue has no recipe, or few, for one of that many meals, and the chosen
 * pair gets a line saying what that means for a plan. The custom diet asks for
 * its split: how much of a day's energy comes from protein, fat and
 * carbohydrate.
 */
function DietAndMealCount(initial: { diet: DietType; mealCount: number; split: MacroSplit | null }) {
  const t = useTranslations('profile');
  const tCatalogue = useTranslations('catalogue');
  const tDiet = useTranslations('enums.dietType');
  const depth = useConfig().data?.catalogue.depth;
  // The fields stay the form's own; these follow them for the marks.
  const [diet, setDiet] = useState(initial.diet);
  const [mealCount, setMealCount] = useState(initial.mealCount);
  const diets: readonly DietType[] = [...NAMED_DIETS, 'custom'];
  // The three shares as they are typed, so that the form can say what they add up to before it is sent.
  const [split, setSplit] = useState<Record<keyof MacroSplit, string>>(() => {
    const first = initial.split ?? A_FIRST_SPLIT;
    return { protein: String(first.protein), fat: String(first.fat), carbs: String(first.carbs) };
  });
  const sum = Number(split.protein) + Number(split.fat) + Number(split.carbs);
  return (
    <>
      <Field label={t('dietType')}>
        <select
          name="dietType"
          className={selectClass}
          defaultValue={initial.diet}
          onChange={(e) => setDiet(e.target.value as DietType)}
        >
          {diets.map((d) => {
            const supply = supplyOf(depth, d, mealCount)?.supply;
            return (
              <option key={d} value={d}>
                {supply === 'none'
                  ? tCatalogue('dietNone', { diet: tDiet(d) })
                  : supply === 'thin'
                    ? tCatalogue('dietThin', { diet: tDiet(d) })
                    : tDiet(d)}
              </option>
            );
          })}
        </select>
      </Field>
      <Field label={t('mealsPerDay')}>
        <Input
          name="mealCount"
          type="number"
          required
          min={2}
          max={5}
          defaultValue={initial.mealCount}
          onChange={(e) => setMealCount(e.target.valueAsNumber)}
        />
      </Field>
      <SupplyNote diet={diet} mealCount={mealCount} className="sm:col-span-2" />
      {diet === 'custom' && (
        <fieldset className="space-y-2 sm:col-span-2">
          <legend className="text-sm font-medium">{t('customSplit')}</legend>
          <p className="text-xs text-muted-foreground">{t('customSplitHint')}</p>
          <div className="grid grid-cols-3 gap-3">
            {(['protein', 'fat', 'carbs'] as const).map((part) => (
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
            ))}
          </div>
          {/* Said while it is typed: a form that is refused for its sum should have said the sum. */}
          <p aria-live="polite" className={sum === 100 ? 'text-xs text-muted-foreground' : 'text-xs text-warning'}>
            {t(sum === 100 ? 'splitSum' : 'splitSumOff', { sum })}
          </p>
        </fieldset>
      )}
    </>
  );
}
