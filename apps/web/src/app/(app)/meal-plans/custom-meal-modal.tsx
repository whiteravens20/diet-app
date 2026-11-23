// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useQuery } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import {
  AddCustomMealRequest,
  EnteredNutrition,
  type Ingredient,
  type MealType,
  type Product,
  type Recipe,
  type RecipeSearchPage,
  type Unit,
} from '@diet-app/shared';
import { DIARY_QUANTITY_LIMITS, MEAL_TYPES, OWN_MEAL_LIMITS } from '@diet-app/shared/constants';
import { api } from '@/lib/api';
import { useConfig } from '@/lib/use-config';
import { useUnitName } from '@/lib/ingredient-format';
import { useSettled } from '@/lib/use-settled';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useFormat } from '@/lib/use-format';
import { Dialog } from '@/components/ui/dialog';
import { Picked, Search } from '../diary/entry-pickers';
import { firstAmount, PickedProduct, ProductAmount, ProductSearch } from '../diary/product-entry';
import { ListNote } from './list-note';

/** What the meal is of: a product, a recipe or an ingredient chosen as the diary chooses them, or figures typed. */
type Kind = 'product' | 'recipe' | 'ingredient' | 'meal';

/** How many of what a search finds are offered. */
const OFFERED = 8;

// It checks what is typed against the contract, which only somebody writing a product needs loaded.
const OwnProductForm = dynamic(
  () => import('@/components/own-product-form').then((form) => form.OwnProductForm),
  { ssr: false, loading: () => <Skeleton className="h-96" /> },
);

const selectClass =
  'w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring';

/** The most one serving may hold of each, as the API has it. */
const most = (of: keyof EnteredNutrition) => EnteredNutrition.shape[of].maxValue ?? undefined;

/** A meal of the day, as the window names it: one the own meal may be eaten in the place of. */
export interface DayMealOption {
  id: string;
  mealType: string;
  title: string;
  /** What follows for the other meal of its cooking if this one gives way. */
  apart: string | null;
}

/**
 * The window a meal of the user's own is added to a day in: a product (the
 * search, its code, the account's own products), a recipe or an ingredient
 * chosen as the diary's window chooses them, the API working out what it
 * holds; or a meal with no ingredients by the numbers of one serving and how
 * many servings it is, which the window multiplies before anything is sent, so
 * that nobody types the whole meal as one serving of several. A recipe goes in
 * as that recipe. It comes beside the day's meals, or in the place of one of
 * them, and the window says what either does to the day before it is added.
 */
export function CustomMealModal({
  date,
  meals,
  listed = false,
  onClose,
  onSubmit,
}: {
  date: string;
  /** The meals the day has. */
  meals: readonly DayMealOption[];
  /** A shopping list covers the day. */
  listed?: boolean;
  onClose: () => void;
  onSubmit: (body: AddCustomMealRequest) => void;
}) {
  const t = useTranslations('mealPlans');
  const tDiary = useTranslations('diary');
  const tCommon = useTranslations('common');
  const tMeal = useTranslations('enums.mealType');
  const tProducts = useTranslations('products');
  const fmt = useFormat();
  const unitName = useUnitName();
  const id = useId();
  const products = useConfig().data?.products;
  // Figures typed first, as the window always had them; what the diary chooses beside them.
  const kinds: readonly Kind[] = products?.offered
    ? ['meal', 'product', 'recipe', 'ingredient']
    : ['meal', 'recipe', 'ingredient'];

  const [kind, setKind] = useState<Kind>(kinds[0]!);
  const [search, setSearch] = useState('');
  const sought = useSettled(search.trim(), 300);
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [ingredient, setIngredient] = useState<Ingredient | null>(null);
  const [product, setProduct] = useState<Product | null>(null);
  // A product of one's own being written, for a code nobody knows or as a correction of one of the base.
  const [writing, setWriting] = useState<{ code: string; from?: Product } | null>(null);
  const [quantity, setQuantity] = useState('');
  const [unit, setUnit] = useState<Unit>('g');
  const [name, setName] = useState('');
  const [mealType, setMealType] = useState<MealType>('lunch');
  const mealTypeOptions = MEAL_TYPES;
  const [calories, setCalories] = useState('');
  const [protein, setProtein] = useState('');
  const [fat, setFat] = useState('');
  const [carbs, setCarbs] = useState('');
  const [servings, setServings] = useState('1');
  // The meal of the day this one is eaten in the place of; none for one beside them.
  const [replaces, setReplaces] = useState('');

  // Only the search in the field is said anything of: what an earlier one found is not an answer to this one.
  const searching = sought.length >= 2 && sought === search.trim();
  const recipes = useQuery({
    queryKey: ['diary-recipes', sought],
    queryFn: () =>
      api.get<RecipeSearchPage>(
        `/recipes?search=${encodeURIComponent(sought)}&pageSize=${OFFERED}`,
      ),
    enabled: kind === 'recipe' && recipe === null && searching,
  });
  const ingredients = useQuery({
    queryKey: ['ingredients-search', sought],
    queryFn: () => api.get<Ingredient[]>(`/ingredients?search=${encodeURIComponent(sought)}`),
    enabled: kind === 'ingredient' && ingredient === null && searching,
  });

  const pickKind = (next: Kind) => {
    setKind(next);
    setSearch('');
    setQuantity(next === 'product' && product ? firstAmount(product) : '');
  };
  /** Whatever a product could not give, it is typed as a meal of figures, under its name where it has one. */
  const asTyped = (known: string) => {
    if (known !== '') setName([...known].slice(0, OWN_MEAL_LIMITS.name).join(''));
    pickKind('meal');
  };
  const pickProduct = (picked: Product): void => {
    setWriting(null);
    setProduct(picked);
    setQuantity(firstAmount(picked));
  };

  const num = (v: string) => (v.trim() === '' ? NaN : Number(v));
  // A macronutrient left empty is left out: the API estimates it, as the diary's own meal has it.
  const serving = {
    calories: num(calories),
    ...(protein.trim() ? { protein: Number(protein) } : {}),
    ...(fat.trim() ? { fat: Number(fat) } : {}),
    ...(carbs.trim() ? { carbs: Number(carbs) } : {}),
  };
  const place = replaces ? { replaces } : {};
  const asked = AddCustomMealRequest.safeParse(
    kind === 'recipe'
      ? { mealType, of: { kind, recipeId: recipe?.id, servings: num(servings) }, ...place }
      : kind === 'ingredient'
        ? {
            mealType,
            of: {
              kind,
              ingredientId: ingredient?.id,
              amount: { quantity: num(quantity), unit },
            },
            ...place,
          }
        : kind === 'product'
          ? { mealType, of: { kind, productId: product?.id, quantity: num(quantity) }, ...place }
          : { name, mealType, nutrition: serving, servings: num(servings), ...place },
  );
  // What the meal adds to its day is said once the API would take what it is said of, rounded as the API rounds it.
  const pending = kind === 'meal' ? t('customTotalPending') : t('customTotalPendingChosen');
  /** What the meal adds to its day, from one serving or 100 units of what it is and how many of them there are. */
  const added = (
    figures: {
      calories: number | null;
      protein: number | null;
      fat: number | null;
      carbs: number | null;
    },
    times: number,
  ): string => {
    if (!Number.isFinite(times) || times <= 0 || figures.calories === null) return pending;
    const inFull = (value: number) => Math.round(value * times);
    return figures.protein !== null && figures.fat !== null && figures.carbs !== null
      ? t('customTotal', {
          calories: inFull(figures.calories),
          protein: inFull(figures.protein),
          fat: inFull(figures.fat),
          carbs: inFull(figures.carbs),
        })
      : t('customTotalEstimated', { calories: inFull(figures.calories) });
  };
  // Figures typed, within what a serving and a meal may hold: they do not wait for a name.
  const typedFits =
    EnteredNutrition.partial({ protein: true, fat: true, carbs: true }).safeParse(serving)
      .success &&
    num(servings) >= OWN_MEAL_LIMITS.servings.min &&
    num(servings) <= OWN_MEAL_LIMITS.servings.max;
  const typed = {
    calories: Number.isFinite(serving.calories) ? serving.calories : null,
    protein: serving.protein ?? null,
    fat: serving.fat ?? null,
    carbs: serving.carbs ?? null,
  };
  const adds =
    kind === 'meal'
      ? typedFits
        ? added(typed, num(servings))
        : pending
      : !asked.success
        ? pending
        : kind === 'recipe' && recipe
          ? added(recipe.nutritionPerServing, num(servings))
          : kind === 'product' && product
            ? added(product.per100, num(quantity) / 100)
            : kind === 'ingredient' && ingredient
              ? added(
                  {
                    calories: ingredient.caloriesPer100,
                    protein: ingredient.proteinPer100,
                    fat: ingredient.fatPer100,
                    carbs: ingredient.carbsPer100,
                  },
                  (inOwnUnit(num(quantity), unit, ingredient) ?? Number.NaN) / 100,
                )
              : pending;
  const missing =
    kind === 'recipe' && !recipe
      ? tDiary('pickRecipeFirst')
      : kind === 'ingredient' && !ingredient
        ? tDiary('pickIngredientFirst')
        : kind === 'product' && !product
          ? tDiary('pickProductFirst')
          : kind === 'product' && product?.per100.calories === null
            ? tDiary('productNoFiguresShort')
            : null;

  const apart = meals.find((meal) => meal.id === replaces)?.apart;

  return (
    <Dialog open onClose={onClose} label={t('customModalTitle')} className="max-w-md">
      <div className="flex items-center justify-between border-b border-border p-4">
        <div>
          <h2 className="font-semibold">{t('customModalTitle')}</h2>
          <p className="text-xs text-muted-foreground">{fmt.day(date)}</p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {tCommon('close')}
        </Button>
      </div>

      {writing && (
        <div className="space-y-3 p-4">
          <h3 className="text-sm font-medium">
            {writing.from ? tProducts('correctTitle') : tDiary('productWriteTitle')}
          </h3>
          <OwnProductForm
            code={writing.code}
            from={writing.from ?? null}
            onSaved={(saved) =>
              writing.from ? (setWriting(null), setProduct(saved)) : pickProduct(saved)
            }
            onCancel={() => setWriting(null)}
          />
        </div>
      )}
      <form
        hidden={writing !== null}
        className="space-y-4 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          // The fields say themselves what is wrong with them before it comes to this.
          if (asked.success) onSubmit(asked.data);
        }}
      >
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{tDiary('kindLegend')}</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {kinds.map((choice) => (
              <label key={choice} className="flex min-h-6 items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`${id}-kind`}
                  className="h-4 w-4"
                  checked={kind === choice}
                  onChange={() => pickKind(choice)}
                />
                {choice === 'meal'
                  ? t('customKindTyped')
                  : tDiary(
                      choice === 'recipe'
                        ? 'kindRecipe'
                        : choice === 'ingredient'
                          ? 'kindIngredient'
                          : 'kindProduct',
                    )}
              </label>
            ))}
          </div>
        </fieldset>

        {kind === 'product' &&
          (product ? (
            <>
              <PickedProduct
                product={product}
                onAgain={() => setProduct(null)}
                onOwnMeal={() => asTyped(product.name)}
                onCorrect={() => setWriting({ code: product.code ?? '', from: product })}
              />
              {product.per100.calories !== null && (
                <ProductAmount product={product} quantity={quantity} onChange={setQuantity} />
              )}
            </>
          ) : (
            <ProductSearch
              lookups={products?.lookups ?? false}
              onPick={pickProduct}
              onOwnMeal={() => asTyped('')}
              onOwnProduct={(code) => setWriting({ code })}
            />
          ))}

        {kind === 'recipe' &&
          (recipe ? (
            <Picked
              name={recipe.title}
              about={tDiary('perServing', { kcal: recipe.nutritionPerServing.calories })}
              onAgain={() => setRecipe(null)}
            />
          ) : (
            <Search
              label={tDiary('searchRecipe')}
              value={search}
              onChange={setSearch}
              searching={searching}
              loading={recipes.isFetching}
              failed={recipes.isError}
              found={(searching ? (recipes.data?.items ?? []) : []).map((found) => ({
                id: found.id,
                name: found.title,
                about: tDiary('perServing', { kcal: found.nutritionPerServing.calories }),
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
                about={tDiary('per100', {
                  kcal: ingredient.caloriesPer100,
                  unit: unitName(ingredient.canonicalUnit),
                })}
                onAgain={() => setIngredient(null)}
              />
              <div className="grid grid-cols-2 gap-3">
                <Field label={tDiary('quantity')}>
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
                <Field label={tDiary('unit')}>
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
              label={tDiary('searchIngredient')}
              value={search}
              onChange={setSearch}
              searching={searching}
              loading={ingredients.isFetching}
              failed={ingredients.isError}
              found={(searching ? (ingredients.data ?? []) : []).slice(0, OFFERED).map((found) => ({
                id: found.id,
                name: found.name,
                about: tDiary('per100', {
                  kcal: found.caloriesPer100,
                  unit: unitName(found.canonicalUnit),
                }),
                pick: () => {
                  setIngredient(found);
                  setUnit(found.recipeUnits[0]!);
                  setSearch('');
                },
              }))}
            />
          ))}

        {kind === 'meal' && (
          <Field label={t('customName')}>
            {/* A name of nothing but spaces is no name. */}
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              pattern=".*\S.*"
              maxLength={120}
            />
          </Field>
        )}

        <Field label={t('customMealType')}>
          <select
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            value={mealType}
            onChange={(e) => setMealType(e.target.value as MealType)}
          >
            {mealTypeOptions.map((slot) => (
              <option key={slot} value={slot}>
                {tMeal.has(slot) ? tMeal(slot) : slot}
              </option>
            ))}
          </select>
        </Field>

        <Field label={t('customPlace')}>
          <select
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            value={replaces}
            onChange={(e) => setReplaces(e.target.value)}
          >
            <option value="">{t('customBeside')}</option>
            {meals.map((meal) => (
              <option key={meal.id} value={meal.id}>
                {t('customInstead', {
                  meal: tMeal.has(meal.mealType) ? tMeal(meal.mealType) : meal.mealType,
                  title: meal.title,
                })}
              </option>
            ))}
          </select>
        </Field>

        {kind === 'meal' && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t('customPerServing')}</legend>
            <p className="text-xs text-muted-foreground">{t('customMacrosOptional')}</p>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('customCalories')}>
                <Input
                  type="number"
                  inputMode="decimal"
                  required
                  min={0}
                  max={most('calories')}
                  step="any"
                  value={calories}
                  onChange={(e) => setCalories(e.target.value)}
                />
              </Field>
              <Field label={t('customProtein')}>
                <Input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={most('protein')}
                  step="any"
                  value={protein}
                  onChange={(e) => setProtein(e.target.value)}
                />
              </Field>
              <Field label={t('customFat')}>
                <Input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={most('fat')}
                  step="any"
                  value={fat}
                  onChange={(e) => setFat(e.target.value)}
                />
              </Field>
              <Field label={t('customCarbs')}>
                <Input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={most('carbs')}
                  step="any"
                  value={carbs}
                  onChange={(e) => setCarbs(e.target.value)}
                />
              </Field>
            </div>
          </fieldset>
        )}

        {(kind === 'meal' || kind === 'recipe') && (
          <Field
            label={t('customServings')}
            hint={kind === 'meal' ? t('customServingsHint') : undefined}
          >
            <Input
              type="number"
              inputMode="decimal"
              required
              min={0.25}
              max={20}
              step={0.25}
              value={servings}
              onChange={(e) => setServings(e.target.value)}
            />
          </Field>
        )}

        <div
          aria-live="polite"
          className="space-y-1 rounded-md border border-border bg-muted/40 p-3 text-xs"
        >
          <p>{adds}</p>
          {/* What adding it does to the day, said before it is added. */}
          <p className="text-muted-foreground">
            {t(replaces ? 'customInsteadNote' : 'customBesideNote')}
          </p>
          {apart && <p className="text-muted-foreground">{apart}</p>}
          <ListNote listed={listed} />
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
            disabled={missing !== null}
            aria-describedby={missing ? `${id}-missing` : undefined}
          >
            {t('customSubmit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * `quantity` of `unit` of an ingredient in the unit its figures are given per 100 of, converted as the API converts
 * it: pieces by what one weighs, grams and millilitres into each other by its density. Null where it lacks what the
 * conversion takes.
 */
function inOwnUnit(
  quantity: number,
  unit: Unit,
  ingredient: Pick<Ingredient, 'canonicalUnit' | 'gramsPerPiece' | 'density'>,
): number | null {
  const { canonicalUnit, gramsPerPiece, density } = ingredient;
  if (unit === canonicalUnit) return quantity;
  const grams =
    unit === 'g'
      ? quantity
      : unit === 'piece'
        ? gramsPerPiece
          ? quantity * gramsPerPiece
          : null
        : density
          ? quantity * density
          : null;
  if (grams === null) return null;
  if (canonicalUnit === 'g') return grams;
  if (canonicalUnit === 'ml') return density ? grams / density : null;
  return gramsPerPiece ? grams / gramsPerPiece : null;
}
