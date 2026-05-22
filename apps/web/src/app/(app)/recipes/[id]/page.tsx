'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import type { Recipe } from '@diet-app/shared';
import { api, ApiClientError } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/** Full recipe view — opened from the library or a planned meal. */
export default function RecipeDetailPage() {
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
          <CardTitle>{notFound ? 'Recipe not found' : 'Could not load recipe'}</CardTitle>
        </CardHeader>
        <CardContent>
          <Link href="/recipes" className="text-sm text-primary hover:underline">
            ← Back to recipes
          </Link>
        </CardContent>
      </Card>
    );
  }

  const r = recipe.data!;
  const n = r.nutritionPerServing;

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <Link href="/recipes" className="text-sm text-primary hover:underline">
          ← Recipes
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{r.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{r.description}</p>
        <div className="mt-2 flex flex-wrap gap-1">
          {[r.difficulty, ...r.mealTypes, ...r.dietTags].map((tag) => (
            <span
              key={tag}
              className="rounded bg-muted px-1.5 py-0.5 text-xs capitalize text-muted-foreground"
            >
              {tag.replace('_', ' ')}
            </span>
          ))}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Per serving</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-4 gap-4 text-center">
            {[
              ['Calories', `${n.calories}`],
              ['Protein', `${n.protein} g`],
              ['Fat', `${n.fat} g`],
              ['Carbs', `${n.carbs} g`],
            ].map(([label, value]) => (
              <div key={label}>
                <p className="text-lg font-semibold">{value}</p>
                <p className="text-xs text-muted-foreground">{label}</p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-sm text-muted-foreground">
            Makes {r.servings} serving{r.servings === 1 ? '' : 's'} · {r.prepMinutes} min prep ·{' '}
            {r.cookMinutes} min cook
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Ingredients</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-1 text-sm">
            {r.ingredients.map((i) => (
              <li key={i.ingredientId} className="flex justify-between gap-4">
                <span>
                  {i.name}
                  {i.note ? <span className="text-muted-foreground"> — {i.note}</span> : null}
                </span>
                <span className="tabular-nums text-muted-foreground">
                  {i.quantity} {i.unit}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Method</CardTitle>
        </CardHeader>
        <CardContent>
          <ol className="space-y-2 text-sm">
            {r.steps.map((step, i) => (
              <li key={i} className="flex gap-3">
                <span className="font-medium text-muted-foreground">{i + 1}.</span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      {r.allergens.length > 0 && (
        <p className="text-sm text-muted-foreground">
          <span className="font-medium">Allergens:</span> {r.allergens.join(', ')}
        </p>
      )}
    </div>
  );
}
