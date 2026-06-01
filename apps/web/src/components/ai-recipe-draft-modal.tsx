'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type {
  AiDraftRecipeRequest,
  AiDraftRecipeResponse,
  DietType,
  MealType,
  Profile,
} from '@diet-app/shared';
import { api, ApiClientError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';

const DIET_TYPES: DietType[] = [
  'balanced',
  'high_protein',
  'low_carb',
  'vegetarian',
  'vegan',
  'keto',
  'mediterranean',
];
const MEAL_TYPES: MealType[] = [
  'breakfast',
  'second_breakfast',
  'lunch',
  'snack',
  'dinner',
];

const selectClass = 'h-10 w-full rounded-md border border-border bg-background px-3 text-sm';

/**
 * Modal that drafts a brand-new recipe from a user prompt. AI authors the
 * structure + ingredient choices; the backend recomputes nutrition before
 * persist. On success the new recipe lands in the user's favourites tagged
 * `ai-drafted` and the parent re-fetches the recipe list.
 */
export function AiRecipeDraftModal({
  profile,
  onClose,
  onCreated,
}: {
  profile: Profile;
  onClose: () => void;
  onCreated: (recipeId: string) => void;
}) {
  const qc = useQueryClient();
  const t = useTranslations('aiRecipeDraft');
  const tCommon = useTranslations('common');
  const tDiet = useTranslations('enums.dietType');
  const tMeal = useTranslations('enums.mealType');
  const [prompt, setPrompt] = useState('');
  const [mealType, setMealType] = useState<MealType | ''>('');
  const [dietType, setDietType] = useState<DietType>(profile.dietType);
  const [servings, setServings] = useState('2');
  const [addToFavorites, setAddToFavorites] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const draft = useMutation({
    mutationFn: () => {
      const body: AiDraftRecipeRequest = {
        profileId: profile.id,
        prompt: prompt.trim(),
        mealType: mealType || undefined,
        dietType,
        servings: servings ? Math.max(1, Math.min(12, Number(servings))) : undefined,
        addToFavorites,
      };
      return api.post<AiDraftRecipeResponse>('/recipes/drafts/from-prompt', body);
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['recipes'] });
      qc.invalidateQueries({ queryKey: ['favorites'] });
      qc.invalidateQueries({ queryKey: ['ai-quota'] });
      onCreated(res.recipe.id);
      onClose();
    },
    onError: (e) => setError(e instanceof ApiClientError ? e.message : t('failed')),
  });

  const submitDisabled = draft.isPending || prompt.trim().length < 3;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl rounded-lg border border-border bg-background shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border p-4">
          <div className="flex items-center gap-2">
            <Sparkles size={16} className="text-primary" aria-hidden />
            <h2 className="font-semibold">{t('title')}</h2>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            {tCommon('close')}
          </Button>
        </div>

        <div className="space-y-4 p-4">
          <Field label={t('promptLabel')}>
            <textarea
              className="min-h-24 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t('promptPlaceholder')}
              maxLength={500}
            />
            <p className="mt-1 text-xs text-muted-foreground">{t('promptHelp')}</p>
          </Field>

          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('dietType')}>
              <select
                className={selectClass}
                value={dietType}
                onChange={(e) => setDietType(e.target.value as DietType)}
              >
                {DIET_TYPES.map((d) => (
                  <option key={d} value={d}>
                    {tDiet(d)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('mealType')}>
              <select
                className={selectClass}
                value={mealType}
                onChange={(e) => setMealType(e.target.value as MealType | '')}
              >
                <option value="">{t('any')}</option>
                {MEAL_TYPES.map((m) => (
                  <option key={m} value={m}>
                    {tMeal(m)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('servings')}>
              <Input
                type="number"
                min={1}
                max={12}
                value={servings}
                onChange={(e) => setServings(e.target.value)}
              />
            </Field>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={addToFavorites}
              onChange={(e) => setAddToFavorites(e.target.checked)}
            />
            {t('addToFavorites')}
          </label>

          <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            {t('determinismHint')}
          </p>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              {tCommon('cancel')}
            </Button>
            <Button
              type="button"
              disabled={submitDisabled}
              onClick={() => {
                setError(null);
                draft.mutate();
              }}
            >
              <Sparkles size={14} aria-hidden />
              <span className="ml-1">{draft.isPending ? t('drafting') : t('submit')}</span>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
