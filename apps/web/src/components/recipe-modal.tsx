// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useQuery } from '@tanstack/react-query';
import { ExternalLink, X } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { LabelTotals, PlannedIngredient, Recipe } from '@diet-app/shared';
import { api } from '@/lib/api';
import { ApiClientError } from '@/lib/http';
import { IMAGERY } from '@/lib/imagery';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { RecipeView } from '@/components/recipe-view';
import { AiMark } from '@/components/ai-mark';
import { Dialog } from '@/components/ui/dialog';

/**
 * Recipe detail in a window over the page. Lazy-loads the recipe by id when
 * opened. A click beside it, the close button and Esc dismiss it.
 */
export function RecipeModal({
  recipeId,
  amounts,
  picked = null,
  portion,
  label,
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
  /** Fibre, sugars, salt and saturated fat of the planned meal the modal was opened from. */
  label?: LabelTotals;
  onClose: () => void;
}) {
  const t = useTranslations('recipeModal');
  const tDetail = useTranslations('recipeDetail');

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
        The place of a recipe's photo. Recipes carry none of their own yet: until
        they do, the photo of the recipe pages stands here, a board of cut
        vegetables that is no dish, so that it is taken for none. It says
        nothing a reader of the page needs (`alt=""`).
      */}
      {recipe.data && (
        <div className="relative h-28 sm:h-36" data-recipe-photo>
          <Image
            src={IMAGERY.recipes}
            alt=""
            fill
            sizes="(min-width: 44rem) 42rem, 100vw"
            className="object-cover"
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
            {t(portion.whole ? 'portionWhole' : 'portionMeal', {
              recipe: recipe.data.servings,
              mine: portion.servings,
            })}
          </p>
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
