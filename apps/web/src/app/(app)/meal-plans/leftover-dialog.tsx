// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type {
  LeftoverOffer,
  MealPlan,
  MealType,
  PlannedMeal,
  RebalanceResult,
} from '@diet-app/shared';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { localDate } from '@/lib/http';
import { useErrorText } from '@/lib/use-error-text';
import { useFormat } from '@/lib/use-format';
import { useCookingWords } from './cooking';
import { ListNote } from './list-note';

/** The parts of a portion that may be left, as the window offers them, and their names. */
const PARTS = [
  [0.75, 'threeQuarters'],
  [0.5, 'half'],
  [0.25, 'quarter'],
] as const;

/** What one person says is left of their portion: all of it, a part chosen, or two weights typed. */
interface Left {
  eaten: boolean;
  part: number | 'weight' | null;
  whole: string;
  left: string;
}

/** A number above nothing typed in a field, a comma taken for a point; null for anything else. */
const typed = (text: string): number | null => {
  const value = Number(text.trim().replace(',', '.'));
  return text.trim() !== '' && Number.isFinite(value) && value > 0 ? value : null;
};

/** The part of the portion left, from what is said of it; null while that says none yet, or two weights say none that can be. */
function partLeft(said: Left): number | null {
  if (!said.eaten) return 1;
  if (said.part === null) return null;
  if (said.part !== 'weight') return said.part;
  const whole = typed(said.whole);
  const left = typed(said.left);
  return whole !== null && left !== null && left < whole ? left / whole : null;
}

/** Two weights typed that cannot be: what is left is no less than the whole. */
const wrongWeights = (said: Left): boolean => {
  const whole = typed(said.whole);
  const left = typed(said.left);
  return said.eaten && said.part === 'weight' && whole !== null && left !== null && left >= whole;
};

const shown = (servings: number): number => Math.round(servings * 10) / 10;

/**
 * The window that puts what is left of a meal in as a meal of the next day, in
 * the place of the dish at a time of day chosen. It says first whether anything
 * of the meal was eaten: nothing, and the meal leaves its day with the whole
 * portion going; a part, and the meal stays marked eaten with the part eaten,
 * what is left told as a part of the portion or by two weights. Of a shared
 * meal, the other person's portion may go as well, with what is left of it.
 */
export function LeftoverDialog({
  plan,
  meal,
  date,
  onClose,
  onDone,
}: {
  plan: MealPlan;
  meal: PlannedMeal;
  /** The day of the meal. */
  date: string;
  onClose: () => void;
  /** Told what the plan came to, where the leftover went as a sentence, and the plan and day it went to. */
  onDone: (result: RebalanceResult, notice: string, to: { planId: string; date: string }) => void;
}) {
  const t = useTranslations('mealPlans.leftover');
  const tCommon = useTranslations('common');
  const tMeal = useTranslations('enums.mealType');
  const fmt = useFormat();
  const words = useCookingWords();
  const errorText = useErrorText();
  const path = `/meal-plans/${plan.id}/meals/${meal.id}/leftover`;
  const offer = useQuery({
    queryKey: ['leftover', plan.id, meal.id],
    queryFn: () => api.get<LeftoverOffer>(path),
    gcTime: 0,
    retry: false,
  });
  const fresh = (eaten: boolean): Left => ({ eaten, part: null, whole: '', left: '' });
  const [mine, setMine] = useState<Left>(() => fresh(meal.eatenAt !== null));
  const [theirs, setTheirs] = useState<Left>(() => fresh(meal.shared?.with.eaten ?? false));
  // For both while the other person has not marked their portion eaten, unless the user says otherwise.
  const [forAllSaid, setForAll] = useState<boolean | null>(null);
  const [mealType, setMealType] = useState<MealType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const said = offer.data;
  const other = said?.other ?? null;
  const forAll = other !== null && (forAllSaid ?? !other.eaten);
  const places =
    said?.places.filter((place) => !forAll || other!.places.includes(place.mealType)) ?? [];
  const chosen = places.find((place) => place.mealType === mealType) ?? null;
  const myLeft = partLeft(mine);
  const theirLeft = forAll ? partLeft(theirs) : 1;
  const name = (mealType: string): string => (tMeal.has(mealType) ? tMeal(mealType) : mealType);
  const today = localDate();

  const put = useMutation({
    mutationFn: () =>
      api.post<RebalanceResult>(path, {
        mealType: chosen!.mealType,
        left: myLeft!,
        ...(forAll ? { forAll: true, theirLeft: theirLeft! } : {}),
      }),
    onSuccess: (result) => {
      const when = words.on(said!.date, chosen!.mealType);
      onDone(result, t(said!.planId === plan.id ? 'done' : 'doneOtherPlan', when), {
        planId: said!.planId,
        date: said!.date,
      });
      onClose();
    },
    onError: (e: unknown) => setError(errorText(e, t('errPut'))),
  });
  const ready = chosen !== null && myLeft !== null && theirLeft !== null && !put.isPending;

  return (
    <Dialog open onClose={onClose} label={t('title')} className="max-w-lg">
      <div className="flex items-center justify-between gap-2 border-b border-border p-4">
        <div>
          <h2 className="font-semibold">{t('title')}</h2>
          <p className="text-xs text-muted-foreground">
            {name(meal.mealType)}, {fmt.day(date)}
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {tCommon('close')}
        </Button>
      </div>
      <form
        className="space-y-4 p-4 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          if (ready) put.mutate();
        }}
      >
        <p className="text-muted-foreground">
          {t('intro', { title: fmt.text(meal.recipe?.title ?? meal.customName ?? '') })}
        </p>
        {offer.isPending ? (
          <div className="space-y-2" role="status" aria-label={t('loading')}>
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-5 w-1/2" />
          </div>
        ) : offer.isError ? (
          <p role="alert" className="text-destructive">
            {errorText(offer.error, t('errOffer'))}
          </p>
        ) : (
          <>
            <PortionLeft
              legend={t('eatenLegend')}
              portion={said!.portion}
              said={mine}
              onSay={setMine}
              name={`${meal.id}-mine`}
            />
            {other && (
              <label className="flex min-h-6 items-center gap-2">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={forAll}
                  onChange={(e) => setForAll(e.target.checked)}
                />
                {t('forAll', { name: fmt.text(other.profileName) })}
              </label>
            )}
            {other && forAll && (
              <PortionLeft
                legend={t('eatenLegendOf', { name: fmt.text(other.profileName) })}
                portion={other.portion}
                said={theirs}
                onSay={setTheirs}
                name={`${meal.id}-theirs`}
              />
            )}
            <fieldset className="space-y-2">
              <legend className="font-medium">
                {t('placeLegend', { day: fmt.day(said!.date) })}
              </legend>
              {places.map((place) => {
                const apart = words.apart(
                  {
                    cookAhead: place.cookAhead,
                    cooking: { with: place.cookedWith, ingredients: [] },
                    mealType: place.mealType,
                  },
                  said!.date,
                  today,
                );
                return (
                  <div key={place.mealType}>
                    <label className="flex min-h-6 items-start gap-2">
                      <input
                        type="radio"
                        name={`${meal.id}-place`}
                        className="mt-0.5 h-4 w-4 shrink-0"
                        checked={mealType === place.mealType}
                        onChange={() => setMealType(place.mealType)}
                      />
                      <span>
                        {t('place', {
                          meal: name(place.mealType),
                          name: fmt.text(place.name),
                          kcal: place.calories,
                        })}
                      </span>
                    </label>
                    {place.sharedWith && !forAll && (
                      <p className="ml-6 text-xs text-muted-foreground">
                        {t('placeShared', { name: place.sharedWith })}
                      </p>
                    )}
                    {apart && <p className="ml-6 text-xs text-muted-foreground">{apart}</p>}
                  </div>
                );
              })}
            </fieldset>
            {myLeft !== null && (
              <div className="space-y-1 text-muted-foreground">
                <p>
                  {myLeft === 1
                    ? t('summaryGone')
                    : t('summaryKept', {
                        servings: shown((1 - myLeft) * said!.portion.servings),
                        kcal: Math.round((1 - myLeft) * said!.portion.calories),
                      })}
                </p>
                <p>
                  {t('summaryDay', {
                    servings: shown(myLeft * said!.portion.servings),
                    kcal: Math.round(myLeft * said!.portion.calories),
                  })}
                </p>
                <ListNote
                  listed={plan.days.find((day) => day.date === said!.date)?.listed === true}
                />
              </div>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            {tCommon('cancel')}
          </Button>
          <Button type="submit" size="sm" disabled={!ready}>
            {t('submit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** What one person says of their portion: whether anything of it was eaten, and how much is left. */
function PortionLeft({
  legend,
  portion,
  said,
  onSay,
  name,
}: {
  legend: string;
  portion: LeftoverOffer['portion'];
  said: Left;
  onSay: (said: Left) => void;
  /** What the radio buttons of this person are grouped by. */
  name: string;
}) {
  const t = useTranslations('mealPlans.leftover');
  const share = partLeft(said);
  return (
    <fieldset className="space-y-2">
      <legend className="font-medium">{legend}</legend>
      {[false, true].map((eaten) => (
        <label key={String(eaten)} className="flex min-h-6 items-center gap-2">
          <input
            type="radio"
            name={`${name}-eaten`}
            className="h-4 w-4"
            checked={said.eaten === eaten}
            onChange={() => onSay({ ...said, eaten })}
          />
          {t(eaten ? 'part' : 'nothing')}
        </label>
      ))}
      {said.eaten && (
        <fieldset className="ml-6 space-y-2">
          <legend className="text-muted-foreground">{t('leftLegend')}</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {[...PARTS, ['weight', 'byWeight'] as const].map(([part, label]) => (
              <label key={String(part)} className="inline-flex min-h-6 items-center gap-1.5">
                <input
                  type="radio"
                  name={`${name}-part`}
                  className="h-4 w-4"
                  checked={said.part === part}
                  onChange={() => onSay({ ...said, part })}
                />
                {t(label)}
              </label>
            ))}
          </div>
          {said.part === 'weight' && (
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('wholeWeight')}>
                <Input
                  inputMode="decimal"
                  value={said.whole}
                  onChange={(e) => onSay({ ...said, whole: e.target.value })}
                />
              </Field>
              <Field
                label={t('leftWeight')}
                error={wrongWeights(said) ? t('weightWrong') : undefined}
              >
                <Input
                  inputMode="decimal"
                  value={said.left}
                  aria-invalid={wrongWeights(said)}
                  onChange={(e) => onSay({ ...said, left: e.target.value })}
                />
              </Field>
              {share !== null && (
                <p className="col-span-2 text-muted-foreground">
                  {t('weightShare', {
                    percent: Math.round(share * 100),
                    kcal: Math.round(share * portion.calories),
                  })}
                </p>
              )}
            </div>
          )}
        </fieldset>
      )}
    </fieldset>
  );
}

/**
 * The window that undoes a leftover not eaten: the dish it replaced comes back,
 * and so does the meal it was left of. A leftover made for both people is
 * undone for both, or for this person alone.
 */
export function LeftoverUndoDialog({
  planId,
  meal,
  onClose,
  onDone,
}: {
  planId: string;
  meal: PlannedMeal;
  onClose: () => void;
  onDone: (result: RebalanceResult) => void;
}) {
  const t = useTranslations('mealPlans.leftover');
  const tCommon = useTranslations('common');
  const errorText = useErrorText();
  const [error, setError] = useState<string | null>(null);
  const both = meal.shared !== null && !meal.shared.with.eaten;
  const undo = useMutation({
    mutationFn: (forAll: boolean) =>
      api.delete<RebalanceResult>(
        `/meal-plans/${planId}/meals/${meal.id}/leftover${forAll ? '?forAll=true' : ''}`,
      ),
    onSuccess: (result) => {
      onDone(result);
      onClose();
    },
    onError: (e: unknown) => setError(errorText(e, t('errUndo'))),
  });
  return (
    <Dialog open onClose={onClose} label={t('undoTitle')} className="max-w-md">
      <div className="space-y-3 p-4 text-sm">
        <h2 className="font-semibold">{t('undoTitle')}</h2>
        <p>{t('undoNote')}</p>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            {tCommon('cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={both ? 'outline' : 'primary'}
            onClick={() => undo.mutate(false)}
            disabled={undo.isPending}
          >
            {t(both ? 'undoForMe' : 'undo')}
          </Button>
          {both && (
            <Button
              type="button"
              size="sm"
              onClick={() => undo.mutate(true)}
              disabled={undo.isPending}
            >
              {t('undoForAll')}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
