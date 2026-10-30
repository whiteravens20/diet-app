// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import type {
  CreateDiaryEntryRequest,
  Ingredient,
  MealType,
  Recipe,
  RecipeSearchPage,
  Unit,
} from '@diet-app/shared';
import {
  DIARY_QUANTITY_LIMITS,
  MEAL_SLOTS_BY_COUNT,
  OWN_MEAL_LIMITS,
} from '@diet-app/shared/constants';
import { api } from '@/lib/api';
import { useUnitName } from '@/lib/ingredient-format';
import { useFormat } from '@/lib/use-format';
import { useSettled } from '@/lib/use-settled';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/input';

/** An entry as the window makes it: the page adds whose diary and which day. */
type NewEntry = CreateDiaryEntryRequest extends infer Entry
  ? Entry extends unknown
    ? Omit<Entry, 'profileId' | 'date'>
    : never
  : never;

type Kind = NewEntry['kind'];

const selectClass =
  'w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring';

/** How many of what a search finds are offered. */
const OFFERED = 8;

/**
 * The window an entry is added to a day of the diary in: a recipe of the
 * library or of the account's own in servings, an ingredient of the catalogue
 * in an amount of a unit it can be given in, or a meal of one's own by its
 * figures, those of the macronutrients left empty estimated by the API. What
 * the entry adds to the day is said before it is added where the window knows
 * it; the API works out the rest.
 */
export function AddEntryDialog({
  meal,
  date,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  meal: MealType;
  date: string;
  busy: boolean;
  /** Why the API refused what was sent, said in the window. */
  error: string | null;
  onClose: () => void;
  onSubmit: (entry: NewEntry) => void;
}) {
  const t = useTranslations('diary');
  const tCommon = useTranslations('common');
  const tMeal = useTranslations('enums.mealType');
  const fmt = useFormat();
  const unitName = useUnitName();
  const id = useId();

  const [kind, setKind] = useState<Kind>('recipe');
  const [mealType, setMealType] = useState<MealType>(meal);
  const [search, setSearch] = useState('');
  const asked = useSettled(search.trim(), 300);
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [ingredient, setIngredient] = useState<Ingredient | null>(null);
  const [servings, setServings] = useState('1');
  const [quantity, setQuantity] = useState('');
  const [unit, setUnit] = useState<Unit>('g');
  const [name, setName] = useState('');
  const [calories, setCalories] = useState('');
  const [protein, setProtein] = useState('');
  const [fat, setFat] = useState('');
  const [carbs, setCarbs] = useState('');

  // Only the search in the field is said anything of: what an earlier one found is not an answer to this one.
  const searching = asked.length >= 2 && asked === search.trim();
  const recipes = useQuery({
    queryKey: ['diary-recipes', asked],
    queryFn: () =>
      api.get<RecipeSearchPage>(`/recipes?search=${encodeURIComponent(asked)}&pageSize=${OFFERED}`),
    enabled: kind === 'recipe' && recipe === null && searching,
  });
  const ingredients = useQuery({
    queryKey: ['ingredients-search', asked],
    queryFn: () => api.get<Ingredient[]>(`/ingredients?search=${encodeURIComponent(asked)}`),
    enabled: kind === 'ingredient' && ingredient === null && searching,
  });

  const number = (typed: string): number => (typed.trim() === '' ? Number.NaN : Number(typed));
  const typedServings = number(servings);
  const typedCalories = number(calories);
  const servingsFit =
    typedServings >= OWN_MEAL_LIMITS.servings.min && typedServings <= OWN_MEAL_LIMITS.servings.max;
  const caloriesFit = typedCalories >= 0 && typedCalories <= OWN_MEAL_LIMITS.perServing.calories;
  // What the entry adds to the day, rounded as the API rounds it, where what was typed can be written; an ingredient's figures go through the API's units.
  const adds =
    kind === 'recipe' && recipe && servingsFit
      ? Math.round(recipe.nutritionPerServing.calories * typedServings)
      : kind === 'meal' && caloriesFit && servingsFit
        ? Math.round(typedCalories * typedServings)
        : null;
  const missing =
    kind === 'recipe' && !recipe
      ? t('pickRecipeFirst')
      : kind === 'ingredient' && !ingredient
        ? t('pickIngredientFirst')
        : null;

  const pickKind = (next: Kind) => {
    setKind(next);
    setSearch('');
  };

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // The fields say themselves what is wrong with them before it comes to this.
    if (kind === 'recipe' && recipe) {
      onSubmit({ kind, mealType, recipeId: recipe.id, servings: typedServings });
    } else if (kind === 'ingredient' && ingredient) {
      onSubmit({
        kind,
        mealType,
        ingredientId: ingredient.id,
        amount: { quantity: number(quantity), unit },
      });
    } else if (kind === 'meal') {
      // A macronutrient left empty is one the API estimates.
      onSubmit({
        kind,
        mealType,
        name: name.trim(),
        servings: typedServings,
        nutrition: {
          calories: number(calories),
          ...(protein.trim() === '' ? {} : { protein: number(protein) }),
          ...(fat.trim() === '' ? {} : { fat: number(fat) }),
          ...(carbs.trim() === '' ? {} : { carbs: number(carbs) }),
        },
      });
    }
  };

  const servingsField = (
    <Field label={t('servings')}>
      <Input
        type="number"
        inputMode="decimal"
        required
        min={OWN_MEAL_LIMITS.servings.min}
        max={OWN_MEAL_LIMITS.servings.max}
        step={0.25}
        value={servings}
        onChange={(e) => setServings(e.target.value)}
      />
    </Field>
  );

  return (
    <Dialog open onClose={onClose} label={t('addTitle')} className="max-w-lg">
      <div className="flex items-center justify-between border-b border-border p-4">
        <div>
          <h2 className="font-semibold">{t('addTitle')}</h2>
          <p className="text-xs text-muted-foreground">{fmt.day(date)}</p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {tCommon('close')}
        </Button>
      </div>

      <form className="space-y-4 p-4" onSubmit={submit}>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t('kindLegend')}</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {(['recipe', 'ingredient', 'meal'] as const).map((choice) => (
              <label key={choice} className="flex min-h-6 items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`${id}-kind`}
                  className="h-4 w-4"
                  checked={kind === choice}
                  onChange={() => pickKind(choice)}
                />
                {t(
                  choice === 'recipe'
                    ? 'kindRecipe'
                    : choice === 'ingredient'
                      ? 'kindIngredient'
                      : 'kindMeal',
                )}
              </label>
            ))}
          </div>
        </fieldset>

        <Field label={t('mealLabel')}>
          <select
            className={selectClass}
            value={mealType}
            onChange={(e) => setMealType(e.target.value as MealType)}
          >
            {MEAL_SLOTS_BY_COUNT[5]!.map((slot) => (
              <option key={slot} value={slot}>
                {tMeal(slot)}
              </option>
            ))}
          </select>
        </Field>

        {kind === 'recipe' &&
          (recipe ? (
            <>
              <Picked
                name={recipe.title}
                about={t('perServing', { kcal: recipe.nutritionPerServing.calories })}
                onAgain={() => setRecipe(null)}
              />
              {servingsField}
            </>
          ) : (
            <Search
              label={t('searchRecipe')}
              value={search}
              onChange={setSearch}
              searching={searching}
              loading={recipes.isFetching}
              failed={recipes.isError}
              found={(searching ? (recipes.data?.items ?? []) : []).map((found) => ({
                id: found.id,
                name: found.title,
                about: t('perServing', { kcal: found.nutritionPerServing.calories }),
                pick: () => {
                  setRecipe(found);
                  setSearch('');
                },
              }))}
            />
          ))}

        {kind === 'ingredient' &&
          (ingredient ? (
            <>
              <Picked
                name={ingredient.name}
                about={t('per100', {
                  kcal: ingredient.caloriesPer100,
                  unit: unitName(ingredient.canonicalUnit),
                })}
                onAgain={() => setIngredient(null)}
              />
              <div className="grid grid-cols-2 gap-3">
                <Field label={t('quantity')}>
                  <Input
                    type="number"
                    inputMode="decimal"
                    required
                    min={0.01}
                    max={DIARY_QUANTITY_LIMITS[unit]}
                    step="any"
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                  />
                </Field>
                <Field label={t('unit')}>
                  <select
                    className={selectClass}
                    value={unit}
                    onChange={(e) => setUnit(e.target.value as Unit)}
                  >
                    {/* Only what the ingredient converts from: the API refuses any other unit. */}
                    {ingredient.recipeUnits.map((choice) => (
                      <option key={choice} value={choice}>
                        {choice === 'piece'
                          ? unitName(ingredient.displayUnit ?? 'piece')
                          : unitName(choice)}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            </>
          ) : (
            <Search
              label={t('searchIngredient')}
              value={search}
              onChange={setSearch}
              searching={searching}
              loading={ingredients.isFetching}
              failed={ingredients.isError}
              found={(searching ? (ingredients.data ?? []) : []).slice(0, OFFERED).map((found) => ({
                id: found.id,
                name: found.name,
                about: t('per100', {
                  kcal: found.caloriesPer100,
                  unit: unitName(found.canonicalUnit),
                }),
                pick: () => {
                  setIngredient(found);
                  // The unit the API offers first: the one the ingredient is weighed or measured in.
                  setUnit(found.recipeUnits[0]!);
                  setSearch('');
                },
              }))}
            />
          ))}

        {kind === 'meal' && (
          <>
            <Field label={t('mealName')}>
              {/* A name of nothing but spaces is no name. */}
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                pattern=".*\S.*"
                maxLength={OWN_MEAL_LIMITS.name}
              />
            </Field>
            <fieldset className="space-y-2" aria-describedby={`${id}-optional`}>
              <legend className="text-sm font-medium">{t('onePortion')}</legend>
              <div className="grid grid-cols-2 gap-3">
                <Field label={t('calories')}>
                  <Input
                    type="number"
                    inputMode="decimal"
                    required
                    min={0}
                    max={OWN_MEAL_LIMITS.perServing.calories}
                    step="any"
                    value={calories}
                    onChange={(e) => setCalories(e.target.value)}
                  />
                </Field>
                <Field label={`${t('protein')} · ${tCommon('optional')}`}>
                  <Input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    max={OWN_MEAL_LIMITS.perServing.protein}
                    step="any"
                    value={protein}
                    onChange={(e) => setProtein(e.target.value)}
                  />
                </Field>
                <Field label={`${t('fat')} · ${tCommon('optional')}`}>
                  <Input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    max={OWN_MEAL_LIMITS.perServing.fat}
                    step="any"
                    value={fat}
                    onChange={(e) => setFat(e.target.value)}
                  />
                </Field>
                <Field label={`${t('carbs')} · ${tCommon('optional')}`}>
                  <Input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    max={OWN_MEAL_LIMITS.perServing.carbs}
                    step="any"
                    value={carbs}
                    onChange={(e) => setCarbs(e.target.value)}
                  />
                </Field>
              </div>
              <p id={`${id}-optional`} className="text-xs text-muted-foreground">
                {t('macrosOptional')}
              </p>
            </fieldset>
            {servingsField}
          </>
        )}

        <div aria-live="polite" className="space-y-1 text-xs">
          {adds !== null && <p>{t('addsLine', { kcal: adds })}</p>}
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          {missing && (
            <span id={`${id}-missing`} className="mr-auto text-xs text-muted-foreground">
              {missing}
            </span>
          )}
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            {tCommon('cancel')}
          </Button>
          <Button
            type="submit"
            size="sm"
            disabled={busy || missing !== null}
            aria-describedby={missing ? `${id}-missing` : undefined}
          >
            {t('submit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** What was picked, and a way back to the search. */
function Picked({ name, about, onAgain }: { name: string; about: string; onAgain: () => void }) {
  const t = useTranslations('diary');
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
      <div className="min-w-0">
        <p className="break-words text-sm font-medium">{name}</p>
        <p className="text-xs text-muted-foreground">{about}</p>
      </div>
      <Button type="button" variant="ghost" size="sm" onClick={onAgain}>
        {t('changePick')}
      </Button>
    </div>
  );
}

/** A search of what the window offers, and what it found as buttons to pick. */
function Search({
  label,
  value,
  onChange,
  searching,
  loading,
  failed,
  found,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  searching: boolean;
  loading: boolean;
  /** The search did not get an answer: that says nothing of what there is. */
  failed: boolean;
  found: { id: string; name: string; about: string; pick: () => void }[];
}) {
  const t = useTranslations('diary');
  const id = useId();
  return (
    <div className="space-y-2">
      <Field label={label} hint={t('searchHint')}>
        <Input
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-controls={`${id}-found`}
          maxLength={200}
        />
      </Field>
      <div id={`${id}-found`} aria-live="polite">
        {searching && !loading && failed && (
          <p role="alert" className="text-sm text-destructive">
            {t('searchFailed')}
          </p>
        )}
        {searching && !loading && !failed && found.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('noResults')}</p>
        )}
        {found.length > 0 && (
          <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded-md border border-border">
            {found.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="flex w-full flex-col items-start px-3 py-2 text-left hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                  onClick={item.pick}
                >
                  <span className="max-w-full break-words text-sm font-medium">{item.name}</span>
                  <span className="text-xs text-muted-foreground">{item.about}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
