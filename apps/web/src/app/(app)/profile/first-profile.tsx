// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { Allergen, Profile, ProfileInput, WeightReminderCadence } from '@diet-app/shared';
import { api } from '@/lib/api';
import { useProfileForm } from '@/lib/use-profile-form';
import { useErrorText } from '@/lib/use-error-text';
import { boundsIn, toKilograms, useWeightUnit } from '@/lib/weight-unit';
import { AllergenPicker } from '@/components/allergen-picker';
import { CaloriePreviewPanel, useCaloriePreview } from '@/components/calorie-preview';
import { BodyFields, DietFields, OwnTargetField, PaceChoice, RiskBox, splitAddsUp, splitIn } from '@/components/profile-fields';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/** The steps, in the order they are gone through. */
const STEPS = ['body', 'goal', 'food'] as const;
const LAST = STEPS.length - 1;

/** What a new profile is made with, as the form sends it: what it leaves out, the API starts at its default. */
type NewProfile = Omit<ProfileInput, 'preferences'> & { preferences: { allergens: Allergen[] } };

/**
 * The first profile of an account, set up in three steps: the body, the
 * goal, and how its owner eats. One form holds all three, a step at a time,
 * so that going back finds everything as it was left. Beside it stand the
 * figures that what is typed comes to, and each pace of loss says what it
 * means for a day before it is chosen. Nothing is kept before the last step.
 */
export function FirstProfile({ onMade }: { onMade: (made: Profile) => void }) {
  const t = useTranslations('profile');
  const tWizard = useTranslations('profile.wizard');
  const tCommon = useTranslations('common');
  const errorText = useErrorText();
  const qc = useQueryClient();
  const unit = useWeightUnit();
  const weightBounds = boundsIn(unit);

  const { form, typed, onChange } = useProfileForm('first', unit);
  const risk = typed?.reasons ?? [];
  const heading = useRef<HTMLHeadingElement>(null);
  const [step, setStep] = useState(0);
  // The allergens are chosen in a picker, not typed into a field of the form.
  const [allergens, setAllergens] = useState<Allergen[]>([]);
  const [error, setError] = useState<string | null>(null);
  const shown = useCaloriePreview(typed?.figures ?? null);

  const save = useMutation({
    mutationFn: (input: NewProfile) => api.post<Profile>('/profiles', input),
    onSuccess: (made) => {
      void qc.invalidateQueries({ queryKey: ['profiles'] });
      void qc.invalidateQueries({ queryKey: ['calories'] });
      onMade(made);
    },
    onError: (e) => setError(errorText(e, t('saveFailed'))),
  });

  /** The first field of a step that the browser would refuse, if there is one. */
  const refusedIn = (index: number): HTMLInputElement | HTMLSelectElement | undefined =>
    [...(form.current?.querySelectorAll<HTMLInputElement | HTMLSelectElement>(`[data-step="${index}"] input, [data-step="${index}"] select`) ?? [])].find((field) => !field.checkValidity());

  /**
   * Show a step. It is on the screen before this returns: the browser says
   * nothing of a field that is not shown, so a step is shown before its field
   * is pointed at. Its heading takes the focus, so that a screen reader says
   * where the reader now is.
   */
  const go = (to: number): void => {
    setError(null);
    flushSync(() => setStep(to));
    heading.current?.focus();
  };

  const next = (): void => {
    const refused = refusedIn(step);
    if (refused) refused.reportValidity();
    else go(step + 1);
  };

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Enter in a field of an earlier step goes on to the next one.
    if (step < LAST) return next();
    const behindStep = STEPS.findIndex((_, index) => refusedIn(index) !== undefined);
    if (behindStep !== -1) {
      if (behindStep !== step) go(behindStep);
      refusedIn(behindStep)?.reportValidity();
      return;
    }
    const f = new FormData(event.currentTarget);
    // The form says under the three shares what they add up to; a split that does not add up is not sent.
    if (!splitAddsUp(f)) return setError(t('splitSumRefused'));
    setError(null);
    const targetWeight = String(f.get('targetWeight') ?? '').trim();
    save.mutate({
      name: String(f.get('name')).trim(),
      age: Number(f.get('age')),
      sex: (f.get('sex') as 'male' | 'female') || null,
      heightCm: Number(f.get('heightCm')),
      weightKg: toKilograms(Number(f.get('weight')), unit),
      targetWeightKg: targetWeight === '' ? null : toKilograms(Number(targetWeight), unit),
      activityLevel: f.get('activityLevel') as ProfileInput['activityLevel'],
      dietType: f.get('dietType') as ProfileInput['dietType'],
      customMacroSplit: splitIn(f, null),
      weeklyLossTarget: (f.get('weeklyLossTarget') as ProfileInput['weeklyLossTarget']) || null,
      manualCalorieTarget: f.get('manualCalorieTarget') ? Number(f.get('manualCalorieTarget')) : null,
      // Sent only by a form that showed the warning: ticked is yes, not ticked is no.
      ...(risk.length > 0 ? { acknowledgeRisk: f.get('acknowledgeRisk') === 'on' } : {}),
      mealCount: Number(f.get('mealCount')),
      weightReminderCadence: 'weekly' satisfies WeightReminderCadence,
      preferences: { allergens },
    });
  }

  return (
    <Card className="max-w-4xl">
      <CardHeader>
        <CardTitle>{tWizard('title')}</CardTitle>
        <p className="text-sm text-muted-foreground">{tWizard('intro')}</p>
      </CardHeader>
      <CardContent className="space-y-6">
        <ol className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          {STEPS.map((name, index) => (
            <li key={name} aria-current={index === step ? 'step' : undefined} className={cn('flex items-center gap-2', index === step ? 'font-medium text-foreground' : 'text-muted-foreground')}>
              <span className={cn('flex h-6 w-6 items-center justify-center rounded-full border text-xs tabular-nums', index === step ? 'border-primary bg-primary text-primary-foreground' : index < step ? 'border-primary text-primary' : 'border-border')}>
                {index + 1}
              </span>
              {tWizard(`steps.${name}`)}
            </li>
          ))}
        </ol>

        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_19rem]">
          {/* The browser's own check is asked for step by step: it has nothing to say of a field on a step that is not shown. */}
          <form ref={form} noValidate onSubmit={onSubmit} onChange={onChange} className="space-y-4">
            <h4 ref={heading} tabIndex={-1} className="text-base font-semibold tracking-tight focus:outline-none">
              {tWizard('progress', { step: step + 1, of: STEPS.length, name: tWizard(`steps.${STEPS[step]!}`) })}
            </h4>

            <fieldset data-step={0} hidden={step !== 0} className="space-y-4">
              <legend className="sr-only">{tWizard('steps.body')}</legend>
              <p className="text-sm text-muted-foreground">{tWizard('bodyLead')}</p>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t('name')} hint={t('nameHint')}>
                  <Input name="name" required pattern=".*\S.*" maxLength={80} autoComplete="given-name" />
                </Field>
                <BodyFields unit={unit} />
              </div>
            </fieldset>

            <fieldset data-step={1} hidden={step !== 1} className="space-y-4">
              <legend className="sr-only">{tWizard('steps.goal')}</legend>
              <p className="text-sm text-muted-foreground">{tWizard('goalLead')}</p>
              <PaceChoice initial="0.5" paces={shown.preview?.paces} unit={unit} />
              <RiskBox reasons={risk} acknowledged={false} />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t('targetWeight', { unit })} hint={t('targetWeightHint')}>
                  <Input key={unit} name="targetWeight" type="number" inputMode="decimal" min={weightBounds.min} max={weightBounds.max} step="0.1" />
                </Field>
                <OwnTargetField initial={null} />
              </div>
            </fieldset>

            <fieldset data-step={2} hidden={step !== 2} className="space-y-4">
              <legend className="sr-only">{tWizard('steps.food')}</legend>
              <p className="text-sm text-muted-foreground">{tWizard('foodLead')}</p>
              <div className="grid gap-4 sm:grid-cols-2">
                <DietFields diet="balanced" mealCount={3} split={null} />
                <div className="sm:col-span-2">
                  <AllergenPicker label={t('allergensLabel')} hint={t('allergensHint')} selected={allergens} disabled={save.isPending} onChange={setAllergens} />
                </div>
              </div>
            </fieldset>

            <div className="flex flex-wrap items-center gap-3">
              {step > 0 && (
                <Button type="button" variant="outline" onClick={() => go(step - 1)} disabled={save.isPending}>
                  {tCommon('back')}
                </Button>
              )}
              {/* One button goes on and, on the last step, makes the profile. A double click is one press: its second half would make the profile on a step nobody has read. */}
              <Button
                type="submit"
                disabled={save.isPending}
                onClick={(event) => {
                  if (event.detail > 1) event.preventDefault();
                }}
              >
                {step < LAST ? tCommon('next') : save.isPending ? t('saving') : t('createProfile')}
              </Button>
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
            </div>
          </form>

          <CaloriePreviewPanel {...shown} className="lg:sticky lg:top-6" />
        </div>
      </CardContent>
    </Card>
  );
}
