'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { Profile, Recipe } from '@diet-app/shared';
import { api } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

const selectClass = 'h-10 w-full rounded-md border border-border bg-background px-3 text-sm';

/** Recipe library — search and browse; each card opens the full recipe. */
export default function RecipesPage() {
  const [search, setSearch] = useState('');
  const [usesFavorites, setUsesFavorites] = useState(false);
  const [favoritesProfileId, setFavoritesProfileId] = useState<string>('');

  const recipes = useQuery({
    queryKey: ['recipes', search],
    queryFn: () =>
      api.get<Recipe[]>(`/recipes${search ? `?search=${encodeURIComponent(search)}` : ''}`),
  });

  // Profiles drive the favourites filter — each profile has its own list.
  const profiles = useQuery({
    queryKey: ['profiles'],
    queryFn: () => api.get<Profile[]>('/profiles'),
  });
  const profileList = profiles.data ?? [];
  // Default the profile picker to the first profile so the checkbox does
  // something on the very first click.
  const activeProfileId = favoritesProfileId || profileList[0]?.id || '';
  const activeProfile = profileList.find((p) => p.id === activeProfileId) ?? null;
  const favoriteIds = useMemo(
    () => new Set(activeProfile?.preferences.favoriteIngredientIds ?? []),
    [activeProfile],
  );

  // Apply the favourites filter client-side: we already have each recipe's
  // ingredient ids, no extra round-trip needed.
  const filtered = useMemo(() => {
    const list = recipes.data ?? [];
    if (!usesFavorites || favoriteIds.size === 0) return list;
    return list.filter((r) => r.ingredients.some((i) => favoriteIds.has(i.ingredientId)));
  }, [recipes.data, usesFavorites, favoriteIds]);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Recipes</h1>
        <p className="text-sm text-muted-foreground">
          The curated recipe library — every calorie and macro is computed from the database.
        </p>
      </header>

      <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
        <Field label="Search">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Recipe title…"
          />
        </Field>
        {profileList.length > 0 && (
          <Field label="Filter by favourites of">
            <select
              className={selectClass}
              value={activeProfileId}
              onChange={(e) => setFavoritesProfileId(e.target.value)}
              disabled={!usesFavorites}
            >
              {profileList.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>

      {profileList.length > 0 && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={usesFavorites}
            onChange={(e) => setUsesFavorites(e.target.checked)}
          />
          Uses my favourite ingredients
          {usesFavorites && favoriteIds.size === 0 && (
            <span className="text-xs text-muted-foreground">
              — {activeProfile?.name ?? 'this profile'} has no favourites yet, set them on
              the profile page.
            </span>
          )}
        </label>
      )}

      {recipes.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {usesFavorites && favoriteIds.size > 0
            ? 'No recipes use any of your favourite ingredients yet.'
            : search
              ? `No recipes match “${search}”.`
              : 'No recipes.'}
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((r) => (
            <Link key={r.id} href={`/recipes/${r.id}`}>
              <Card className="h-full p-4 transition-shadow hover:shadow-md">
                <p className="font-medium">{r.title}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {r.nutritionPerServing.calories} kcal · {r.difficulty} ·{' '}
                  {r.prepMinutes + r.cookMinutes} min
                </p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {r.dietTags.map((d) => (
                    <span
                      key={d}
                      className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                    >
                      {d.replace('_', ' ')}
                    </span>
                  ))}
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
