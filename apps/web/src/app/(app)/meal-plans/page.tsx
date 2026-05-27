'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import type { GeneratePlanRequest, MealPlan, Profile } from '@diet-app/shared';
import { api, ApiClientError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { formatIngredientAmount } from '@/lib/ingredient-format';
import { IngredientSubstituteModal } from '@/components/ingredient-substitute-modal';

const today = () => new Date().toISOString().slice(0, 10);

function MealPlansContent() {
  const qc = useQueryClient();
  const params = useSearchParams();
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: () => api.get<Profile[]>('/profiles') });
  const list = profiles.data ?? [];

  // Active profile: explicit pick → ?profile= deep link → first profile.
  const [picked, setPicked] = useState<string | null>(null);
  const activeId = picked ?? params.get('profile') ?? list[0]?.id ?? null;
  const active = list.find((p) => p.id === activeId) ?? null;

  const [error, setError] = useState<string | null>(null);
  const [openPlan, setOpenPlan] = useState<string | null>(null);
  const [status, setStatus] = useState<'' | 'active' | 'past' | 'upcoming'>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const plans = useQuery({
    queryKey: ['meal-plans', activeId, status, from, to],
    queryFn: () => {
      const qp = new URLSearchParams({ profileId: activeId! });
      if (status) qp.set('status', status);
      if (from) qp.set('from', from);
      if (to) qp.set('to', to);
      return api.get<MealPlan[]>(`/meal-plans?${qp}`);
    },
    enabled: Boolean(activeId),
  });

  const favorites = useQuery({
    queryKey: ['favorites', activeId],
    queryFn: () =>
      api.get<{ recipe: { id: string; title: string; mealTypes: string[] } }[]>(
        `/favorites?profileId=${activeId}`,
      ),
    enabled: Boolean(activeId),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['meal-plans', activeId] });
  const fail = (verb: string) => (e: unknown) =>
    setError(e instanceof ApiClientError ? e.message : `Could not ${verb}.`);

  const generate = useMutation({
    mutationFn: (body: GeneratePlanRequest) => api.post<MealPlan>('/meal-plans/generate', body),
    onSuccess: (plan) => {
      invalidate();
      setOpenPlan(plan.id);
    },
    onError: fail('generate the plan'),
  });

  const regenerate = useMutation({
    mutationFn: (planId: string) => api.post<MealPlan>(`/meal-plans/${planId}/regenerate`),
    onSuccess: invalidate,
    onError: fail('recalculate the plan'),
  });

  const regenerateDay = useMutation({
    mutationFn: (v: { planId: string; dayId: string }) =>
      api.post<MealPlan>(`/meal-plans/${v.planId}/days/${v.dayId}/regenerate`),
    onSuccess: invalidate,
    onError: fail('change the day'),
  });

  const swapMeal = useMutation({
    mutationFn: (v: {
      planId: string;
      plannedMealId: string;
      strategy: 'random' | 'favorite' | 'favorite_ingredients';
      favoriteRecipeId?: string;
    }) =>
      api.post<MealPlan>('/meal-plans/swap-meal', {
        planId: v.planId,
        plannedMealId: v.plannedMealId,
        strategy: v.strategy,
        ...(v.favoriteRecipeId ? { favoriteRecipeId: v.favoriteRecipeId } : {}),
      }),
    onSuccess: invalidate,
    onError: fail('swap the meal'),
  });

  const remove = useMutation({
    mutationFn: (planId: string) => api.delete<void>(`/meal-plans/${planId}`),
    onSuccess: invalidate,
    onError: fail('delete the plan'),
  });

  const busy =
    regenerate.isPending || regenerateDay.isPending || swapMeal.isPending || remove.isPending;

  function onGenerate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!activeId) return;
    const f = new FormData(event.currentTarget);
    generate.mutate({
      profileId: activeId,
      startDate: String(f.get('startDate')),
      durationDays: Number(f.get('durationDays')),
      mealPrepFriendly: f.get('mealPrepFriendly') === 'on',
      respectExclusions: f.get('respectExclusions') === 'on',
      respectFavorites: f.get('respectFavorites') === 'on',
    });
  }

  if (profiles.isLoading) return <Skeleton className="h-40 max-w-2xl" />;

  if (list.length === 0) {
    return (
      <Card className="mx-auto mt-20 max-w-md text-center">
        <CardHeader>
          <CardTitle>No profile yet</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Create a profile first — a meal plan is generated against its calorie target.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Meal plans</h1>
        <p className="text-sm text-muted-foreground">
          Deterministic, calorie-targeted plans — generated per profile.
        </p>
      </header>

      {list.length > 1 && (
        <div className="flex gap-2">
          {list.map((p) => (
            <Button
              key={p.id}
              type="button"
              variant={p.id === activeId ? 'primary' : 'outline'}
              size="sm"
              onClick={() => {
                setPicked(p.id);
                setOpenPlan(null);
                setError(null);
              }}
            >
              {p.name}
            </Button>
          ))}
        </div>
      )}

      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>Generate a plan{active ? ` for ${active.name}` : ''}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onGenerate} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Start date">
                <Input name="startDate" type="date" required defaultValue={today()} />
              </Field>
              <Field label="Duration (days)">
                <Input
                  name="durationDays"
                  type="number"
                  required
                  min={1}
                  max={28}
                  defaultValue={7}
                />
              </Field>
              <label className="flex items-end gap-2 pb-2 text-sm">
                <input name="mealPrepFriendly" type="checkbox" className="h-4 w-4" />
                Meal-prep friendly
              </label>
            </div>
            <fieldset className="space-y-1">
              <legend className="text-sm font-medium">Apply preferences</legend>
              <p className="mb-1 text-xs text-muted-foreground">
                Independent — tick neither, one, or both. Allergens are always honoured.
              </p>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="respectExclusions" defaultChecked className="h-4 w-4" />
                Honour my avoid list
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="respectFavorites" defaultChecked className="h-4 w-4" />
                Prefer my favourite ingredients
              </label>
            </fieldset>
            <Button type="submit" disabled={generate.isPending}>
              {generate.isPending ? 'Generating…' : 'Generate plan'}
            </Button>
          </form>
        </CardContent>
      </Card>

      {error && <p className="max-w-2xl text-sm text-destructive">{error}</p>}

      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 className="text-lg font-semibold tracking-tight">
            {active ? `${active.name}'s plans` : 'Plans'}
          </h2>
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex gap-1">
              {(['', 'active', 'upcoming', 'past'] as const).map((s) => (
                <Button
                  key={s || 'all'}
                  size="sm"
                  variant={status === s ? 'primary' : 'outline'}
                  onClick={() => setStatus(s)}
                >
                  {s ? s.charAt(0).toUpperCase() + s.slice(1) : 'All'}
                </Button>
              ))}
            </div>
            <Field label="From">
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="To">
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </Field>
            {(from || to || status) && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setStatus('');
                  setFrom('');
                  setTo('');
                }}
              >
                Clear
              </Button>
            )}
          </div>
        </div>
        {plans.isLoading ? (
          <Skeleton className="h-24 max-w-3xl" />
        ) : (plans.data ?? []).length === 0 ? (
          <p className="max-w-3xl text-sm text-muted-foreground">No plans yet — generate one above.</p>
        ) : (
          (plans.data ?? []).map((plan) => (
            <PlanCard
              key={plan.id}
              plan={plan}
              open={openPlan === plan.id}
              busy={busy}
              onToggle={() => setOpenPlan(openPlan === plan.id ? null : plan.id)}
              onRegenerate={() => {
                setError(null);
                regenerate.mutate(plan.id);
              }}
              onDelete={() => {
                setError(null);
                if (window.confirm('Delete this plan? This cannot be undone.')) {
                  remove.mutate(plan.id);
                }
              }}
              onRegenerateDay={(dayId) => {
                setError(null);
                regenerateDay.mutate({ planId: plan.id, dayId });
              }}
              onSwapMeal={(plannedMealId) => {
                setError(null);
                swapMeal.mutate({ planId: plan.id, plannedMealId, strategy: 'random' });
              }}
              onSwapByFavorites={(plannedMealId) => {
                setError(null);
                swapMeal.mutate({
                  planId: plan.id,
                  plannedMealId,
                  strategy: 'favorite_ingredients',
                });
              }}
              onSwapToFavorite={(plannedMealId, favoriteRecipeId) => {
                setError(null);
                swapMeal.mutate({
                  planId: plan.id,
                  plannedMealId,
                  strategy: 'favorite',
                  favoriteRecipeId,
                });
              }}
              favorites={favorites.data ?? []}
            />
          ))
        )}
      </section>
    </div>
  );
}

interface FavoriteOption {
  recipe: { id: string; title: string; mealTypes: string[] };
}

function PlanCard({
  plan,
  open,
  busy,
  favorites,
  onToggle,
  onRegenerate,
  onDelete,
  onRegenerateDay,
  onSwapMeal,
  onSwapByFavorites,
  onSwapToFavorite,
}: {
  plan: MealPlan;
  open: boolean;
  busy: boolean;
  favorites: FavoriteOption[];
  onToggle: () => void;
  onRegenerate: () => void;
  onDelete: () => void;
  onRegenerateDay: (dayId: string) => void;
  onSwapMeal: (plannedMealId: string) => void;
  onSwapByFavorites: (plannedMealId: string) => void;
  onSwapToFavorite: (plannedMealId: string, recipeId: string) => void;
}) {
  // Which meal's "swap to favorite" picker is open, if any.
  const [openFav, setOpenFav] = useState<string | null>(null);
  // Which meal's ingredient-substitution modal is open, if any.
  const [openSub, setOpenSub] = useState<MealPlan['days'][number]['meals'][number] | null>(null);
  return (
    <Card className="max-w-3xl">
      <div className="flex items-center justify-between gap-4 p-4">
        <button type="button" onClick={onToggle} className="flex-1 text-left">
          <p className="font-medium">
            {plan.durationDays}-day plan · {plan.dietType.replace('_', ' ')}
          </p>
          <p className="text-sm text-muted-foreground">
            From {plan.startDate} · {plan.averageDailyNutrition.calories} kcal/day avg ·{' '}
            {Math.round(plan.ingredientReuseScore * 100)}% ingredient reuse
          </p>
        </button>
        <div className="flex shrink-0 gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onRegenerate} disabled={busy}>
            Recalculate
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-destructive"
            onClick={onDelete}
            disabled={busy}
          >
            Delete
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onToggle}>
            {open ? '▲' : '▼'}
          </Button>
        </div>
      </div>
      {open && (
        <CardContent className="space-y-4 border-t border-border pt-4">
          {plan.days.map((day) => (
            <div key={day.id}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{day.date}</span>
                <div className="flex items-center gap-3">
                  <span
                    className={
                      Math.abs(day.calorieDelta) <= 50
                        ? 'text-sm text-muted-foreground'
                        : 'text-sm text-destructive'
                    }
                  >
                    {day.dayNutrition.calories} / {day.calorieTarget} kcal
                    {day.calorieDelta >= 0 ? ' +' : ' '}
                    {day.calorieDelta}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => onRegenerateDay(day.id)}
                    disabled={busy}
                  >
                    Change day
                  </Button>
                </div>
              </div>
              <ul className="mt-1 space-y-1 text-sm">
                {day.meals.map((m) => {
                  const slotFavorites = favorites.filter((f) =>
                    f.recipe.mealTypes.includes(m.mealType),
                  );
                  const favOpen = openFav === m.id;
                  return (
                    <li key={m.id} className="space-y-1">
                      <div className="flex items-center justify-between gap-3">
                        <span>
                          <span className="capitalize text-muted-foreground">
                            {m.mealType.replace('_', ' ')}
                          </span>{' '}
                          ·{' '}
                          <Link
                            href={`/recipes/${m.recipe.id}`}
                            className="font-medium text-primary hover:underline"
                          >
                            {m.recipe.title}
                          </Link>
                        </span>
                        <span className="flex items-center gap-2">
                          <span className="tabular-nums text-muted-foreground">
                            {m.nutrition.calories} kcal
                          </span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => onSwapMeal(m.id)}
                            disabled={busy}
                          >
                            Swap
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            title="Swap to a recipe that uses my favourite ingredients"
                            onClick={() => onSwapByFavorites(m.id)}
                            disabled={busy}
                          >
                            Swap ★ ingr.
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            title="Swap to one of my favourited recipes"
                            onClick={() => setOpenFav(favOpen ? null : m.id)}
                            disabled={busy}
                          >
                            ★ {favOpen ? '▲' : '▾'}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            title="Substitute one ingredient inside this recipe"
                            onClick={() => setOpenSub(m)}
                            disabled={busy}
                          >
                            ⇄
                          </Button>
                        </span>
                      </div>
                      {/* Concrete amounts for this meal — the recipe's ingredients
                          scaled by the planned servings, so the user reads the
                          finished list instead of doing math on a multiplier. */}
                      <p className="ml-4 text-xs text-muted-foreground">
                        {m.recipe.ingredients
                          .map((i) => {
                            const scale = m.servings / Math.max(m.recipe.servings, 1);
                            return `${formatIngredientAmount(i, scale)} ${i.name.toLowerCase()}`;
                          })
                          .join(' · ')}
                      </p>
                      {favOpen && (
                        <div className="ml-4 rounded-md border border-border bg-muted/40 p-2">
                          {slotFavorites.length === 0 ? (
                            <p className="text-xs text-muted-foreground">
                              No favorited recipes for {m.mealType.replace('_', ' ')} yet —
                              open a recipe to favorite it.
                            </p>
                          ) : (
                            <ul className="space-y-1">
                              {slotFavorites.map((f) => (
                                <li key={f.recipe.id}>
                                  <button
                                    type="button"
                                    className="w-full rounded px-2 py-1 text-left text-sm hover:bg-muted disabled:opacity-50"
                                    disabled={busy}
                                    onClick={() => {
                                      setOpenFav(null);
                                      onSwapToFavorite(m.id, f.recipe.id);
                                    }}
                                  >
                                    {f.recipe.title}
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </CardContent>
      )}
      {openSub && (
        <IngredientSubstituteModal
          meal={openSub}
          planId={plan.id}
          onClose={() => setOpenSub(null)}
          onApplied={() => {
            /* Invalidation happens via the parent's react-query cache when the
               plan refetches; the modal closes itself on success. */
          }}
        />
      )}
    </Card>
  );
}

export default function MealPlansPage() {
  return (
    <Suspense fallback={<Skeleton className="h-40 max-w-2xl" />}>
      <MealPlansContent />
    </Suspense>
  );
}
