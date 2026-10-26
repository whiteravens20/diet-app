// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Star } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import type { FavoriteSort, MarkedRecipe, Profile } from '@diet-app/shared';
import { FAVORITE_SENTIMENTS, MEAL_TYPES } from '@diet-app/shared/constants';
import { api } from '@/lib/api';
import { useErrorText } from '@/lib/use-error-text';
import { useFormat } from '@/lib/use-format';
import { IMAGERY } from '@/lib/imagery';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/empty-state';
import { LoadFailed } from '@/components/load-failed';
import { PageBanner } from '@/components/page-banner';
import { RecipeModal } from '@/components/recipe-modal';

const selectClass = 'h-10 w-full rounded-md border border-input bg-background px-3 text-sm';

/** The most tags a marked recipe holds, and the longest a tag is: the API's own bounds. */
const MOST_TAGS = 20;
const LONGEST_TAG = 40;

const SORTS: readonly FavoriteSort[] = ['newest', 'title', 'calories'];

/** What a mark is changed to: how the recipe is marked, the tags it has, or both. */
type Change = Partial<Pick<MarkedRecipe, 'sentiment' | 'tags'>>;

/**
 * The recipes a profile marked, to look through and to keep in order: each
 * says how it is marked (a favourite, eaten often, to avoid) and under which
 * tags of the profile's own, and both can be changed where they are shown.
 */
export default function FavoritesPage() {
  const t = useTranslations('favorites');
  const tMeal = useTranslations('enums.mealType');
  const errorText = useErrorText();
  const fmt = useFormat();
  const qc = useQueryClient();

  const profiles = useQuery({
    queryKey: ['profiles'],
    queryFn: () => api.get<Profile[]>('/profiles'),
  });
  const profileList = profiles.data ?? [];
  const [picked, setPicked] = useState<string | null>(null);
  const profileId = picked ?? profileList[0]?.id ?? null;

  const [search, setSearch] = useState('');
  const [mealType, setMealType] = useState('');
  const [sentiment, setSentiment] = useState('');
  const [tag, setTag] = useState('');
  const [sort, setSort] = useState<FavoriteSort>('newest');
  const [error, setError] = useState<string | null>(null);
  const [openRecipe, setOpenRecipe] = useState<string | null>(null);

  const query = useMemo(() => {
    const p = new URLSearchParams({ profileId: profileId ?? '' });
    if (search) p.set('search', search);
    if (mealType) p.set('mealType', mealType);
    if (sentiment) p.set('sentiment', sentiment);
    if (tag) p.set('tag', tag);
    if (sort !== 'newest') p.set('sort', sort);
    return p.toString();
  }, [profileId, search, mealType, sentiment, tag, sort]);
  const narrowed = Boolean(search || mealType || sentiment || tag);

  // Every mark of the profile: the tags to choose from come from all of them, not from what a filter leaves.
  const all = useQuery({
    queryKey: ['favorites', profileId],
    queryFn: () => api.get<MarkedRecipe[]>(`/favorites?profileId=${profileId}`),
    enabled: Boolean(profileId),
  });
  const marks = useQuery({
    queryKey: ['favorites', profileId, query],
    queryFn: () => api.get<MarkedRecipe[]>(`/favorites?${query}`),
    enabled: Boolean(profileId),
  });
  const tags = useMemo(
    () =>
      [...new Set((all.data ?? []).flatMap((marked) => marked.tags))].sort((a, b) =>
        a.localeCompare(b),
      ),
    [all.data],
  );

  const refresh = () => qc.invalidateQueries({ queryKey: ['favorites', profileId] });
  // What is on its way to the API is shown from the moment it was chosen, and taken back when it is refused.
  const [sending, setSending] = useState<{ id: string; change: Change } | null>(null);
  const save = useMutation({
    mutationFn: (v: { marked: MarkedRecipe; change: Change }) =>
      api.post('/favorites', {
        profileId,
        recipeId: v.marked.recipe.id,
        sentiment: v.change.sentiment ?? v.marked.sentiment,
        tags: v.change.tags ?? v.marked.tags,
      }),
    onSuccess: refresh,
    onError: (e) => setError(errorText(e, t('errSave'))),
    onSettled: () => setSending(null),
  });
  const change = (marked: MarkedRecipe, to: Change) => {
    setError(null);
    setSending({ id: marked.id, change: to });
    save.mutate({ marked, change: to });
  };
  const shown = (marked: MarkedRecipe): MarkedRecipe =>
    sending?.id === marked.id ? { ...marked, ...sending.change } : marked;
  const remove = useMutation({
    mutationFn: (marked: MarkedRecipe) =>
      api.delete<void>(`/favorites/${profileId}/${marked.recipe.id}`),
    onSuccess: refresh,
    onError: (e) => setError(errorText(e, t('errRemove'))),
  });
  const busy = save.isPending || remove.isPending;

  if (profiles.isLoading) return <Skeleton className="h-40 max-w-2xl" />;
  if (profiles.isError)
    return <LoadFailed error={profiles.error} onRetry={() => void profiles.refetch()} />;
  if (profileList.length === 0) {
    return (
      <div className="mt-16">
        <EmptyState
          icon={Star}
          title={t('noProfile')}
          description={t('noProfileBody')}
          cta={
            <Link href="/profile" className={buttonVariants({ size: 'md' })}>
              {t('noProfileCta')}
            </Link>
          }
        />
      </div>
    );
  }

  const list = marks.data ?? [];
  return (
    <div className="space-y-8">
      <PageBanner image={IMAGERY.recipes} title={t('title')} subtitle={t('subhead')} />

      {profileList.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {profileList.map((p) => (
            <Button
              key={p.id}
              type="button"
              variant={p.id === profileId ? 'primary' : 'outline'}
              size="sm"
              onClick={() => {
                setPicked(p.id);
                // Tags are a profile's own: one of another profile's finds nothing here.
                setTag('');
                setError(null);
              }}
            >
              {p.name}
            </Button>
          ))}
        </div>
      )}

      <div className="grid max-w-4xl gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Field label={t('search')}>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('searchPlaceholder')}
          />
        </Field>
        <Field label={t('mealType')}>
          <select
            className={selectClass}
            value={mealType}
            onChange={(e) => setMealType(e.target.value)}
          >
            <option value="">{t('any')}</option>
            {MEAL_TYPES.map((meal) => (
              <option key={meal} value={meal}>
                {tMeal(meal)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('marked')}>
          <select
            className={selectClass}
            value={sentiment}
            onChange={(e) => setSentiment(e.target.value)}
          >
            <option value="">{t('any')}</option>
            {FAVORITE_SENTIMENTS.map((kind) => (
              <option key={kind} value={kind}>
                {t(`sentiment.${kind}`)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('tag')}>
          <select className={selectClass} value={tag} onChange={(e) => setTag(e.target.value)}>
            <option value="">{t('any')}</option>
            {tags.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('sort')}>
          <select
            className={selectClass}
            value={sort}
            onChange={(e) => setSort(e.target.value as FavoriteSort)}
          >
            {SORTS.map((order) => (
              <option key={order} value={order}>
                {t(`sortBy.${order}`)}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <p className="max-w-3xl text-xs text-muted-foreground">{t('legend')}</p>

      {error && (
        <p role="alert" className="max-w-3xl text-sm text-destructive">
          {error}
        </p>
      )}

      {marks.isLoading ? (
        <Skeleton className="h-24 max-w-3xl" />
      ) : marks.isError ? (
        <LoadFailed error={marks.error} onRetry={() => void marks.refetch()} />
      ) : list.length === 0 ? (
        narrowed ? (
          <p className="text-sm text-muted-foreground">{t('noneFiltered')}</p>
        ) : (
          <EmptyState
            icon={Star}
            title={t('emptyTitle')}
            description={t('emptyBody')}
            cta={
              <Link href="/recipes" className={buttonVariants({ size: 'md' })}>
                {t('emptyCta')}
              </Link>
            }
          />
        )
      ) : (
        <>
          <p className="text-sm text-muted-foreground">{t('count', { count: list.length })}</p>
          <ul className="max-w-3xl space-y-3">
            {list.map((kept) => {
              const marked = shown(kept);
              return (
                <li key={marked.id}>
                  <Card>
                    <CardContent className="space-y-3 p-4">
                      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                        <div className="min-w-0">
                          <button
                            type="button"
                            className="text-left font-medium text-primary hover:underline"
                            onClick={() => setOpenRecipe(marked.recipe.id)}
                          >
                            {marked.recipe.title}
                          </button>
                          <p className="text-xs text-muted-foreground">
                            {t('facts', {
                              kcal: marked.recipe.nutritionPerServing.calories,
                              meals: fmt.list(marked.recipe.mealTypes.map((meal) => tMeal(meal))),
                            })}
                          </p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <select
                            aria-label={t('markedAs', { title: marked.recipe.title })}
                            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                            value={marked.sentiment}
                            disabled={busy}
                            onChange={(e) =>
                              change(kept, {
                                sentiment: e.target.value as MarkedRecipe['sentiment'],
                              })
                            }
                          >
                            {FAVORITE_SENTIMENTS.map((kind) => (
                              <option key={kind} value={kind}>
                                {t(`sentiment.${kind}`)}
                              </option>
                            ))}
                          </select>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="text-destructive"
                            disabled={busy}
                            aria-label={t('removeOf', { title: marked.recipe.title })}
                            onClick={() => {
                              setError(null);
                              remove.mutate(kept);
                            }}
                          >
                            {t('remove')}
                          </Button>
                        </div>
                      </div>
                      <Tags
                        marked={marked}
                        busy={busy}
                        onChange={(next) => change(kept, { tags: next })}
                      />
                    </CardContent>
                  </Card>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <RecipeModal recipeId={openRecipe} onClose={() => setOpenRecipe(null)} />
    </div>
  );
}

/** The tags of a marked recipe: each can be taken off, and another put on, up to the most a recipe holds. */
function Tags({
  marked,
  busy,
  onChange,
}: {
  marked: MarkedRecipe;
  busy: boolean;
  onChange: (tags: string[]) => void;
}) {
  const t = useTranslations('favorites');
  const [typed, setTyped] = useState('');
  const full = marked.tags.length >= MOST_TAGS;
  return (
    <div className="space-y-2">
      {marked.tags.length > 0 && (
        <ul
          className="flex flex-wrap gap-1.5"
          aria-label={t('tagsOf', { title: marked.recipe.title })}
        >
          {marked.tags.map((name) => (
            <li
              key={name}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-xs"
            >
              {name}
              <button
                type="button"
                aria-label={t('removeTag', { tag: name })}
                className="text-muted-foreground hover:text-destructive disabled:opacity-50"
                disabled={busy}
                onClick={() => onChange(marked.tags.filter((other) => other !== name))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const name = typed.trim();
          // A tag a recipe has already is not put on it a second time.
          if (name && !marked.tags.includes(name)) onChange([...marked.tags, name]);
          setTyped('');
        }}
      >
        <Input
          aria-label={t('newTagOf', { title: marked.recipe.title })}
          className="h-9 max-w-48"
          value={typed}
          maxLength={LONGEST_TAG}
          placeholder={t('newTag')}
          required
          disabled={busy || full}
          onChange={(e) => setTyped(e.target.value)}
        />
        <Button type="submit" variant="outline" size="sm" disabled={busy || full}>
          {t('addTag')}
        </Button>
        {full && (
          <span className="text-xs text-muted-foreground">{t('tagsFull', { max: MOST_TAGS })}</span>
        )}
      </form>
    </div>
  );
}
