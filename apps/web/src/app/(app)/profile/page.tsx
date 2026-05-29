'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { MAX_PROFILES_PER_ACCOUNT, type Profile, type ProfileInput } from '@diet-app/shared';
import { api, ApiClientError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { IngredientPicker } from '@/components/ingredient-picker';
import { Field, Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

const selectClass = 'h-10 w-full rounded-md border border-border bg-background px-3 text-sm';

const DIET_TYPES = [
  'balanced',
  'high_protein',
  'low_carb',
  'vegetarian',
  'vegan',
  'keto',
  'mediterranean',
] as const;

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
  const qc = useQueryClient();
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: () => api.get<Profile[]>('/profiles') });
  const [error, setError] = useState<string | null>(null);
  // null = the form creates a new profile; a Profile = the form edits it.
  const [editing, setEditing] = useState<Profile | null>(null);

  const list = profiles.data ?? [];
  const atLimit = list.length >= MAX_PROFILES_PER_ACCOUNT;

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
    },
    onError: (e) =>
      setError(e instanceof ApiClientError ? e.message : t('saveFailed')),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete<void>(`/profiles/${id}`),
    onSuccess: () => {
      recalculate();
      setEditing(null);
    },
    onError: (e) =>
      setError(e instanceof ApiClientError ? e.message : t('deleteFailed')),
  });

  // Save updated preferences in place: the PUT endpoint is full-replace, so
  // we send every existing field of the profile back, only swapping prefs.
  const savePrefs = useMutation({
    mutationFn: (v: { profile: Profile; preferences: Profile['preferences'] }) =>
      api.put<Profile>(`/profiles/${v.profile.id}`, {
        name: v.profile.name,
        age: v.profile.age,
        sex: v.profile.sex,
        heightCm: v.profile.heightCm,
        weightKg: v.profile.weightKg,
        activityLevel: v.profile.activityLevel,
        dietType: v.profile.dietType,
        weeklyLossTarget: v.profile.weeklyLossTarget,
        manualCalorieTarget: v.profile.manualCalorieTarget,
        mealCount: v.profile.mealCount,
        preferences: v.preferences,
      }),
    onSuccess: recalculate,
    onError: (e) =>
      setError(e instanceof ApiClientError ? e.message : t('prefsSaveFailed')),
  });

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const f = new FormData(event.currentTarget);
    save.mutate({
      name: String(f.get('name')),
      age: Number(f.get('age')),
      sex: (f.get('sex') as 'male' | 'female') || null,
      heightCm: Number(f.get('heightCm')),
      weightKg: Number(f.get('weightKg')),
      activityLevel: f.get('activityLevel') as ProfileInput['activityLevel'],
      dietType: f.get('dietType') as ProfileInput['dietType'],
      weeklyLossTarget: (f.get('weeklyLossTarget') as ProfileInput['weeklyLossTarget']) || null,
      manualCalorieTarget: f.get('manualCalorieTarget')
        ? Number(f.get('manualCalorieTarget'))
        : null,
      mealCount: Number(f.get('mealCount')),
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
        }),
        maxConsecutiveDaysSameMeal: Number(f.get('maxConsecutiveDaysSameMeal')) || 2,
        maxTimesPerWeekSameMeal: Number(f.get('maxTimesPerWeekSameMeal')) || 3,
      },
    });
  }

  function onDelete(p: Profile) {
    setError(null);
    if (window.confirm(t('deleteConfirm', { name: p.name }))) {
      remove.mutate(p.id);
    }
  }

  // Show the form when editing, or when there is room for another profile.
  const showForm = editing !== null || !atLimit;

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">
          {t('subhead', { max: MAX_PROFILES_PER_ACCOUNT })}
        </p>
      </header>

      {profiles.isLoading ? (
        <Skeleton className="h-24 max-w-2xl" />
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

      {!showForm && (
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t('atLimit', { max: MAX_PROFILES_PER_ACCOUNT })}
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
              <Field label={t('dietType')}>
                <select
                  name="dietType"
                  className={selectClass}
                  defaultValue={editing?.dietType ?? 'balanced'}
                >
                  {DIET_TYPES.map((d) => (
                    <option key={d} value={d}>
                      {tDiet(d)}
                    </option>
                  ))}
                </select>
              </Field>
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
                  min={800}
                  max={6000}
                  placeholder={t('auto')}
                  defaultValue={editing?.manualCalorieTarget ?? ''}
                />
              </Field>
              <Field label={t('mealsPerDay')}>
                <Input
                  name="mealCount"
                  type="number"
                  required
                  min={2}
                  max={5}
                  defaultValue={editing?.mealCount ?? 3}
                />
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
              <div className="flex items-center gap-3 sm:col-span-2">
                <Button type="submit" disabled={save.isPending}>
                  {save.isPending
                    ? t('saving')
                    : editing
                      ? t('saveChanges')
                      : t('createProfile')}
                </Button>
                {editing && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setError(null);
                      setEditing(null);
                    }}
                  >
                    {tCommon('cancel')}
                  </Button>
                )}
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
                <IngredientPicker
                  label={t('favouritesLabel')}
                  hint={t('favouritesHint')}
                  ids={p.preferences.favoriteIngredientIds}
                  disabled={savePrefs.isPending}
                  onChange={(ids) =>
                    savePrefs.mutate({
                      profile: p,
                      preferences: { ...p.preferences, favoriteIngredientIds: ids },
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
                      preferences: { ...p.preferences, excludedIngredientIds: ids },
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
