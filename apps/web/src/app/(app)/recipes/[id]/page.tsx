'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { Profile, Recipe } from '@diet-app/shared';
import { api, ApiClientError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatIngredientAmount } from '@/lib/ingredient-format';

interface FavoriteRow {
  id: string;
  recipe: { id: string };
}

/** Full recipe view — opened from the library or a planned meal. */
export default function RecipeDetailPage() {
  const t = useTranslations('recipeDetail');
  const tDifficulty = useTranslations('enums.difficulty');
  const tMeal = useTranslations('enums.mealType');
  const tDiet = useTranslations('enums.dietType');
  const tAllergen = useTranslations('enums.allergen');
  const params = useParams<{ id: string }>();
  const qc = useQueryClient();
  const recipe = useQuery({
    queryKey: ['recipe', params.id],
    queryFn: () => api.get<Recipe>(`/recipes/${params.id}`),
    retry: false,
  });

  const profiles = useQuery({ queryKey: ['profiles'], queryFn: () => api.get<Profile[]>('/profiles') });

  // Map of profileId → set of favorited recipe ids, so we can show a single
  // toggle per profile without an extra round-trip per profile.
  const favorites = useQuery({
    queryKey: ['favorites-index'],
    enabled: (profiles.data ?? []).length > 0,
    queryFn: async () => {
      const ps = profiles.data ?? [];
      const entries = await Promise.all(
        ps.map(async (p) => {
          const rows = await api.get<FavoriteRow[]>(`/favorites?profileId=${p.id}`);
          return [p.id, new Set(rows.map((f) => f.recipe.id))] as const;
        }),
      );
      return new Map(entries);
    },
  });

  const addFav = useMutation({
    mutationFn: (profileId: string) =>
      api.post('/favorites', { profileId, recipeId: params.id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['favorites-index'] }),
  });
  const removeFav = useMutation({
    mutationFn: (profileId: string) => api.delete(`/favorites/${profileId}/${params.id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['favorites-index'] }),
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

  const r = recipe.data!;
  const n = r.nutritionPerServing;
  const profileList = profiles.data ?? [];
  const favIndex = favorites.data ?? new Map<string, Set<string>>();

  function tagLabel(tag: string): string {
    if (tDifficulty.has(tag)) return tDifficulty(tag);
    if (tMeal.has(tag)) return tMeal(tag);
    if (tDiet.has(tag)) return tDiet(tag);
    return tag.replace('_', ' ');
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <Link href="/recipes" className="text-sm text-primary hover:underline">
          ← {t('back')}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{r.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{r.description}</p>
        <div className="mt-2 flex flex-wrap gap-1">
          {[r.difficulty, ...r.mealTypes, ...r.dietTags].map((tag) => (
            <span
              key={tag}
              className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
            >
              {tagLabel(tag)}
            </span>
          ))}
        </div>
      </div>

      {profileList.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">{t('saveToFavorites')}</span>
          {profileList.map((p) => {
            const saved = favIndex.get(p.id)?.has(r.id) ?? false;
            const busy = addFav.isPending || removeFav.isPending;
            return (
              <Button
                key={p.id}
                type="button"
                variant={saved ? 'primary' : 'outline'}
                size="sm"
                disabled={busy}
                onClick={() => (saved ? removeFav.mutate(p.id) : addFav.mutate(p.id))}
              >
                {saved ? '★' : '☆'} {p.name}
              </Button>
            );
          })}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t('perServing')}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-4 gap-4 text-center">
            {[
              [t('calories'), `${n.calories}`],
              [t('protein'), `${n.protein} g`],
              [t('fat'), `${n.fat} g`],
              [t('carbs'), `${n.carbs} g`],
            ].map(([label, value]) => (
              <div key={label}>
                <p className="text-lg font-semibold">{value}</p>
                <p className="text-xs text-muted-foreground">{label}</p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-sm text-muted-foreground">
            {t('servingMeta', {
              servings: r.servings,
              prep: r.prepMinutes,
              cook: r.cookMinutes,
            })}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('ingredients')}</CardTitle>
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
                  {formatIngredientAmount(i)}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('method')}</CardTitle>
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
          <span className="font-medium">{t('allergens')}</span>{' '}
          {r.allergens.map((a) => tAllergen(a)).join(', ')}
        </p>
      )}
    </div>
  );
}
