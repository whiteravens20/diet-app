// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useQuery } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { Recipe } from '@diet-app/shared';
import { api } from '@/lib/api';
import { ApiClientError } from '@/lib/http';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { RecipeView } from '@/components/recipe-view';
import { buttonVariants } from '@/components/ui/button';

/** The recipes of the shared library: nobody's to edit. */
const LIBRARY = new Set<Recipe['origin']>(['seed', 'curated']);

/** Thin route wrapper around the shared RecipeView. The same body renders inside
 *  the meal-plan modal — this just adds the back link, the way to edit a recipe
 *  of one's own, and loading/error chrome. */
export default function RecipeDetailPage() {
  const t = useTranslations('recipeDetail');
  const params = useParams<{ id: string }>();
  const recipe = useQuery({
    queryKey: ['recipe', params.id],
    queryFn: () => api.get<Recipe>(`/recipes/${params.id}`),
    retry: false,
  });

  if (recipe.isLoading) return <Skeleton className="h-64 max-w-2xl" />;

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
    <div className="max-w-2xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link href="/recipes" className="text-sm text-primary underline underline-offset-2">
          ← {t('back')}
        </Link>
        {own && (
          <Link
            href={`/recipes/${recipe.data!.id}/edit`}
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            <Pencil size={14} aria-hidden />
            <span className="ml-1">{t('edit')}</span>
          </Link>
        )}
      </div>
      <RecipeView recipe={recipe.data!} />
    </div>
  );
}
