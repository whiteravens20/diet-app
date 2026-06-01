'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type {
  AiDraftRecipeRequest,
  AiDraftRecipeResponse,
  CookingMethod,
  Complexity,
  Cuisine,
  DietType,
  MealType,
  Profile,
} from '@diet-app/shared';
import { api, ApiClientError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/input';

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
const CUISINES: Cuisine[] = [
  'polish',
  'italian',
  'asian',
  'mediterranean',
  'middle_eastern',
  'mexican',
  'american',
  'indian',
];
const COOKING_METHODS: CookingMethod[] = [
  'baked',
  'grilled',
  'pan_fried',
  'boiled',
  'steamed',
  'stewed',
  'raw',
  'no_cook',
];
const COMPLEXITIES: Complexity[] = ['simple', 'medium', 'complex'];

const selectClass = 'h-10 w-full rounded-md border border-border bg-background px-3 text-sm';

/**
 * Draft a brand-new recipe from structured filters (F20). No free-text input:
 * every preference is a fixed enum or numeric, so there's no prompt-injection
 * surface and every catalogue slug the AI returns is still validated against
 * the live `Ingredient` table. Filters are soft hints — the backend lets the
 * model broaden when an intersection is too narrow. Allergens are always
 * respected; everything else is optional and may stay blank, in which case
 * the AI picks freely.
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
  const tCuisine = useTranslations('enums.cuisine');
  const tCooking = useTranslations('enums.cookingMethod');
  const tComplexity = useTranslations('enums.complexity');
  const [mealType, setMealType] = useState<MealType | ''>('');
  const [dietType, setDietType] = useState<DietType>(profile.dietType);
  const [cuisine, setCuisine] = useState<Cuisine | ''>('');
  const [cookingMethod, setCookingMethod] = useState<CookingMethod | ''>('');
  const [complexity, setComplexity] = useState<Complexity | ''>('');
  const [kcalTarget, setKcalTarget] = useState<number>(500);
  const [kcalTargetEnabled, setKcalTargetEnabled] = useState(false);
  const [prepTimeMaxMinutes, setPrepTimeMaxMinutes] = useState<number>(45);
  const [prepTimeEnabled, setPrepTimeEnabled] = useState(false);
  const [useFavoriteIngredients, setUseFavoriteIngredients] = useState(false);
  const [respectExclusions, setRespectExclusions] = useState(true);
  const [addToFavorites, setAddToFavorites] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const draft = useMutation({
    mutationFn: () => {
      const body: AiDraftRecipeRequest = {
        profileId: profile.id,
        mealType: mealType || undefined,
        dietType,
        cuisine: cuisine || undefined,
        cookingMethod: cookingMethod || undefined,
        complexity: complexity || undefined,
        kcalTarget: kcalTargetEnabled ? kcalTarget : undefined,
        prepTimeMaxMinutes: prepTimeEnabled ? prepTimeMaxMinutes : undefined,
        useFavoriteIngredients,
        respectExclusions,
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

  const favouritesCount = profile.preferences?.favoriteIngredientIds?.length ?? 0;
  const exclusionsCount = profile.preferences?.excludedIngredientIds?.length ?? 0;
  const allergensCount = profile.preferences?.allergens?.length ?? 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-lg border border-border bg-background shadow-lg"
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

        <div className="max-h-[70vh] space-y-4 overflow-y-auto p-4">
          <p className="text-xs text-muted-foreground">{t('subhead')}</p>

          <div className="grid gap-3 sm:grid-cols-2">
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
            <Field label={t('cuisine')}>
              <select
                className={selectClass}
                value={cuisine}
                onChange={(e) => setCuisine(e.target.value as Cuisine | '')}
              >
                <option value="">{t('any')}</option>
                {CUISINES.map((c) => (
                  <option key={c} value={c}>
                    {tCuisine(c)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('cookingMethod')}>
              <select
                className={selectClass}
                value={cookingMethod}
                onChange={(e) => setCookingMethod(e.target.value as CookingMethod | '')}
              >
                <option value="">{t('any')}</option>
                {COOKING_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {tCooking(m)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('complexity')}>
              <select
                className={selectClass}
                value={complexity}
                onChange={(e) => setComplexity(e.target.value as Complexity | '')}
              >
                <option value="">{t('any')}</option>
                {COMPLEXITIES.map((c) => (
                  <option key={c} value={c}>
                    {tComplexity(c)}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <fieldset className="space-y-3 rounded-md border border-border bg-muted/30 p-3">
            <legend className="px-1 text-xs font-medium text-muted-foreground">
              {t('targetsLegend')}
            </legend>
            <SliderRow
              enabled={kcalTargetEnabled}
              onEnabledChange={setKcalTargetEnabled}
              label={t('kcalTarget')}
              value={kcalTarget}
              onValueChange={setKcalTarget}
              min={200}
              max={1200}
              step={50}
              unit={t('kcalUnit')}
            />
            <SliderRow
              enabled={prepTimeEnabled}
              onEnabledChange={setPrepTimeEnabled}
              label={t('prepTimeMax')}
              value={prepTimeMaxMinutes}
              onValueChange={setPrepTimeMaxMinutes}
              min={5}
              max={120}
              step={5}
              unit={t('minutesUnit')}
            />
          </fieldset>

          <fieldset className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
            <legend className="px-1 text-xs font-medium text-muted-foreground">
              {t('profilePrefsLegend')}
            </legend>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4"
                checked={useFavoriteIngredients}
                onChange={(e) => setUseFavoriteIngredients(e.target.checked)}
                disabled={favouritesCount === 0}
              />
              <span className="flex flex-col">
                <span>{t('useFavoriteIngredients')}</span>
                <span className="text-xs text-muted-foreground">
                  {favouritesCount === 0
                    ? t('useFavoriteIngredientsEmpty')
                    : t('useFavoriteIngredientsCount', { count: favouritesCount })}
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4"
                checked={respectExclusions}
                onChange={(e) => setRespectExclusions(e.target.checked)}
                disabled={exclusionsCount === 0}
              />
              <span className="flex flex-col">
                <span>{t('respectExclusions')}</span>
                <span className="text-xs text-muted-foreground">
                  {exclusionsCount === 0
                    ? t('respectExclusionsEmpty')
                    : t('respectExclusionsCount', { count: exclusionsCount })}
                </span>
              </span>
            </label>
            {allergensCount > 0 && (
              <p className="text-xs text-muted-foreground">
                {t('allergensAlwaysRespected', { count: allergensCount })}
              </p>
            )}
          </fieldset>

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
              disabled={draft.isPending}
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

function SliderRow({
  enabled,
  onEnabledChange,
  label,
  value,
  onValueChange,
  min,
  max,
  step,
  unit,
}: {
  enabled: boolean;
  onEnabledChange: (v: boolean) => void;
  label: string;
  value: number;
  onValueChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  unit: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="h-4 w-4"
          checked={enabled}
          onChange={(e) => onEnabledChange(e.target.checked)}
        />
        <span className="flex-1">{label}</span>
        {enabled && (
          <span className="text-xs tabular-nums text-muted-foreground">
            {value} {unit}
          </span>
        )}
      </label>
      {enabled && (
        <input
          type="range"
          className="w-full"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onValueChange(Number(e.target.value))}
        />
      )}
    </div>
  );
}
