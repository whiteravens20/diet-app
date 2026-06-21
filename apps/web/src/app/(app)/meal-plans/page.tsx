'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Suspense, useEffect, useRef, useState } from 'react';
import { CalendarRange, Sparkles, UserRound } from 'lucide-react';
import type {
  AddCustomMealRequest,
  AiSwapMealResponse,
  GeneratePlanRequest,
  MealPlan,
  Profile,
  RebalanceResult,
  SessionUser,
} from '@diet-app/shared';
import { api, ApiClientError } from '@/lib/api';
import Link from 'next/link';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ApplyFavoriteSetButton } from '@/components/apply-favorite-set-button';
import { DisclaimerNotice } from '@/components/disclaimer-notice';
import { EmptyState } from '@/components/empty-state';
import { IngredientSubstituteModal } from '@/components/ingredient-substitute-modal';
import { RecipeModal } from '@/components/recipe-modal';
import { CustomMealModal } from './custom-meal-modal';
import {
  AdvancedOptions,
  buildAdvancedRequest,
  planDates,
  type AdvancedValue,
} from './advanced-options';

const today = () => new Date().toISOString().slice(0, 10);

function MealPlansContent() {
  const t = useTranslations('mealPlans');
  const tCommon = useTranslations('common');
  const tDiet = useTranslations('enums.dietType');
  const tMeal = useTranslations('enums.mealType');
  const tFallback = useTranslations('aiFallback');
  const tErrors = useTranslations('errors');
  const qc = useQueryClient();
  const params = useSearchParams();
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: () => api.get<Profile[]>('/profiles') });
  const list = profiles.data ?? [];

  // Active profile: explicit pick → ?profile= deep link → first profile.
  const [picked, setPicked] = useState<string | null>(null);
  const activeId = picked ?? params.get('profile') ?? list[0]?.id ?? null;
  const active = list.find((p) => p.id === activeId) ?? null;

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [openPlan, setOpenPlan] = useState<string | null>(null);
  // F15 page-level toggle: applies to every swap / AI-swap on every plan card.
  // Plan generation has its own checkbox inside the new-plan form.
  const [swapWithPantry, setSwapWithPantry] = useState(true);

  // F17 advanced options. startDate/durationDays are controlled so the per-day
  // override list can react to the plan window; the advanced disclosure is
  // collapsed by default and untouched days fall back to the plan defaults.
  const [startDate, setStartDate] = useState(today());
  const [durationDays, setDurationDays] = useState(7);
  const [advanced, setAdvanced] = useState<AdvancedValue>({ days: {} });

  // Drives whether the ✨ button renders. `aiMode === 'none'` users hid AI on
  // purpose — they shouldn't see AI surfaces at all (matches AiChip semantics).
  const session = useQuery({
    queryKey: ['session'],
    queryFn: () => api.get<SessionUser>('/users/me'),
  });
  const aiEnabled = session.data?.aiMode && session.data.aiMode !== 'none';
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
      api.get<{ recipe: { id: string; title: string; mealTypes: string[]; dietTags: string[] } }[]>(
        `/favorites?profileId=${activeId}`,
      ),
    enabled: Boolean(activeId),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['meal-plans', activeId] });
  // Prefer the locale-aware `errors.<CODE>` catalogue over the backend's
  // English `message` field — the contract is "backend codes, client
  // translates" (F14). Falls back to the raw message if the code isn't in
  // the catalogue, then to the caller's fallback string for non-Api errors.
  const fail = (fallback: string) => (e: unknown) => {
    if (e instanceof ApiClientError) {
      setError(tErrors.has(e.code) ? tErrors(e.code) : e.message);
      return;
    }
    setError(fallback);
  };

  const generate = useMutation({
    mutationFn: (body: GeneratePlanRequest) => api.post<MealPlan>('/meal-plans/generate', body),
    onSuccess: (plan) => {
      invalidate();
      setOpenPlan(plan.id);
    },
    onError: fail(t('errGenerate')),
  });

  const regenerate = useMutation({
    mutationFn: (planId: string) => api.post<MealPlan>(`/meal-plans/${planId}/regenerate`),
    onSuccess: invalidate,
    onError: fail(t('errRecalculate')),
  });

  const regenerateDay = useMutation({
    mutationFn: (v: { planId: string; dayId: string }) =>
      api.post<MealPlan>(`/meal-plans/${v.planId}/days/${v.dayId}/regenerate`),
    onSuccess: invalidate,
    onError: fail(t('errChangeDay')),
  });

  // F22 rebalance toast: surfaced after any edit that changed a day's totals.
  const [rebalanceToast, setRebalanceToast] = useState<{
    planId: string;
    rebalance: NonNullable<RebalanceResult['rebalance']>;
  } | null>(null);
  const showRebalance = (planId: string, res: RebalanceResult) => {
    invalidate();
    if (res.rebalance && res.rebalance.changes.length > 0) {
      setRebalanceToast({ planId, rebalance: res.rebalance });
    }
  };

  const swapMeal = useMutation({
    mutationFn: (v: {
      planId: string;
      plannedMealId: string;
      strategy: 'random' | 'favorite' | 'favorite_ingredients';
      favoriteRecipeId?: string;
      allowOffDiet?: boolean;
    }) =>
      api.post<RebalanceResult>('/meal-plans/swap-meal', {
        planId: v.planId,
        plannedMealId: v.plannedMealId,
        strategy: v.strategy,
        respectInventory: swapWithPantry,
        allowOffDiet: v.allowOffDiet ?? false,
        ...(v.favoriteRecipeId ? { favoriteRecipeId: v.favoriteRecipeId } : {}),
      }),
    onSuccess: (res, v) => showRebalance(v.planId, res),
    onError: fail(t('errSwap')),
  });

  const addCustomMeal = useMutation({
    mutationFn: (v: { planId: string; date: string; body: AddCustomMealRequest }) =>
      api.post<RebalanceResult>(
        `/meal-plans/${v.planId}/days/${v.date}/custom-meal`,
        v.body,
      ),
    onSuccess: (res, v) => showRebalance(v.planId, res),
    onError: fail(t('errCustomMeal')),
  });

  const toggleEaten = useMutation({
    mutationFn: (v: { planId: string; mealId: string }) =>
      api.patch<RebalanceResult>(`/meal-plans/${v.planId}/meals/${v.mealId}/eaten`, {}),
    onSuccess: (res, v) => showRebalance(v.planId, res),
    onError: fail(t('errEaten')),
  });

  const rebalance = useMutation({
    mutationFn: (v: {
      planId: string;
      scope: 'day' | 'week';
      date?: string;
      restore?: { mealId: string; scale: number }[];
    }) =>
      api.post<RebalanceResult>(`/meal-plans/${v.planId}/rebalance`, {
        scope: v.scope,
        ...(v.date ? { date: v.date } : {}),
        ...(v.restore ? { restore: v.restore } : {}),
      }),
    onSuccess: (res, v) => {
      // Undo / week re-runs replace the toast (undo simply clears it).
      if (v.restore) {
        invalidate();
        setRebalanceToast(null);
      } else {
        showRebalance(v.planId, res);
      }
    },
    onError: fail(t('errRebalance')),
  });

  // AI-ranked swap. The server always applies a swap (engine fallback if AI is
  // unavailable), so we always invalidate; the optional `fallbackReason` drives
  // a localised info banner so the user knows when AI didn't actually run.
  const aiSwapMeal = useMutation({
    mutationFn: (v: { planId: string; plannedMealId: string; hint?: string }) =>
      api.post<AiSwapMealResponse>('/meal-plans/ai-swap-meal', { ...v, respectInventory: swapWithPantry }),
    onSuccess: (res) => {
      invalidate();
      // Bust the chip's quota query — successful admin calls decrement remaining.
      qc.invalidateQueries({ queryKey: ['ai-quota'] });
      const reason = res.aiMeta.fallbackReason;
      setNotice(reason ? tFallback(reason) : null);
    },
    onError: fail(t('errAiSwap')),
  });

  const remove = useMutation({
    mutationFn: (planId: string) => api.delete<void>(`/meal-plans/${planId}`),
    onSuccess: invalidate,
    onError: fail(t('errDelete')),
  });

  const busy =
    regenerate.isPending ||
    regenerateDay.isPending ||
    swapMeal.isPending ||
    aiSwapMeal.isPending ||
    addCustomMeal.isPending ||
    toggleEaten.isPending ||
    rebalance.isPending ||
    remove.isPending;

  function onGenerate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!activeId) return;
    const f = new FormData(event.currentTarget);
    const dates = planDates(startDate, durationDays);
    generate.mutate({
      profileId: activeId,
      startDate,
      durationDays,
      mealPrepFriendly: f.get('mealPrepFriendly') === 'on',
      respectExclusions: f.get('respectExclusions') === 'on',
      respectFavorites: f.get('respectFavorites') === 'on',
      respectInventory: f.get('respectInventory') === 'on',
      ...buildAdvancedRequest(advanced, dates),
    });
  }

  if (profiles.isLoading) return <Skeleton className="h-40 max-w-2xl" />;

  if (list.length === 0) {
    return (
      <div className="mt-16">
        <EmptyState
          icon={UserRound}
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

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subhead')}</p>
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
          <CardTitle>{active ? t('generateFor', { name: active.name }) : t('generate')}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onGenerate} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label={t('startDate')}>
                <Input
                  name="startDate"
                  type="date"
                  required
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </Field>
              <Field label={t('durationDays')}>
                <Input
                  name="durationDays"
                  type="number"
                  required
                  min={1}
                  max={28}
                  value={durationDays}
                  onChange={(e) => setDurationDays(Number(e.target.value))}
                />
              </Field>
              <label className="flex items-end gap-2 pb-2 text-sm">
                <input name="mealPrepFriendly" type="checkbox" className="h-4 w-4" />
                {t('mealPrepFriendly')}
              </label>
            </div>
            <fieldset className="space-y-1">
              <legend className="text-sm font-medium">{t('applyPrefs')}</legend>
              <p className="mb-1 text-xs text-muted-foreground">{t('applyPrefsHint')}</p>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="respectExclusions" defaultChecked className="h-4 w-4" />
                {t('honourAvoid')}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="respectFavorites" defaultChecked className="h-4 w-4" />
                {t('preferFavorites')}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="respectInventory" defaultChecked className="h-4 w-4" />
                {t('preferInventory')}
              </label>
            </fieldset>
            <AdvancedOptions
              dates={planDates(startDate, durationDays)}
              defaultMealCount={active?.mealCount ?? 3}
              favorites={(favorites.data ?? []).map((f) => f.recipe)}
              value={advanced}
              onChange={setAdvanced}
            />
            <Button type="submit" disabled={generate.isPending}>
              {generate.isPending ? t('generating') : t('generateButton')}
            </Button>
          </form>
        </CardContent>
      </Card>

      {error && <p className="max-w-2xl text-sm text-destructive">{error}</p>}
      {notice && (
        <p
          className="max-w-2xl rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300"
          role="status"
        >
          {notice}
        </p>
      )}

      <DisclaimerNotice bodyKey={aiEnabled ? 'aiPlans' : 'enginePlans'} />

      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 className="text-lg font-semibold tracking-tight">
            {active ? t('plansFor', { name: active.name }) : t('plans')}
          </h2>
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex gap-1">
              {(['', 'active', 'upcoming', 'past'] as const).map((s) => {
                const labelKey =
                  s === '' ? 'statusAll' : s === 'active' ? 'statusActive' : s === 'upcoming' ? 'statusUpcoming' : 'statusPast';
                return (
                  <Button
                    key={s || 'all'}
                    size="sm"
                    variant={status === s ? 'primary' : 'outline'}
                    onClick={() => setStatus(s)}
                  >
                    {t(labelKey)}
                  </Button>
                );
              })}
            </div>
            <Field label={t('from')}>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label={t('to')}>
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
                {tCommon('clear')}
              </Button>
            )}
          </div>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground" title={t('swapWithPantryTooltip')}>
          <input
            type="checkbox"
            className="h-3.5 w-3.5"
            checked={swapWithPantry}
            onChange={(e) => setSwapWithPantry(e.target.checked)}
          />
          {t('swapWithPantry')}
        </label>
        {plans.isLoading ? (
          <Skeleton className="h-24 max-w-3xl" />
        ) : (plans.data ?? []).length === 0 ? (
          <EmptyState
            icon={CalendarRange}
            title={t('noPlansTitle')}
            description={t('noPlans')}
          />
        ) : (
          (plans.data ?? []).map((plan) => (
            <PlanCard
              key={plan.id}
              plan={plan}
              open={openPlan === plan.id}
              busy={busy}
              dietLabel={tDiet(plan.dietType)}
              onToggle={() => setOpenPlan(openPlan === plan.id ? null : plan.id)}
              onRegenerate={() => {
                setError(null);
                regenerate.mutate(plan.id);
              }}
              onDelete={() => {
                setError(null);
                if (window.confirm(t('deleteConfirm'))) {
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
              onSwapToFavorite={(plannedMealId, favoriteRecipeId, allowOffDiet) => {
                setError(null);
                swapMeal.mutate({
                  planId: plan.id,
                  plannedMealId,
                  strategy: 'favorite',
                  favoriteRecipeId,
                  allowOffDiet,
                });
              }}
              onAiSwapMeal={
                aiEnabled
                  ? (plannedMealId) => {
                      setError(null);
                      setNotice(null);
                      aiSwapMeal.mutate({ planId: plan.id, plannedMealId });
                    }
                  : undefined
              }
              onToggleEaten={(mealId) => {
                setError(null);
                toggleEaten.mutate({ planId: plan.id, mealId });
              }}
              onAddCustomMeal={(date, body) => {
                setError(null);
                addCustomMeal.mutate({ planId: plan.id, date, body });
              }}
              favorites={favorites.data ?? []}
              tMeal={tMeal}
            />
          ))
        )}
      </section>

      {rebalanceToast && (
        <RebalanceToast
          rebalance={rebalanceToast.rebalance}
          busy={rebalance.isPending}
          onUndo={() =>
            rebalance.mutate({
              planId: rebalanceToast.planId,
              scope: 'day',
              restore: rebalanceToast.rebalance.changes.map((c) => ({
                mealId: c.mealId,
                scale: c.before,
              })),
            })
          }
          onRebalanceWeek={() =>
            rebalance.mutate({ planId: rebalanceToast.planId, scope: 'week' })
          }
          onDismiss={() => setRebalanceToast(null)}
        />
      )}
    </div>
  );
}

interface FavoriteOption {
  recipe: { id: string; title: string; mealTypes: string[]; dietTags: string[] };
}

type PlannedMealView = MealPlan['days'][number]['meals'][number];
/** A catalogue meal, narrowed so its recipe is guaranteed present. */
type CatalogueMeal = PlannedMealView & { recipe: NonNullable<PlannedMealView['recipe']> };

function PlanCard({
  plan,
  open,
  busy,
  dietLabel,
  favorites,
  tMeal,
  onToggle,
  onRegenerate,
  onDelete,
  onRegenerateDay,
  onSwapMeal,
  onSwapByFavorites,
  onSwapToFavorite,
  onAiSwapMeal,
  onToggleEaten,
  onAddCustomMeal,
}: {
  plan: MealPlan;
  open: boolean;
  busy: boolean;
  dietLabel: string;
  favorites: FavoriteOption[];
  tMeal: ReturnType<typeof useTranslations<'enums.mealType'>>;
  onToggle: () => void;
  onRegenerate: () => void;
  onDelete: () => void;
  onRegenerateDay: (dayId: string) => void;
  onSwapMeal: (plannedMealId: string) => void;
  onSwapByFavorites: (plannedMealId: string) => void;
  onSwapToFavorite: (plannedMealId: string, recipeId: string, allowOffDiet: boolean) => void;
  /** Undefined when the user has `aiMode='none'` — the button is hidden. */
  onAiSwapMeal?: (plannedMealId: string) => void;
  onToggleEaten: (mealId: string) => void;
  onAddCustomMeal: (date: string, body: AddCustomMealRequest) => void;
}) {
  const t = useTranslations('mealPlans');
  const tCommon = useTranslations('common');
  // Which meal's "swap to favorite" picker is open, if any.
  const [openFav, setOpenFav] = useState<string | null>(null);
  // F22(a): show every favourite (drop the diet filter) in the open picker.
  const [showAllFav, setShowAllFav] = useState(false);
  // F22(b): which day's "add custom meal" modal is open, if any.
  const [customDay, setCustomDay] = useState<string | null>(null);
  // Which meal's ingredient-substitution modal is open, if any. Only catalogue
  // meals (recipe present) can be substituted.
  const [openSub, setOpenSub] = useState<CatalogueMeal | null>(null);
  // Which recipe is open in the Framer Motion modal, if any, plus the scale
  // factor so the modal shows ingredient amounts for the planned meal rather
  // than the recipe's default servings.
  const [openRecipe, setOpenRecipe] = useState<{ id: string; scale: number } | null>(null);
  return (
    <Card className="relative w-full max-w-screen-2xl">
      <div className="flex items-center justify-between gap-4 p-4">
        <button type="button" onClick={onToggle} className="flex-1 text-left">
          <p className="font-medium">
            {t('planSummary', { days: plan.durationDays, dietType: dietLabel })}
          </p>
          <p className="text-sm text-muted-foreground">
            {t('planMeta', {
              date: plan.startDate,
              kcal: plan.averageDailyNutrition.calories,
              pct: Math.round(plan.ingredientReuseScore * 100),
            })}
          </p>
        </button>
        <div className="flex shrink-0 gap-2">
          <ApplyFavoriteSetButton plan={plan} profileId={plan.profileId} disabled={busy} />
          <Button type="button" variant="outline" size="sm" onClick={onRegenerate} disabled={busy}>
            {t('recalculate')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-destructive"
            onClick={onDelete}
            disabled={busy}
          >
            {tCommon('delete')}
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
                    {t('calorieLine', {
                      kcal: day.dayNutrition.calories,
                      target: day.calorieTarget,
                      delta: day.calorieDelta >= 0 ? `+${day.calorieDelta}` : String(day.calorieDelta),
                    })}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => onRegenerateDay(day.id)}
                    disabled={busy}
                  >
                    {t('changeDay')}
                  </Button>
                </div>
              </div>
              <ul className="mt-1 space-y-1 text-sm">
                {day.meals.map((m) => {
                  const eaten = m.eatenAt !== null;
                  const isCustom = m.source === 'USER_CUSTOM' || m.recipe === null;
                  const title = isCustom ? m.customName ?? t('customMeal') : m.recipe!.title;
                  const favOpen = openFav === m.id;
                  const mealLabel = tMeal.has(m.mealType) ? tMeal(m.mealType) : m.mealType.replace('_', ' ');
                  // F22(a): the picker shows diet-matching favourites by default;
                  // "show all my favourites" drops the diet filter (slot stays).
                  const slotFavorites = favorites.filter(
                    (f) =>
                      f.recipe.mealTypes.includes(m.mealType) &&
                      (showAllFav ||
                        plan.dietType === 'custom' ||
                        f.recipe.dietTags.includes(plan.dietType)),
                  );
                  return (
                    <li key={m.id} className="space-y-1">
                      <div className="flex items-center justify-between gap-6">
                        <span className="min-w-0 flex-1">
                          <input
                            type="checkbox"
                            className="mr-2 h-4 w-4 align-middle"
                            checked={eaten}
                            disabled={busy}
                            aria-label={t('markEaten')}
                            title={t('markEaten')}
                            onChange={() => onToggleEaten(m.id)}
                          />
                          <span className="text-muted-foreground">{mealLabel}</span> ·{' '}
                          {isCustom ? (
                            <span className="font-medium">{title}</span>
                          ) : (
                            <button
                              type="button"
                              onClick={() =>
                                setOpenRecipe({
                                  id: m.recipe!.id,
                                  scale: m.servings / Math.max(m.recipe!.servings, 1),
                                })
                              }
                              className="font-medium text-primary hover:underline"
                            >
                              {title}
                            </button>
                          )}
                          {isCustom && (
                            <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                              {t('customChip')}
                            </span>
                          )}
                          {m.dietOverride && (
                            <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-400">
                              {t('dietOverrideChip')}
                            </span>
                          )}
                          {m.quantityScale !== 1 && (
                            <span className="ml-2 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">
                              {t('autoBalancedChip', { scale: m.quantityScale.toFixed(2) })}
                            </span>
                          )}
                        </span>
                        <span className="flex shrink-0 items-center gap-4">
                          {eaten ? (
                            <span className="text-xs font-medium text-muted-foreground">
                              {t('eatenBadge')}
                            </span>
                          ) : isCustom ? null : (
                            <>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => onSwapMeal(m.id)}
                                disabled={busy}
                              >
                                {t('swap')}
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                title={t('tooltipSwapToFav')}
                                onClick={() => {
                                  setShowAllFav(false);
                                  setOpenFav(favOpen ? null : m.id);
                                }}
                                disabled={busy}
                              >
                                {t('swapToFav')} ★ {favOpen ? '▲' : '▾'}
                              </Button>
                              {onAiSwapMeal && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  title={t('tooltipAiSwap')}
                                  onClick={() => onAiSwapMeal(m.id)}
                                  disabled={busy}
                                  className="text-primary"
                                >
                                  <Sparkles size={14} aria-hidden />
                                  <span className="ml-1">{t('aiSwap')}</span>
                                </Button>
                              )}
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                title={t('tooltipSwapByFav')}
                                onClick={() => onSwapByFavorites(m.id)}
                                disabled={busy}
                              >
                                {t('swapFavIngr')}
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                title={t('tooltipSubstitute')}
                                onClick={() => {
                                  if (m.recipe) setOpenSub({ ...m, recipe: m.recipe });
                                }}
                                disabled={busy}
                              >
                                {t('substituteIngr')} ⇄
                              </Button>
                            </>
                          )}
                        </span>
                      </div>
                      {/* Per-meal macros sit below the title as plain text — the
                          modal opened from the recipe title carries the full
                          ingredient list scaled for this meal. */}
                      <MacrosLine nutrition={m.nutrition} />
                      {isCustom && (
                        <p className="ml-6 text-xs italic text-muted-foreground">
                          {t('customMacrosNote')}
                        </p>
                      )}
                      {favOpen && !isCustom && (
                        <div className="ml-4 rounded-md border border-border bg-muted/40 p-2">
                          <label className="mb-2 flex items-center gap-1 text-xs">
                            <input
                              type="checkbox"
                              className="h-3.5 w-3.5"
                              checked={showAllFav}
                              onChange={(e) => setShowAllFav(e.target.checked)}
                            />
                            {t('showAllFavorites')}
                          </label>
                          {slotFavorites.length === 0 ? (
                            <p className="text-xs text-muted-foreground">
                              {t('noFavoritesForSlot', { mealType: mealLabel })}
                            </p>
                          ) : (
                            <ul className="space-y-1">
                              {slotFavorites.map((f) => {
                                const off =
                                  plan.dietType !== 'custom' &&
                                  !f.recipe.dietTags.includes(plan.dietType);
                                return (
                                  <li key={f.recipe.id}>
                                    <button
                                      type="button"
                                      className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted disabled:opacity-50"
                                      disabled={busy}
                                      onClick={() => {
                                        setOpenFav(null);
                                        onSwapToFavorite(m.id, f.recipe.id, off);
                                      }}
                                    >
                                      <span>{f.recipe.title}</span>
                                      {off && (
                                        <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-400">
                                          {t('offDietTag')}
                                        </span>
                                      )}
                                    </button>
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-1"
                onClick={() => setCustomDay(day.date)}
                disabled={busy}
              >
                {t('addCustomMeal')}
              </Button>
            </div>
          ))}
        </CardContent>
      )}
      {customDay && (
        <CustomMealModal
          date={customDay}
          onClose={() => setCustomDay(null)}
          onSubmit={(body) => {
            onAddCustomMeal(customDay, body);
            setCustomDay(null);
          }}
        />
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
      <RecipeModal
        recipeId={openRecipe?.id ?? null}
        scale={openRecipe?.scale ?? 1}
        onClose={() => setOpenRecipe(null)}
      />
    </Card>
  );
}

/**
 * F22 rebalance toast: a bottom-right card summarising the auto-rebalance, with
 * "undo last rebalance" (restores the pre-edit scales), "rebalance the rest of
 * the week", and dismiss. Auto-dismisses after 10 s.
 */
function RebalanceToast({
  rebalance,
  busy,
  onUndo,
  onRebalanceWeek,
  onDismiss,
}: {
  rebalance: NonNullable<RebalanceResult['rebalance']>;
  busy: boolean;
  onUndo: () => void;
  onRebalanceWeek: () => void;
  onDismiss: () => void;
}) {
  const t = useTranslations('mealPlans');
  // Keep the auto-dismiss timer stable across parent re-renders: the latest
  // onDismiss lives in a ref (updated in an effect, never during render) so the
  // 10 s timer is armed exactly once.
  const dismiss = useRef(onDismiss);
  useEffect(() => {
    dismiss.current = onDismiss;
  }, [onDismiss]);
  useEffect(() => {
    const id = setTimeout(() => dismiss.current(), 10_000);
    return () => clearTimeout(id);
  }, []);

  return (
    <div className="fixed bottom-4 right-4 z-50 max-w-sm rounded-lg border border-border bg-background p-4 shadow-lg">
      <p className="text-sm font-medium">{t('rebalanceTitle')}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        {t('rebalanceSummary', {
          before: Math.round(rebalance.macrosBefore.calories),
          after: Math.round(rebalance.macrosAfter.calories),
          count: rebalance.changes.length,
        })}
      </p>
      {rebalance.feasibility === 'best-effort' && (
        <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">{t('rebalanceBestEffort')}</p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onUndo} disabled={busy}>
          {t('rebalanceUndo')}
        </Button>
        {rebalance.scope === 'day' && (
          <Button type="button" variant="outline" size="sm" onClick={onRebalanceWeek} disabled={busy}>
            {t('rebalanceWeek')}
          </Button>
        )}
        <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
          {t('rebalanceDismiss')}
        </Button>
      </div>
    </div>
  );
}

/** Per-meal macros as plain inline text, sitting below the recipe title. Full
 *  macro nouns (Protein / Białko) so it reads as a sentence, not a sticker
 *  strip. Mirrors the layout the ingredient list used to occupy. */
function MacrosLine({
  nutrition,
}: {
  nutrition: { calories: number; protein: number; fat: number; carbs: number };
}) {
  const t = useTranslations('macrosLine');
  return (
    <p className="ml-4 text-xs text-muted-foreground">
      {t('protein')} {Math.round(nutrition.protein)} g · {t('fat')}{' '}
      {Math.round(nutrition.fat)} g · {t('carbs')} {Math.round(nutrition.carbs)} g ·{' '}
      {Math.round(nutrition.calories)} {t('kcal')}
    </p>
  );
}

export default function MealPlansPage() {
  return (
    <Suspense fallback={<Skeleton className="h-40 max-w-2xl" />}>
      <MealPlansContent />
    </Suspense>
  );
}
