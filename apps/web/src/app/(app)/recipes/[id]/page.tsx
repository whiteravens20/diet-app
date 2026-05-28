'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Star } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
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

  // Which profile's ingredient prefs we're editing from this recipe view.
  // Defaults to the first profile; user can switch via the dropdown if they
  // have more than one. Kept null until profiles load to avoid flashing the
  // wrong selection.
  const [prefsProfileId, setPrefsProfileId] = useState<string | null>(null);
  const [prefsError, setPrefsError] = useState<string | null>(null);

  // PUT /profiles/:id is full-replace, so the mutation sends every field of
  // the target profile back, only swapping `preferences`. Mirrors the pattern
  // in profile/page.tsx so the contract stays in one mental model.
  const savePrefs = useMutation({
    mutationFn: (v: { profile: Profile; preferences: Profile['preferences'] }) =>
      api.put<Profile>(`/profiles/${v.profile.id}`, {
        name: v.profile.name,
        age: v.profile.age,
        sex: v.profile.sex,
        heightCm: v.profile.heightCm,
        weightKg: v.profile.weightKg,
        activityLevel: v.profile.activityLevel,
        dietType: v.profile.dietType,
        weeklyLossTarget: v.profile.weeklyLossTarget,
        manualCalorieTarget: v.profile.manualCalorieTarget,
        mealCount: v.profile.mealCount,
        preferences: v.preferences,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['profiles'] }),
    onError: (e) =>
      setPrefsError(e instanceof ApiClientError ? e.message : t('prefsSaveFailed')),
  });

  function toggleIngredientPref(
    ingredientId: string,
    target: 'favorite' | 'avoid',
  ): void {
    const profile = profileList.find((p) => p.id === prefsProfileId) ?? profileList[0];
    if (!profile) return;
    setPrefsError(null);
    const favs = new Set(profile.preferences.favoriteIngredientIds);
    const excl = new Set(profile.preferences.excludedIngredientIds);
    if (target === 'favorite') {
      if (favs.has(ingredientId)) {
        favs.delete(ingredientId);
      } else {
        favs.add(ingredientId);
        excl.delete(ingredientId);
      }
    } else {
      if (excl.has(ingredientId)) {
        excl.delete(ingredientId);
      } else {
        excl.add(ingredientId);
        favs.delete(ingredientId);
      }
    }
    savePrefs.mutate({
      profile,
      preferences: {
        ...profile.preferences,
        favoriteIngredientIds: Array.from(favs),
        excludedIngredientIds: Array.from(excl),
      },
    });
  }

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
  const activePrefsProfile =
    profileList.find((p) => p.id === prefsProfileId) ?? profileList[0] ?? null;
  const favIngredientSet = new Set(activePrefsProfile?.preferences.favoriteIngredientIds ?? []);
  const excludedIngredientSet = new Set(
    activePrefsProfile?.preferences.excludedIngredientIds ?? [],
  );

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
          {activePrefsProfile && profileList.length > 1 && (
            <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">{t('prefsFor')}</span>
              <select
                value={activePrefsProfile.id}
                onChange={(e) => setPrefsProfileId(e.target.value)}
                className="rounded border border-input bg-background px-2 py-1 text-sm"
              >
                {profileList.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          {prefsError && (
            <p className="mb-2 text-xs text-destructive">{prefsError}</p>
          )}
          <ul className="space-y-1 text-sm">
            {r.ingredients.map((i) => {
              const isFav = favIngredientSet.has(i.ingredientId);
              const isExcl = excludedIngredientSet.has(i.ingredientId);
              return (
                <li key={i.ingredientId} className="flex items-center justify-between gap-4">
                  <span className="flex-1">
                    {i.name}
                    {i.note ? <span className="text-muted-foreground"> — {i.note}</span> : null}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {formatIngredientAmount(i)}
                  </span>
                  {activePrefsProfile && (
                    <span className="flex items-center gap-1">
                      <button
                        type="button"
                        title={isFav ? t('clearMark') : t('markFavorite')}
                        aria-pressed={isFav}
                        aria-label={t('markFavorite')}
                        disabled={savePrefs.isPending}
                        onClick={() => toggleIngredientPref(i.ingredientId, 'favorite')}
                        className={
                          'rounded p-1 transition-colors hover:bg-muted disabled:opacity-50 ' +
                          (isFav ? 'text-amber-500' : 'text-muted-foreground')
                        }
                      >
                        <Star
                          className="h-4 w-4"
                          fill={isFav ? 'currentColor' : 'none'}
                          strokeWidth={1.75}
                        />
                      </button>
                      <button
                        type="button"
                        title={isExcl ? t('clearMark') : t('markAvoid')}
                        aria-pressed={isExcl}
                        aria-label={t('markAvoid')}
                        disabled={savePrefs.isPending}
                        onClick={() => toggleIngredientPref(i.ingredientId, 'avoid')}
                        className={
                          'rounded p-1 transition-colors hover:bg-muted disabled:opacity-50 ' +
                          (isExcl ? 'text-destructive' : 'text-muted-foreground')
                        }
                      >
                        <Ban className="h-4 w-4" strokeWidth={1.75} />
                      </button>
                    </span>
                  )}
                </li>
              );
            })}
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
