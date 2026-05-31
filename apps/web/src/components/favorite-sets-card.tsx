'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type {
  CreateFavoriteSetRequest,
  FavoriteSet,
  FavoriteSetSlots,
  MealType,
} from '@diet-app/shared';
import { api, ApiClientError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';

const SLOTS: MealType[] = ['breakfast', 'second_breakfast', 'lunch', 'snack', 'dinner'];

interface FavoriteRecipe {
  id: string;
  recipe: { id: string; title: string; mealTypes: string[] };
}

/**
 * Per-profile favourite-sets management. Pulls the profile's favourites and
 * lets the user compose a named day-template by picking one favourite per meal
 * slot. Empty slots are allowed — when the set is later applied to a plan day,
 * empty slots leave the day's existing meal untouched.
 */
export function FavoriteSetsCard({ profileId }: { profileId: string }) {
  const t = useTranslations('favoriteSets');
  const tMeal = useTranslations('enums.mealType');
  const qc = useQueryClient();
  const [composing, setComposing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setsQ = useQuery({
    queryKey: ['favorite-sets', profileId],
    queryFn: () => api.get<FavoriteSet[]>(`/favorite-sets?profileId=${profileId}`),
  });

  const favoritesQ = useQuery({
    queryKey: ['favorites', profileId],
    queryFn: () => api.get<FavoriteRecipe[]>(`/favorites?profileId=${profileId}`),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['favorite-sets', profileId] });

  const create = useMutation({
    mutationFn: (body: CreateFavoriteSetRequest) => api.post<FavoriteSet>('/favorite-sets', body),
    onSuccess: () => {
      invalidate();
      setComposing(false);
    },
    onError: (e) => setError(e instanceof ApiClientError ? e.message : t('errCreate')),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete<void>(`/favorite-sets/${id}`),
    onSuccess: invalidate,
    onError: (e) => setError(e instanceof ApiClientError ? e.message : t('errDelete')),
  });

  const sets = setsQ.data ?? [];
  const favorites = favoritesQ.data ?? [];
  const hasFavorites = favorites.length > 0;

  function onCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const f = new FormData(event.currentTarget);
    const label = String(f.get('label') ?? '').trim();
    const slots: FavoriteSetSlots = {};
    for (const slot of SLOTS) {
      const value = String(f.get(`slot_${slot}`) ?? '').trim();
      if (value) slots[slot] = value;
    }
    if (Object.keys(slots).length === 0) {
      setError(t('atLeastOne'));
      return;
    }
    create.mutate({ profileId, label, slots });
  }

  function recipeTitle(recipeId: string): string {
    return favorites.find((f) => f.recipe.id === recipeId)?.recipe.title ?? recipeId;
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle>{t('title')}</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        {!composing && hasFavorites && (
          <Button type="button" size="sm" variant="outline" onClick={() => setComposing(true)}>
            {t('newSet')}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {!hasFavorites && (
          <p className="text-sm text-muted-foreground">{t('noFavorites')}</p>
        )}
        {hasFavorites && sets.length === 0 && !composing && (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        )}
        {sets.length > 0 && (
          <ul className="divide-y divide-border">
            {sets.map((s) => (
              <li key={s.id} className="flex items-start justify-between gap-4 py-2">
                <div className="min-w-0">
                  <p className="font-medium">{s.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {Object.entries(s.slots)
                      .map(([slot, recipeId]) =>
                        `${tMeal.has(slot) ? tMeal(slot as MealType) : slot}: ${recipeTitle(recipeId)}`,
                      )
                      .join(' · ')}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="shrink-0 text-destructive"
                  onClick={() => remove.mutate(s.id)}
                  disabled={remove.isPending}
                >
                  {t('delete')}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {composing && hasFavorites && (
          <form onSubmit={onCreate} className="space-y-3 border-t border-border pt-4">
            <Field label={t('label')}>
              <Input name="label" required maxLength={80} placeholder={t('labelPlaceholder')} />
            </Field>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">{t('slotsHeading')}</legend>
              <p className="text-xs text-muted-foreground">{t('slotsHint')}</p>
              {SLOTS.map((slot) => {
                const slotFavorites = favorites.filter((f) => f.recipe.mealTypes.includes(slot));
                return (
                  <label key={slot} className="flex items-center gap-2 text-sm">
                    <span className="w-32 shrink-0 text-muted-foreground">
                      {tMeal.has(slot) ? tMeal(slot) : slot}
                    </span>
                    <select
                      name={`slot_${slot}`}
                      className="flex-1 rounded-md border border-input bg-background px-2 py-1 text-sm"
                      defaultValue=""
                    >
                      <option value="">— {t('pickRecipe')} —</option>
                      {slotFavorites.map((f) => (
                        <option key={f.recipe.id} value={f.recipe.id}>
                          {f.recipe.title}
                        </option>
                      ))}
                    </select>
                  </label>
                );
              })}
            </fieldset>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={create.isPending}>
                {t('save')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setComposing(false);
                  setError(null);
                }}
              >
                {t('cancel')}
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
