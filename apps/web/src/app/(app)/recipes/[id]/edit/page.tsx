// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { Ingredient, Recipe } from '@diet-app/shared';
import { api } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { OwnRecipeForm, type OwnRecipeDraft } from '@/components/own-recipe-form';

/** The recipes of the shared library: nobody's to edit. */
const LIBRARY = new Set<Recipe['origin']>(['seed', 'curated']);

/**
 * A recipe of one's own, edited: the form starts with what the recipe holds,
 * and saving writes a new version of it.
 */
export default function EditOwnRecipePage() {
  const t = useTranslations('ownRecipe');
  const tDetail = useTranslations('recipeDetail');
  const params = useParams<{ id: string }>();
  const recipe = useQuery({
    queryKey: ['recipe', params.id],
    queryFn: () => api.get<Recipe>(`/recipes/${params.id}`),
    retry: false,
  });
  const ids = recipe.data?.ingredients.map((line) => line.ingredientId) ?? [];
  // How each ingredient can be measured is the catalogue's to say.
  const ingredients = useQuery({
    queryKey: ['ingredients-by-ids', ids.join(',')],
    queryFn: () => api.get<Ingredient[]>(`/ingredients?ids=${ids.join(',')}`),
    enabled: ids.length > 0,
  });

  if (recipe.isLoading || (recipe.data && ingredients.isLoading)) {
    return <Skeleton className="h-64" />;
  }
  if (recipe.error || !recipe.data || LIBRARY.has(recipe.data.origin)) {
    return (
      <Card className="mx-auto mt-20 max-w-md text-center">
        <CardHeader>
          <CardTitle>{tDetail('notFound')}</CardTitle>
        </CardHeader>
        <CardContent>
          <Link href="/recipes" className="text-sm text-primary underline underline-offset-2">
            ← {tDetail('back')}
          </Link>
        </CardContent>
      </Card>
    );
  }

  const found = recipe.data;
  const byId = new Map((ingredients.data ?? []).map((row) => [row.id, row]));
  const initial: OwnRecipeDraft = {
    title: found.title,
    description: found.description,
    steps: found.steps,
    servings: found.servings,
    mealTypes: found.mealTypes,
    prepMinutes: found.prepMinutes,
    cookMinutes: found.cookMinutes,
    difficulty: found.difficulty,
    cuisine: found.cuisine,
    ingredients: found.ingredients.map((line) => ({
      // One the catalogue no longer names keeps the unit it is in; saving then says it is gone.
      ingredient: byId.get(line.ingredientId) ?? {
        id: line.ingredientId,
        name: line.name,
        recipeUnits: [line.unit],
      },
      quantity: line.quantity,
      unit: line.unit,
      note: line.note,
    })),
  };

  return (
    <div className="space-y-4">
      <Link
        href={`/recipes/${found.id}`}
        className="text-sm text-primary underline underline-offset-2"
      >
        ← {t('backToRecipe')}
      </Link>
      <h1 className="text-2xl font-semibold">{t('editTitle')}</h1>
      <p className="text-sm text-muted-foreground">{t('editIntro')}</p>
      <OwnRecipeForm initial={initial} editing={found.id} />
    </div>
  );
}
