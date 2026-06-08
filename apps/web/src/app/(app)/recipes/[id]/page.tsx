'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { Recipe } from '@diet-app/shared';
import { api, ApiClientError } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { RecipeView } from '@/components/recipe-view';

/** Thin route wrapper around the shared RecipeView. The same body renders inside
 *  the meal-plan modal — this just adds the back link and loading/error chrome. */
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
          <Link href="/recipes" className="text-sm text-primary hover:underline">
            ← {t('back')}
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="max-w-2xl space-y-4">
      <Link href="/recipes" className="text-sm text-primary hover:underline">
        ← {t('back')}
      </Link>
      <RecipeView recipe={recipe.data!} />
    </div>
  );
}
