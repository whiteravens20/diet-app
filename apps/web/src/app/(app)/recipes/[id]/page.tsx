// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Trash } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Suspense } from 'react';
import type { Recipe } from '@diet-app/shared';
import { api } from '@/lib/api';
import { ApiClientError } from '@/lib/http';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { RecipeView } from '@/components/recipe-view';
import { Button, buttonVariants } from '@/components/ui/button';
import { useErrorText } from '@/lib/use-error-text';

/** The most servings a link from a plan is believed to name: a cooking of the most a meal holds, four times over. */
const MOST_SERVINGS = 12;

/** The recipes of the shared library: nobody's to edit. */
const LIBRARY = new Set<Recipe['origin']>(['seed', 'curated']);

/** Thin route wrapper around the shared RecipeView. The same body renders inside
 *  the meal-plan modal — this just adds the back link, the ways to edit and to
 *  delete a recipe of one's own, and loading/error chrome. */
function RecipeDetail() {
  const t = useTranslations('recipeDetail');
  const params = useParams<{ id: string }>();
  // Opened from a meal of a plan: what the meal takes, which the amounts of the original are not.
  const search = useSearchParams();
  const portion = Number(search.get('portion'));
  const whole = search.get('whole') === '1';
  const recipe = useQuery({
    queryKey: ['recipe', params.id],
    queryFn: () => api.get<Recipe>(`/recipes/${params.id}`),
    retry: false,
  });
  // Deleting it leaves the plans that hold it as they are, and a suggestion of it with the curators.
  const tRecipes = useTranslations('recipes');
  const errorText = useErrorText();
  const router = useRouter();
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api.delete(`/recipes/${params.id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['recipes:mine'] });
      queryClient.invalidateQueries({ queryKey: ['recipes'] });
      queryClient.removeQueries({ queryKey: ['recipe', params.id] });
      router.push('/recipes?tab=mine');
    },
  });

  if (recipe.isLoading) return <Skeleton className="h-64" />;

  if (recipe.error) {
    const notFound = recipe.error instanceof ApiClientError && recipe.error.status === 404;
    return (
      <Card className="mx-auto mt-20 max-w-md text-center">
        <CardHeader>
          <CardTitle>{notFound ? t('notFound') : t('loadFailed')}</CardTitle>
        </CardHeader>
        <CardContent>
          <Link href="/recipes" className="text-sm text-primary underline underline-offset-2">
            ← {t('back')}
          </Link>
        </CardContent>
      </Card>
    );
  }

  const own = !LIBRARY.has(recipe.data!.origin);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link href="/recipes" className="text-sm text-primary underline underline-offset-2">
          ← {t('back')}
        </Link>
        {own && (
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={`/recipes/${recipe.data!.id}/edit`}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              <Pencil size={14} aria-hidden />
              <span className="ml-1">{t('edit')}</span>
            </Link>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={remove.isPending}
              onClick={() => {
                if (window.confirm(tRecipes('deleteConfirm'))) remove.mutate();
              }}
            >
              <Trash size={14} aria-hidden />
              <span className="ml-1">{tRecipes('delete')}</span>
            </Button>
          </div>
        )}
      </div>
      {remove.isError && (
        <p role="alert" className="text-sm text-destructive">
          {errorText(remove.error, tRecipes('deleteFailed'))}
        </p>
      )}
      {portion > 0 && portion <= MOST_SERVINGS && (
        <p className="text-sm text-muted-foreground">
          {t(whole ? 'portionWholeFromPlan' : 'portionFromPlan', {
            recipe: recipe.data!.servings,
            mine: portion,
          })}
        </p>
      )}
      <RecipeView recipe={recipe.data!} />
    </div>
  );
}

export default function RecipeDetailPage() {
  return (
    <Suspense fallback={<Skeleton className="h-64" />}>
      <RecipeDetail />
    </Suspense>
  );
}
