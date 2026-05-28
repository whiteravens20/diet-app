'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import type { Profile, RecipeSearchPage } from '@diet-app/shared';
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
] as const;
const MEAL_TYPES = ['breakfast', 'second_breakfast', 'lunch', 'snack', 'dinner'] as const;
const DIFFICULTIES = ['easy', 'medium', 'hard'] as const;

/** Recipe library — search + filter; each card opens the full recipe. */
export default function RecipesPage() {
  const t = useTranslations('recipes');
  const tDiet = useTranslations('enums.dietType');
  const tMeal = useTranslations('enums.mealType');
  const tDifficulty = useTranslations('enums.difficulty');
  const [search, setSearch] = useState('');
  const [dietType, setDietType] = useState('');
  const [mealType, setMealType] = useState('');
  const [difficulty, setDifficulty] = useState('');
  const [maxCalories, setMaxCalories] = useState('');
  const [maxPrepMinutes, setMaxPrepMinutes] = useState('');
  const [usesFavorites, setUsesFavorites] = useState(false);
  const [favoritesProfileId, setFavoritesProfileId] = useState<string>('');
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 36;

  // Reset to page 1 whenever the filter set changes — React's "adjusting
  // state on prop change during render" pattern (preferred over useEffect
  // for derived resets; doesn't schedule an extra render).
  const filterKey = [search, dietType, mealType, difficulty, maxCalories, maxPrepMinutes].join('|');
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  if (lastFilterKey !== filterKey) {
    setLastFilterKey(filterKey);
    setPage(1);
  }

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
    p.set('page', String(page));
    p.set('pageSize', String(PAGE_SIZE));
    return `?${p.toString()}`;
  }, [search, dietType, mealType, difficulty, maxCalories, maxPrepMinutes, page]);

  const recipes = useQuery({
    queryKey: ['recipes', queryString],
    queryFn: () => api.get<RecipeSearchPage>(`/recipes${queryString}`),
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
    const list = recipes.data?.items ?? [];
    if (!usesFavorites || favoriteIds.size === 0) return list;
    return list.filter((r) => r.ingredients.some((i) => favoriteIds.has(i.ingredientId)));
  }, [recipes.data, usesFavorites, favoriteIds]);

  const totalPages = recipes.data?.totalPages ?? 0;
  const totalItems = recipes.data?.total ?? 0;

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
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subhead')}</p>
      </header>

      <div className="grid max-w-4xl gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label={t('search')}>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('searchPlaceholder')}
          />
        </Field>
        <Field label={t('dietType')}>
          <select className={selectClass} value={dietType} onChange={(e) => setDietType(e.target.value)}>
            <option value="">{t('any')}</option>
            {DIET_TYPES.map((d) => (
              <option key={d} value={d}>
                {tDiet(d)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('mealType')}>
          <select className={selectClass} value={mealType} onChange={(e) => setMealType(e.target.value)}>
            <option value="">{t('any')}</option>
            {MEAL_TYPES.map((m) => (
              <option key={m} value={m}>
                {tMeal(m)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('difficulty')}>
          <select className={selectClass} value={difficulty} onChange={(e) => setDifficulty(e.target.value)}>
            <option value="">{t('any')}</option>
            {DIFFICULTIES.map((d) => (
              <option key={d} value={d}>
                {tDifficulty(d)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('maxCalories')}>
          <Input
            type="number"
            min={0}
            value={maxCalories}
            onChange={(e) => setMaxCalories(e.target.value)}
            placeholder={t('maxCaloriesPlaceholder')}
          />
        </Field>
        <Field label={t('maxPrepMinutes')}>
          <Input
            type="number"
            min={0}
            value={maxPrepMinutes}
            onChange={(e) => setMaxPrepMinutes(e.target.value)}
            placeholder={t('maxPrepMinutesPlaceholder')}
          />
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        {anyServerFilter && (
          <Button type="button" variant="ghost" size="sm" onClick={resetFilters}>
            {t('clearFilters')}
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
              {t('usesFavorites')}
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
                {t('noFavorites', {
                  name: activeProfile?.name ?? t('noFavoritesFallback'),
                })}
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
            ? t('noneFavorites')
            : anyServerFilter || search
              ? t('noneFiltered')
              : t('noneAtAll')}
        </p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((r) => (
              <Link key={r.id} href={`/recipes/${r.id}`}>
                <Card className="h-full p-4 transition-shadow hover:shadow-md">
                  <p className="font-medium">{r.title}</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t('cardMeta', {
                      kcal: r.nutritionPerServing.calories,
                      difficulty: tDifficulty(r.difficulty),
                      minutes: r.prepMinutes + r.cookMinutes,
                    })}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {r.dietTags.map((d) => (
                      <span
                        key={d}
                        className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                      >
                        {tDiet.has(d) ? tDiet(d) : d.replace('_', ' ')}
                      </span>
                    ))}
                  </div>
                </Card>
              </Link>
            ))}
          </div>
          {totalPages > 1 && (
            <Pagination
              page={page}
              totalPages={totalPages}
              totalItems={totalItems}
              pageSize={PAGE_SIZE}
              onChange={setPage}
            />
          )}
        </>
      )}
    </div>
  );
}

function Pagination({
  page,
  totalPages,
  totalItems,
  pageSize,
  onChange,
}: {
  page: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  onChange: (p: number) => void;
}) {
  const t = useTranslations('recipes');
  // Sliding window: show current ± 2, plus first / last with ellipses where
  // there's a gap. Keeps the bar short on a 37-page library.
  const pages: (number | 'gap')[] = [];
  const lo = Math.max(2, page - 2);
  const hi = Math.min(totalPages - 1, page + 2);
  pages.push(1);
  if (lo > 2) pages.push('gap');
  for (let p = lo; p <= hi; p++) pages.push(p);
  if (hi < totalPages - 1) pages.push('gap');
  if (totalPages > 1) pages.push(totalPages);

  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, totalItems);

  return (
    <nav
      aria-label={t('pagination.label')}
      className="mt-4 flex flex-wrap items-center justify-between gap-3"
    >
      <p className="text-xs text-muted-foreground">
        {t('pagination.summary', { start, end, total: totalItems })}
      </p>
      <div className="flex items-center gap-1">
        <Button type="button" size="sm" variant="outline" disabled={page <= 1} onClick={() => onChange(page - 1)}>
          {t('pagination.prev')}
        </Button>
        {pages.map((p, idx) =>
          p === 'gap' ? (
            <span key={`gap-${idx}`} className="px-2 text-xs text-muted-foreground">
              …
            </span>
          ) : (
            <Button
              key={p}
              type="button"
              size="sm"
              variant={p === page ? 'primary' : 'outline'}
              onClick={() => onChange(p)}
            >
              {p}
            </Button>
          ),
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={page >= totalPages}
          onClick={() => onChange(page + 1)}
        >
          {t('pagination.next')}
        </Button>
      </div>
    </nav>
  );
}
