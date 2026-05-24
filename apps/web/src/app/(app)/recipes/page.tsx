'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { Profile, Recipe } from '@diet-app/shared';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

const selectClass = 'h-10 w-full rounded-md border border-border bg-background px-3 text-sm';

const DIET_TYPES = [
  'balanced',
  'high_protein',
  'low_carb',
  'vegetarian',
  'vegan',
  'keto',
  'mediterranean',
];
const MEAL_TYPES = ['breakfast', 'second_breakfast', 'lunch', 'snack', 'dinner'];
const DIFFICULTIES = ['easy', 'medium', 'hard'];

/** Recipe library — search + filter; each card opens the full recipe. */
export default function RecipesPage() {
  const [search, setSearch] = useState('');
  const [dietType, setDietType] = useState('');
  const [mealType, setMealType] = useState('');
  const [difficulty, setDifficulty] = useState('');
  const [maxCalories, setMaxCalories] = useState('');
  const [maxPrepMinutes, setMaxPrepMinutes] = useState('');
  const [usesFavorites, setUsesFavorites] = useState(false);
  const [favoritesProfileId, setFavoritesProfileId] = useState<string>('');

  // Server-side filters get encoded into the query string; client-side
  // favourites filter runs after the fetch.
  const queryString = useMemo(() => {
    const p = new URLSearchParams();
    if (search) p.set('search', search);
    if (dietType) p.set('dietType', dietType);
    if (mealType) p.set('mealType', mealType);
    if (difficulty) p.set('difficulty', difficulty);
    if (maxCalories) p.set('maxCalories', maxCalories);
    if (maxPrepMinutes) p.set('maxPrepMinutes', maxPrepMinutes);
    const s = p.toString();
    return s ? `?${s}` : '';
  }, [search, dietType, mealType, difficulty, maxCalories, maxPrepMinutes]);

  const recipes = useQuery({
    queryKey: ['recipes', queryString],
    queryFn: () => api.get<Recipe[]>(`/recipes${queryString}`),
  });

  const profiles = useQuery({
    queryKey: ['profiles'],
    queryFn: () => api.get<Profile[]>('/profiles'),
  });
  const profileList = profiles.data ?? [];
  const activeProfileId = favoritesProfileId || profileList[0]?.id || '';
  const activeProfile = profileList.find((p) => p.id === activeProfileId) ?? null;
  const favoriteIds = useMemo(
    () => new Set(activeProfile?.preferences.favoriteIngredientIds ?? []),
    [activeProfile],
  );

  const filtered = useMemo(() => {
    const list = recipes.data ?? [];
    if (!usesFavorites || favoriteIds.size === 0) return list;
    return list.filter((r) => r.ingredients.some((i) => favoriteIds.has(i.ingredientId)));
  }, [recipes.data, usesFavorites, favoriteIds]);

  const anyServerFilter = Boolean(
    dietType || mealType || difficulty || maxCalories || maxPrepMinutes,
  );

  function resetFilters() {
    setDietType('');
    setMealType('');
    setDifficulty('');
    setMaxCalories('');
    setMaxPrepMinutes('');
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Recipes</h1>
        <p className="text-sm text-muted-foreground">
          The curated recipe library — every calorie and macro is computed from the database.
        </p>
      </header>

      <div className="grid max-w-4xl gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Search">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Recipe title…"
          />
        </Field>
        <Field label="Diet type">
          <select className={selectClass} value={dietType} onChange={(e) => setDietType(e.target.value)}>
            <option value="">Any</option>
            {DIET_TYPES.map((d) => (
              <option key={d} value={d}>
                {d.replace('_', ' ')}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Meal type">
          <select className={selectClass} value={mealType} onChange={(e) => setMealType(e.target.value)}>
            <option value="">Any</option>
            {MEAL_TYPES.map((m) => (
              <option key={m} value={m}>
                {m.replace('_', ' ')}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Difficulty">
          <select className={selectClass} value={difficulty} onChange={(e) => setDifficulty(e.target.value)}>
            <option value="">Any</option>
            {DIFFICULTIES.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Max kcal/serving">
          <Input
            type="number"
            min={0}
            value={maxCalories}
            onChange={(e) => setMaxCalories(e.target.value)}
            placeholder="e.g. 600"
          />
        </Field>
        <Field label="Max prep minutes">
          <Input
            type="number"
            min={0}
            value={maxPrepMinutes}
            onChange={(e) => setMaxPrepMinutes(e.target.value)}
            placeholder="e.g. 20"
          />
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        {anyServerFilter && (
          <Button type="button" variant="ghost" size="sm" onClick={resetFilters}>
            Clear filters
          </Button>
        )}
        {profileList.length > 0 && (
          <>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={usesFavorites}
                onChange={(e) => setUsesFavorites(e.target.checked)}
              />
              Uses my favourite ingredients
            </label>
            <select
              className="h-9 rounded-md border border-border bg-background px-2 text-sm"
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
            {usesFavorites && favoriteIds.size === 0 && (
              <span className="text-xs text-muted-foreground">
                {activeProfile?.name ?? 'This profile'} has no favourites yet — set them on the
                profile page.
              </span>
            )}
          </>
        )}
      </div>

      {recipes.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {usesFavorites && favoriteIds.size > 0
            ? 'No recipes match the filters and your favourite ingredients.'
            : anyServerFilter || search
              ? 'No recipes match the current filters.'
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
