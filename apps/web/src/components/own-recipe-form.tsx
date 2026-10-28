// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Plus, Trash } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useState } from 'react';
import type {
  Cuisine,
  Difficulty,
  Ingredient,
  MealType,
  OwnRecipeInput,
  OwnRecipePreview,
  Recipe,
  Unit,
} from '@diet-app/shared';
import { CUISINES, RECIPE_LIMITS } from '@diet-app/shared/constants';
import { api } from '@/lib/api';
import { ApiClientError } from '@/lib/http';
import { useErrorText } from '@/lib/use-error-text';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';

const MEAL_TYPES: MealType[] = ['breakfast', 'second_breakfast', 'lunch', 'snack', 'dinner'];
const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard'];
/** How long the form waits after the last change before it asks what a serving would hold. */
const PREVIEW_DELAY_MS = 400;

const selectClass = 'h-10 w-full rounded-md border border-input bg-background px-3 text-sm';

/** What an ingredient line needs to know about its ingredient: its name and the units it can be measured in. */
type LineIngredient = Pick<Ingredient, 'id' | 'name' | 'recipeUnits'>;

/** One line as it is typed: the amount stays text while somebody types it. */
interface Line {
  key: number;
  ingredient: LineIngredient;
  quantity: string;
  unit: Unit;
  note: string;
}

/** What the form starts with: empty for a new recipe, the recipe's own for an edit. */
export interface OwnRecipeDraft {
  title: string;
  description: string;
  steps: string[];
  servings: number;
  mealTypes: MealType[];
  prepMinutes: number;
  cookMinutes: number;
  difficulty: Difficulty;
  cuisine: Cuisine | null;
  ingredients: { ingredient: LineIngredient; quantity: number; unit: Unit; note: string | null }[];
}

export const EMPTY_RECIPE: OwnRecipeDraft = {
  title: '',
  description: '',
  steps: [''],
  servings: 1,
  mealTypes: [],
  prepMinutes: 10,
  cookMinutes: 0,
  difficulty: 'easy',
  cuisine: null,
  ingredients: [],
};

/** A field named by the place the API gives a problem, as the form names it. */
type Problem = { path: string; rule: string };

/**
 * The form a recipe of one's own is written or edited in. The text is in the
 * language of the page; the ingredients come from the catalogue, and what a
 * serving holds, its allergens and its diets are worked out from them as the
 * recipe is written. Saved, it opens the recipe; an edit opens the new
 * version.
 */
export function OwnRecipeForm({
  initial,
  editing,
}: {
  initial: OwnRecipeDraft;
  /** The recipe being edited; none for a new one. */
  editing?: string;
}) {
  const t = useTranslations('ownRecipe');
  const tDetail = useTranslations('recipeDetail');
  const tCommon = useTranslations('common');
  const tMeal = useTranslations('enums.mealType');
  const tDifficulty = useTranslations('enums.difficulty');
  const tCuisine = useTranslations('enums.cuisine');
  const tAllergen = useTranslations('enums.allergen');
  const tDiet = useTranslations('enums.dietType');
  const errorText = useErrorText();
  const router = useRouter();
  const qc = useQueryClient();
  const ids = useId();

  const [title, setTitle] = useState(initial.title);
  const [description, setDescription] = useState(initial.description);
  const [steps, setSteps] = useState<string[]>(initial.steps.length ? initial.steps : ['']);
  const [servings, setServings] = useState(String(initial.servings));
  const [mealTypes, setMealTypes] = useState<MealType[]>(initial.mealTypes);
  const [prepMinutes, setPrepMinutes] = useState(String(initial.prepMinutes));
  const [cookMinutes, setCookMinutes] = useState(String(initial.cookMinutes));
  const [difficulty, setDifficulty] = useState<Difficulty>(initial.difficulty);
  const [cuisine, setCuisine] = useState<Cuisine | ''>(initial.cuisine ?? '');
  const [lines, setLines] = useState<Line[]>(() =>
    initial.ingredients.map((line, key) => ({
      key,
      ingredient: line.ingredient,
      quantity: String(line.quantity),
      unit: line.unit,
      note: line.note ?? '',
    })),
  );
  const [nextKey, setNextKey] = useState(initial.ingredients.length);
  const [search, setSearch] = useState('');
  const [problems, setProblems] = useState<Problem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [yours, setYours] = useState<string | null>(null);

  const found = useQuery({
    queryKey: ['ingredients-search', search],
    queryFn: () => api.get<Ingredient[]>(`/ingredients?search=${encodeURIComponent(search)}`),
    enabled: search.trim().length >= 2,
  });

  // What a serving holds is asked for once the amounts are numbers, a moment after the last change.
  const portions = Math.trunc(Number(servings));
  const measured = lines.map((line) => ({
    ingredientId: line.ingredient.id,
    quantity: Number(line.quantity.replace(',', '.')),
    unit: line.unit,
  }));
  const complete =
    lines.length > 0 &&
    portions >= 1 &&
    portions <= RECIPE_LIMITS.servings &&
    measured.every((line) => Number.isFinite(line.quantity) && line.quantity > 0);
  const previewKey = JSON.stringify([portions, measured]);
  const [asked, setAsked] = useState<string | null>(null);
  useEffect(() => {
    if (!complete) return;
    const timer = setTimeout(() => setAsked(previewKey), PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [complete, previewKey]);
  const preview = useQuery({
    queryKey: ['own-recipe-preview', asked],
    queryFn: () =>
      api.post<OwnRecipePreview>('/recipes/preview', {
        servings: portions,
        ingredients: measured,
      }),
    enabled: complete && asked === previewKey,
    retry: false,
  });

  const save = useMutation({
    mutationFn: () => {
      const body: OwnRecipeInput = {
        title,
        description,
        steps: steps.filter((step) => step.trim() !== ''),
        servings: portions,
        mealTypes,
        prepMinutes: Math.trunc(Number(prepMinutes)),
        cookMinutes: Math.trunc(Number(cookMinutes)),
        difficulty,
        cuisine: cuisine || null,
        ingredients: lines.map((line, index) => ({
          ...measured[index]!,
          note: line.note.trim() === '' ? null : line.note,
        })),
      };
      return editing
        ? api.put<Recipe>(`/recipes/${editing}`, body)
        : api.post<Recipe>('/recipes', body);
    },
    onSuccess: (recipe) => {
      void qc.invalidateQueries({ queryKey: ['recipes'] });
      void qc.invalidateQueries({ queryKey: ['recipes:mine'] });
      void qc.invalidateQueries({ queryKey: ['favorites'] });
      // The version an edit replaced is gone: it is not asked for again.
      router.push(`/recipes/${recipe.id}`);
    },
    onError: (e) => {
      const details = e instanceof ApiClientError ? e.details : undefined;
      setProblems(
        e instanceof ApiClientError && e.code === 'RECIPE_INVALID'
          ? ((details?.problems as Problem[] | undefined) ?? [])
          : [],
      );
      setYours(
        e instanceof ApiClientError && e.code === 'RECIPE_ALREADY_YOURS'
          ? String(details?.recipeId ?? '')
          : null,
      );
      setError(errorText(e, t('failed')));
    },
  });

  const addIngredient = (ingredient: Ingredient) => {
    setLines((now) => [
      ...now,
      {
        key: nextKey,
        ingredient,
        quantity: '',
        unit: ingredient.recipeUnits[0]!,
        note: '',
      },
    ]);
    setNextKey((key) => key + 1);
    setSearch('');
  };
  const changeLine = (key: number, change: Partial<Line>) =>
    setLines((now) => now.map((line) => (line.key === key ? { ...line, ...change } : line)));
  const moveStep = (index: number, by: -1 | 1) =>
    setSteps((now) => {
      const next = [...now];
      [next[index], next[index + by]] = [next[index + by]!, next[index]!];
      return next;
    });

  /** Where a problem the API named is, in the words of the form. */
  const placeOf = (path: string): string => {
    if (path.startsWith('titles.')) return t('fieldTitle');
    if (path.startsWith('descriptions.')) return t('fieldDescription');
    const step = /^steps\.[a-z]+\[(\d+)\]/.exec(path);
    if (step) return t('stepNumber', { n: Number(step[1]) + 1 });
    if (path.startsWith('steps.')) return tDetail('steps');
    const line = /^ingredients\[(\d+)\]/.exec(path);
    if (line) return lines[Number(line[1])]?.ingredient.name ?? tDetail('ingredients');
    return path;
  };
  const reasonOf = (rule: string): string =>
    rule === 'markup'
      ? t('problemMarkup')
      : rule === 'text-too-long'
        ? t('problemTooLong')
        : rule === 'quantity-too-large'
          ? t('problemTooMuch')
          : rule === 'missing-locale' || rule === 'missing-field'
            ? t('problemMissing')
            : t('problemOther');

  const results = (found.data ?? []).slice(0, 12);
  const ready =
    title.trim() !== '' &&
    description.trim() !== '' &&
    steps.some((step) => step.trim() !== '') &&
    mealTypes.length > 0 &&
    complete;

  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        setProblems([]);
        setYours(null);
        save.mutate();
      }}
    >
      <Field label={t('fieldTitle')}>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={RECIPE_LIMITS.title}
          required
        />
      </Field>
      <Field label={t('fieldDescription')}>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={RECIPE_LIMITS.description}
          required
          rows={3}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
      </Field>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t('fieldMeals')}</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {MEAL_TYPES.map((meal) => (
            <label key={meal} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={mealTypes.includes(meal)}
                onChange={(e) =>
                  setMealTypes((now) =>
                    e.target.checked ? [...now, meal] : now.filter((m) => m !== meal),
                  )
                }
              />
              {tMeal(meal)}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={tDetail('servings')}>
          <Input
            type="number"
            min={1}
            max={RECIPE_LIMITS.servings}
            value={servings}
            onChange={(e) => setServings(e.target.value)}
            required
          />
        </Field>
        <Field label={t('fieldPrep')}>
          <Input
            type="number"
            min={0}
            max={RECIPE_LIMITS.minutes}
            value={prepMinutes}
            onChange={(e) => setPrepMinutes(e.target.value)}
            required
          />
        </Field>
        <Field label={t('fieldCook')}>
          <Input
            type="number"
            min={0}
            max={RECIPE_LIMITS.minutes}
            value={cookMinutes}
            onChange={(e) => setCookMinutes(e.target.value)}
            required
          />
        </Field>
        <Field label={t('fieldDifficulty')}>
          <select
            value={difficulty}
            onChange={(e) => setDifficulty(e.target.value as Difficulty)}
            className={selectClass}
          >
            {DIFFICULTIES.map((d) => (
              <option key={d} value={d}>
                {tDifficulty(d)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('fieldCuisine')}>
          <select
            value={cuisine}
            onChange={(e) => setCuisine(e.target.value as Cuisine | '')}
            className={selectClass}
          >
            <option value="">{t('cuisineNone')}</option>
            {CUISINES.map((c) => (
              <option key={c} value={c}>
                {tCuisine(c)}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">{tDetail('ingredients')}</legend>
        {lines.length === 0 && (
          <p className="text-xs text-muted-foreground">{t('noIngredients')}</p>
        )}
        <ul className="space-y-3">
          {lines.map((line) => (
            <li
              key={line.key}
              className="grid grid-cols-[1fr_auto] gap-2 rounded-md border border-border p-3 sm:grid-cols-[minmax(0,1fr)_6rem_6rem_minmax(0,1fr)_auto] sm:items-end"
            >
              <p className="col-span-2 self-center text-sm font-medium sm:col-span-1">
                {line.ingredient.name}
              </p>
              <Field label={t('fieldAmount')}>
                <Input
                  inputMode="decimal"
                  value={line.quantity}
                  onChange={(e) => changeLine(line.key, { quantity: e.target.value })}
                  required
                  aria-label={t('amountOf', { name: line.ingredient.name })}
                />
              </Field>
              <Field label={t('fieldUnit')}>
                <select
                  value={line.unit}
                  onChange={(e) => changeLine(line.key, { unit: e.target.value as Unit })}
                  className={selectClass}
                  aria-label={t('unitOf', { name: line.ingredient.name })}
                >
                  {line.ingredient.recipeUnits.map((unit) => (
                    <option key={unit} value={unit}>
                      {unit === 'piece' ? t('unitPiece') : unit}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('fieldNote')}>
                <Input
                  value={line.note}
                  onChange={(e) => changeLine(line.key, { note: e.target.value })}
                  maxLength={RECIPE_LIMITS.note}
                  aria-label={t('noteOf', { name: line.ingredient.name })}
                />
              </Field>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setLines((now) => now.filter((l) => l.key !== line.key))}
                aria-label={t('removeIngredient', { name: line.ingredient.name })}
                title={t('removeIngredient', { name: line.ingredient.name })}
                className="self-end"
              >
                <Trash size={14} aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
        {lines.length < RECIPE_LIMITS.ingredients && (
          <div className="space-y-2">
            <Field label={t('addIngredient')} hint={t('searchHint')}>
              <Input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-controls={search.trim().length >= 2 ? `${ids}-found` : undefined}
              />
            </Field>
            {search.trim().length >= 2 && (
              <ul id={`${ids}-found`} className="flex flex-wrap gap-2">
                {results.map((ingredient) => (
                  <li key={ingredient.id}>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => addIngredient(ingredient)}
                    >
                      <Plus size={14} aria-hidden />
                      <span className="ml-1">{ingredient.name}</span>
                    </Button>
                  </li>
                ))}
                {found.isSuccess && results.length === 0 && (
                  <li className="text-xs text-muted-foreground">{t('nothingFound')}</li>
                )}
              </ul>
            )}
          </div>
        )}
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">{tDetail('steps')}</legend>
        <p className="text-xs text-muted-foreground">{t('allergenHint')}</p>
        <ol className="space-y-3">
          {steps.map((step, index) => (
            <li key={index} className="flex items-start gap-2">
              <textarea
                value={step}
                onChange={(e) =>
                  setSteps((now) => now.map((s, i) => (i === index ? e.target.value : s)))
                }
                maxLength={RECIPE_LIMITS.step}
                rows={2}
                aria-label={t('stepNumber', { n: index + 1 })}
                className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
              />
              <div className="flex flex-col">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={index === 0}
                  onClick={() => moveStep(index, -1)}
                  aria-label={t('stepUp', { n: index + 1 })}
                  title={t('stepUp', { n: index + 1 })}
                >
                  <ArrowUp size={14} aria-hidden />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={index === steps.length - 1}
                  onClick={() => moveStep(index, 1)}
                  aria-label={t('stepDown', { n: index + 1 })}
                  title={t('stepDown', { n: index + 1 })}
                >
                  <ArrowDown size={14} aria-hidden />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={steps.length === 1}
                  onClick={() => setSteps((now) => now.filter((_, i) => i !== index))}
                  aria-label={t('removeStep', { n: index + 1 })}
                  title={t('removeStep', { n: index + 1 })}
                >
                  <Trash size={14} aria-hidden />
                </Button>
              </div>
            </li>
          ))}
        </ol>
        {steps.length < RECIPE_LIMITS.steps && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setSteps((now) => [...now, ''])}
          >
            <Plus size={14} aria-hidden />
            <span className="ml-1">{t('addStep')}</span>
          </Button>
        )}
      </fieldset>

      <section
        aria-labelledby={`${ids}-serving`}
        aria-live="polite"
        className="space-y-1 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm"
      >
        <h2 id={`${ids}-serving`} className="font-medium">
          {tDetail('perServing')}
        </h2>
        {!complete || !preview.data ? (
          <p className="text-xs text-muted-foreground">
            {preview.isError ? errorText(preview.error) : t('previewWaiting')}
          </p>
        ) : (
          <>
            <p className="tabular-nums">
              {t('previewFigures', {
                kcal: preview.data.nutritionPerServing.calories,
                protein: preview.data.nutritionPerServing.protein,
                fat: preview.data.nutritionPerServing.fat,
                carbs: preview.data.nutritionPerServing.carbs,
              })}
            </p>
            <p className="text-xs text-muted-foreground">
              {preview.data.allergens.length === 0
                ? t('previewNoAllergens')
                : `${tDetail('allergens')} ${preview.data.allergens.map((a) => tAllergen(a)).join(', ')}`}
            </p>
            {preview.data.dietTags.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {t('previewDiets', {
                  diets: preview.data.dietTags.map((d) => tDiet(d)).join(', '),
                })}
              </p>
            )}
          </>
        )}
      </section>

      {(error || problems.length > 0) && (
        <div role="alert" className="space-y-1 text-sm text-destructive">
          {error && <p>{error}</p>}
          {problems.length > 0 && (
            <ul className="list-inside list-disc">
              {problems.map((problem) => (
                <li key={problem.path}>
                  {placeOf(problem.path)}: {reasonOf(problem.rule)}
                </li>
              ))}
            </ul>
          )}
          {yours && (
            <Link href={`/recipes/${yours}`} className="underline underline-offset-2">
              {t('openYours')}
            </Link>
          )}
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        <Link
          href={editing ? `/recipes/${editing}` : '/recipes'}
          className="px-3 text-sm text-muted-foreground underline-offset-2 hover:underline"
        >
          {tCommon('cancel')}
        </Link>
        <Button type="submit" disabled={!ready || save.isPending}>
          {save.isPending ? t('saving') : t('save')}
        </Button>
      </div>
    </form>
  );
}
