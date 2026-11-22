// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useQuery } from '@tanstack/react-query';
import { ExternalLink, X } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { DOT } from '@/lib/figure-line';
import { useId } from 'react';
import type {
  DisplayAmount,
  LabelTotals,
  PlannedIngredient,
  Recipe,
  RecipeForm,
} from '@diet-app/shared';
import { api } from '@/lib/api';
import { useShownAmount } from '@/lib/ingredient-format';
import { useFormat } from '@/lib/use-format';
import { sameServings } from '@/lib/servings';
import { ApiClientError } from '@/lib/http';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { RecipeView } from '@/components/recipe-view';
import { AiMark } from '@/components/ai-mark';
import { Dialog } from '@/components/ui/dialog';
import { LineDrawing, type DrawingName } from '@/components/line-drawing';

/** The drawing of each kind of dish, in the place of a recipe's photo. */
const DISH_DRAWING: Record<RecipeForm, DrawingName> = {
  plate: 'dish-plate',
  soup: 'dish-soup',
  salad: 'dish-salad',
  sandwich: 'dish-sandwich',
  porridge_dessert: 'dish-porridge',
};

/**
 * Recipe detail in a window over the page. Lazy-loads the recipe by id when
 * opened. A click beside it, the close button and Esc dismiss it.
 */
/** A plate of a shared dish: what each person's holds of a line whose amount differs from the recipe's. */
interface PlateRow {
  ingredientId: string;
  name: string;
  mine: DisplayAmount;
  theirs: DisplayAmount;
}

/** Of a meal two people share: the other person's portion of it and the plates that differ. */
export interface SharedPortion {
  name: string;
  servings: number;
  kcal: number;
  eaten: boolean;
  plates: PlateRow[];
}

/** From how far off its plan's portion a meal's factor is said beside its portion: a twentieth, as it ever was. */
const SCALED_FROM = 0.05;

export function RecipeModal({
  recipeId,
  amounts,
  picked = null,
  portion,
  pot,
  label,
  scale,
  shared,
  topping,
  onClose,
}: {
  recipeId: string | null;
  /** The ingredient lines of the planned meal the modal was opened from, so it
   *  shows what that meal takes, not the recipe's own servings. */
  amounts?: PlannedIngredient[];
  /** Set when a model chose this recipe for the meal the modal was opened from: the reason it gave, if any. */
  picked?: { reason: string | null } | null;
  /** How many servings those lines come to, and whether they are for the whole of a cooking. */
  portion?: { servings: number; whole: boolean };
  /**
   * Of a dish two people cook in one pot: the lines are the pot's, and these
   * are the portions in it, with the lines whose plates differ from the recipe.
   */
  pot?: {
    mine: number;
    name: string;
    theirs: number;
    plates: { ingredientId: string; name: string; mine: DisplayAmount; theirs: DisplayAmount }[];
  };
  /** Fibre, sugars, salt and saturated fat of the planned meal the modal was opened from. */
  label?: LabelTotals;
  /** How far the planner sized the meal off its plan's portion; its card says the portion in words instead. */
  scale?: number;
  /** Of a meal two people share: the other person's portion and plates; a pot says the portions in its own line. */
  shared?: SharedPortion;
  /** What is put on this meal's plate alone, beside the dish and outside its pot. */
  topping?: { name: string; amount: string; kcal: number } | null;
  onClose: () => void;
}) {
  const t = useTranslations('recipeModal');
  // Whose plates differ from the recipe: those of the pot, or of a dish each person cooks apart.
  const plated = pot ?? shared;
  const tDetail = useTranslations('recipeDetail');
  const tSplit = useTranslations('split');
  const shownAmount = useShownAmount();
  const fmt = useFormat();
  const platesId = useId();

  const recipe = useQuery({
    queryKey: ['recipe', recipeId],
    queryFn: () => api.get<Recipe>(`/recipes/${recipeId!}`),
    enabled: recipeId !== null,
    retry: false,
  });

  return (
    <Dialog open={recipeId !== null} onClose={onClose} label={t('title')}>
      <div className="flex items-center justify-end gap-1 border-b border-border px-3 py-2">
        {recipe.data && (
          <Link
            href={
              portion
                ? `/recipes/${recipe.data.id}?${new URLSearchParams({
                    portion: String(portion.servings),
                    ...(portion.whole ? { whole: '1' } : {}),
                  })}`
                : `/recipes/${recipe.data.id}`
            }
            onClick={onClose}
          >
            <Button type="button" variant="ghost" size="sm" title={t('openPage')}>
              <ExternalLink className="h-4 w-4" aria-hidden />
              <span className="ml-1">{t('openPage')}</span>
            </Button>
          </Link>
        )}
        <Button type="button" variant="ghost" size="sm" onClick={onClose} aria-label={t('close')}>
          <X className="h-4 w-4" aria-hidden />
        </Button>
      </div>
      {/*
        The place of a recipe's photo. Recipes carry none of their own: a line
        drawing of its kind of dish stands here (a plate, a soup, a salad, a
        sandwich, a porridge or dessert), which says what kind of dish it is
        without passing for a photograph of this one. Decorative.
      */}
      {recipe.data && (
        <div className="relative h-28 bg-muted/40 sm:h-36" data-recipe-photo>
          <LineDrawing
            name={DISH_DRAWING[recipe.data.traits?.form ?? 'plate']}
            className="absolute inset-3"
          />
        </div>
      )}
      <div className="p-6">
        {recipe.isLoading && <Skeleton className="h-64" />}
        {recipe.error && (
          <p className="text-sm text-muted-foreground">
            {recipe.error instanceof ApiClientError && recipe.error.status === 404
              ? tDetail('notFound')
              : tDetail('loadFailed')}
          </p>
        )}
        {recipe.data && picked && (
          <AiMark part={{ kind: 'picked', reason: picked.reason }} spelledOut className="mb-4" />
        )}
        {recipe.data && portion && (
          <p className="mb-4 text-sm text-muted-foreground">
            {pot
              ? t('portionPot', {
                  recipe: recipe.data.servings,
                  all: portion.servings,
                  mine: pot.mine,
                  name: fmt.text(pot.name),
                  theirs: pot.theirs,
                  same: sameServings(recipe.data.servings, portion.servings),
                })
              : t(portion.whole ? 'portionWhole' : 'portionMeal', {
                  recipe: recipe.data.servings,
                  mine: portion.servings,
                  same: sameServings(recipe.data.servings, portion.servings),
                })}
            {scale !== undefined && Math.abs(scale - 1) >= SCALED_FROM && (
              <span className="ml-2 whitespace-nowrap rounded bg-primary/10 px-1.5 py-0.5 text-2xs text-foreground">
                {t('scaled', { scale: fmt.fixed(scale, 2) })}
              </span>
            )}
          </p>
        )}
        {recipe.data && shared && !pot && (
          <p className="mb-4 text-sm text-muted-foreground">
            {t('sharedLine', {
              name: fmt.text(shared.name),
              servings: shared.servings,
              kcal: shared.kcal,
            })}
            {shared.eaten && `${DOT}${t('sharedEaten')}`}
          </p>
        )}
        {recipe.data && topping && (
          <p className="mb-4 text-sm">
            {t('toppingNote', {
              name: fmt.text(topping.name),
              amount: topping.amount,
              kcal: topping.kcal,
            })}
          </p>
        )}
        {recipe.data && plated && plated.plates.length > 0 && (
          <section className="mb-4 space-y-2" aria-labelledby={`${platesId}-title`}>
            <h3 id={`${platesId}-title`} className="text-sm font-semibold">
              {t('platesTitle')}
            </h3>
            {/* The rest of a pot is split by portion; a dish each person cooks apart has no pot to split. */}
            <p className="text-sm text-muted-foreground">
              {t('platesIntro')}
              {pot && ` ${t('platesPot')}`}
            </p>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-1 pr-3 font-medium">
                    {t('platesIngredient')}
                  </th>
                  <th scope="col" className="py-1 pr-3 text-right font-medium">
                    {t('platesYou')}
                  </th>
                  <th scope="col" className="py-1 text-right font-medium">
                    {fmt.text(plated.name)}
                  </th>
                </tr>
              </thead>
              <tbody>
                {plated.plates.map((row) => (
                  <tr key={row.ingredientId} className="border-b border-border last:border-0">
                    <th scope="row" className="py-1 pr-3 text-left font-normal">
                      {fmt.text(row.name)}
                    </th>
                    {/* An amount in pieces says its grams too: it wraps on a narrow screen rather than leave the window. */}
                    <td className="py-1 pr-3 text-right tabular-nums">{shownAmount(row.mine)}</td>
                    <td className="py-1 text-right tabular-nums">{shownAmount(row.theirs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {pot && (
              <p className="rounded-md bg-muted/60 p-3 text-xs text-muted-foreground">
                {tSplit('partRisk')}
              </p>
            )}
          </section>
        )}
        {recipe.data && (
          <RecipeView
            recipe={recipe.data}
            amounts={amounts}
            servings={portion?.servings}
            hideNutrition
            mealLabel={label}
          />
        )}
      </div>
    </Dialog>
  );
}
