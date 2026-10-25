// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import dynamic from 'next/dynamic';
import { Suspense, useEffect, useId, useRef, useState } from 'react';
import { CalendarRange, UserRound } from 'lucide-react';
import {
  CalendarDay,
  MAX_CALORIE_TARGET,
  MIN_CALORIE_TARGET,
  PLAN_RELAXATIONS,
  RelaxationNeeded,
  UnfilledMeal,
  type AddCustomMealRequest,
  type CalorieCalculation,
  type DietType,
  type FavoriteSet,
  type GeneratePlanRequest,
  type MealPlan,
  type MealPlanPage,
  type PlanRelaxation,
  type Profile,
  type RebalanceResult,
  type SessionUser,
} from '@diet-app/shared';
import { MEAL_SLOTS_BY_COUNT } from '@diet-app/shared/constants';
import { api } from '@/lib/api';
import { ApiClientError, localDate } from '@/lib/http';
import { useErrorText } from '@/lib/use-error-text';
import { planDates } from '@/lib/plan-dates';
import Link from 'next/link';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { AiOffNote } from '@/components/ai-off-note';
import { DisclaimerNotice } from '@/components/disclaimer-notice';
import { EmptyState } from '@/components/empty-state';
import { PageBanner } from '@/components/page-banner';
import { SupplyNote } from '@/components/supply-note';
import { NAMED_DIETS, supplyOf } from '@/lib/catalogue';
import { useConfig } from '@/lib/use-config';
import { IMAGERY } from '@/lib/imagery';
import { dayAnchor, PlanCard, type Offered, type SwapAsk, type SwapOffer } from './plan-card';
import { RebalanceToast } from './rebalance-toast';
import { rerollBody, type Reroll } from './reroll';
import { AdvancedOptions, buildAdvancedRequest, type AdvancedValue } from './advanced-options';
import { useFormat } from '@/lib/use-format';
import { LoadFailed } from '@/components/load-failed';

/** Fetched once the page is drawn: nobody waits for the calendar to read the page above it. */
const PlanCalendar = dynamic(() => import('./plan-calendar').then((calendar) => calendar.PlanCalendar), {
  ssr: false,
  loading: () => <Skeleton className="h-96" />,
});

/** How many of the meals that stand in the way of a plan are named one by one. */
const MEALS_NAMED = 6;

const selectClass = 'h-10 w-full rounded-md border border-input bg-background px-3 text-sm';

/** What a generate request sends: the fields with a default may be left out. */
type GenerateBody = Omit<GeneratePlanRequest, 'allowRelaxations'> & { allowRelaxations?: PlanRelaxation[] };

/** What the user can allow so that a refused re-roll goes through, by the code of the refusal. */
const ALLOWS = { LOCKED_RECIPE_INELIGIBLE: 'dropIneligibleLocks', NOTHING_TO_REGENERATE: 'includePast' } as const;

/** `more` added to `allowed`, in the order limits give way. */
const withMore = (allowed: readonly PlanRelaxation[], more: readonly PlanRelaxation[]): PlanRelaxation[] =>
  PLAN_RELAXATIONS.filter((kind) => allowed.includes(kind) || more.includes(kind));

function MealPlansContent() {
  const t = useTranslations('mealPlans');
  const tCommon = useTranslations('common');
  const tDiet = useTranslations('enums.dietType');
  const tMeal = useTranslations('enums.mealType');
  const tFallback = useTranslations('aiFallback');
  const tCatalogue = useTranslations('catalogue');
  const errorText = useErrorText();
  const fmt = useFormat();
  const qc = useQueryClient();
  const params = useSearchParams();
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: () => api.get<Profile[]>('/profiles') });
  const list = profiles.data ?? [];

  // Active profile: explicit pick → ?profile= deep link → first profile.
  const [picked, setPicked] = useState<string | null>(null);
  const activeId = picked ?? params.get('profile') ?? list[0]?.id ?? null;
  const active = list.find((p) => p.id === activeId) ?? null;

  // A link from elsewhere may name a plan and a day of it (`?plan=&day=`): the page then opens on the plan at that day, as its own calendar would lead there.
  const [linked] = useState(() => {
    const planId = params.get('plan');
    const date = params.get('day');
    return planId && date && /^[0-9a-f-]{36}$/i.test(planId) && CalendarDay.safeParse(date).success ? { planId, date } : null;
  });

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [openPlan, setOpenPlan] = useState<string | null>(linked?.planId ?? null);
  // Page-level toggle: applies to every swap / AI-swap on every plan card.
  // Plan generation has its own checkbox inside the new-plan form.
  const [swapWithPantry, setSwapWithPantry] = useState(true);

  // Advanced options. startDate/durationDays are controlled so the per-day
  // override list can react to the plan window; the advanced disclosure is
  // collapsed by default and untouched days fall back to the plan defaults.
  // The user's own day: late in the evening the day in UTC is already another.
  const [startDate, setStartDate] = useState(() => localDate());
  const [durationDays, setDurationDays] = useState(7);
  const [advanced, setAdvanced] = useState<AdvancedValue>({ days: {} });
  // What this plan is made for where it differs from the profile: empty means "as the profile has it".
  const [diet, setDiet] = useState<DietType | ''>('');
  const [mealCount, setMealCount] = useState<number | ''>('');
  const [calorieTarget, setCalorieTarget] = useState('');
  const config = useConfig().data;
  const depth = config?.catalogue.depth;

  // Whether the account has a model to ask. Without one, what asks a model
  // stays where it is, disabled, and one line over the plans says why.
  const session = useQuery({
    queryKey: ['session'],
    queryFn: () => api.get<SessionUser>('/users/me'),
  });
  const aiEnabled = session.data?.aiMode && session.data.aiMode !== 'none';
  const aiOffNote = useId();
  const [status, setStatus] = useState<'' | 'active' | 'past' | 'upcoming'>('');
  // The list is narrowed to the plans that hold the day a link named, so that the plan is on the page whatever page of the list it is on.
  const [from, setFrom] = useState(linked?.date ?? '');
  const [to, setTo] = useState(linked?.date ?? '');

  // Which page of the list is shown; a new profile or filter begins at the first.
  const [page, setPage] = useState(1);
  // The list holds each plan as a summary; the plan that is open is read whole.
  const plans = useQuery({
    queryKey: ['meal-plans', activeId, status, from, to, page],
    queryFn: () => {
      const qp = new URLSearchParams({ profileId: activeId!, page: String(page) });
      if (status) qp.set('status', status);
      if (from) qp.set('from', from);
      if (to) qp.set('to', to);
      return api.get<MealPlanPage>(`/meal-plans?${qp}`);
    },
    enabled: Boolean(activeId),
  });
  const opened = useQuery({
    queryKey: ['meal-plan', openPlan],
    queryFn: () => api.get<MealPlan>(`/meal-plans/${openPlan}`),
    enabled: Boolean(openPlan),
  });

  const favorites = useQuery({
    queryKey: ['favorites', activeId],
    queryFn: () =>
      api.get<{ sentiment: string; recipe: { id: string; title: string; mealTypes: string[]; dietTags: string[] } }[]>(
        `/favorites?profileId=${activeId}`,
      ),
    enabled: Boolean(activeId),
  });
  // What a profile marked to avoid is marked, and is nothing to put into a plan: the gate would refuse it.
  const liked = (favorites.data ?? []).filter((marked) => marked.sentiment !== 'avoid');

  // What the plan aims at when the form says nothing: the profile's own target.
  const calories = useQuery({
    queryKey: ['calories', activeId],
    queryFn: () => api.get<CalorieCalculation>(`/profiles/${activeId}/calories`),
    enabled: Boolean(activeId),
  });
  const favoriteSets = useQuery({
    queryKey: ['favorite-sets', activeId],
    queryFn: () => api.get<FavoriteSet[]>(`/favorite-sets?profileId=${activeId}`),
    enabled: Boolean(activeId),
  });
  // The diet and the number of meals the plan is made for: the form's, or the profile's.
  const planDiet = diet || active?.dietType || 'balanced';
  const planMeals = mealCount || active?.mealCount || 3;

  const invalidate = () => Promise.all([qc.invalidateQueries({ queryKey: ['meal-plans', activeId] }), qc.invalidateQueries({ queryKey: ['meal-plan'] })]);
  const fail = (fallback: string) => (e: unknown) => {
    // Another request changed the plan first, so the one on screen is stale.
    if (e instanceof ApiClientError && e.code === 'PLAN_CHANGED') void invalidate();
    setError((e instanceof ApiClientError ? unfilledMeal(e) : null) ?? errorText(e, fallback));
  };
  // A plan that could not be made names the meal it had no recipe for, and
  // tells a catalogue without one from a profile that rules out what there is.
  const unfilledMeal = (e: ApiClientError): string | null => {
    const gap = e.code === 'NO_ELIGIBLE_RECIPE' ? UnfilledMeal.safeParse(e.details) : null;
    if (!gap?.success) return null;
    const { slot, dietType, ruledOut } = gap.data;
    const named = { meal: tMeal(slot), diet: tDiet(dietType) };
    if (ruledOut > 0) return t('noRecipeLeft', { ...named, count: ruledOut });
    // Fewer meals a day help only with a meal that the shortest day does not have.
    return t('noRecipeInCatalogue', { ...named, advice: MEAL_SLOTS_BY_COUNT[2]!.includes(slot) ? 'diet' : 'fewer' });
  };

  // A plan that could only be filled outside its limits: what stands in the
  // way, and the request that is sent again once the user lets it give way.
  const [inTheWay, setInTheWay] = useState<
    { needed: RelaxationNeeded; allowed: PlanRelaxation[] } & ({ generate: GenerateBody } | { reroll: Reroll }) | null
  >(null);
  const relaxationNeeded = (e: unknown): RelaxationNeeded | null => {
    if (!(e instanceof ApiClientError) || e.code !== 'PLAN_NEEDS_RELAXATION') return null;
    const needed = RelaxationNeeded.safeParse(e.details);
    return needed.success ? needed.data : null;
  };
  const limitNames = (kinds: readonly PlanRelaxation[]) => kinds.map((kind) => t(`limit.${kind}`)).join(', ');

  const generate = useMutation({
    mutationFn: (body: GenerateBody) => api.post<MealPlan>('/meal-plans/generate', body),
    onSuccess: (plan) => {
      setInTheWay(null);
      invalidate();
      setOpenPlan(plan.id);
    },
    onError: (e: unknown, body: GenerateBody) => {
      const needed = relaxationNeeded(e);
      setInTheWay(needed ? { needed, allowed: body.allowRelaxations ?? [], generate: body } : null);
      if (!needed) fail(t('errGenerate'))(e);
    },
  });

  // A re-roll that was refused for something the user can allow: a locked
  // recipe that may no longer go into the plan can be dropped, days that have
  // passed can be filled again all the same. The same request is then sent
  // with that allowed.
  const [refused, setRefused] = useState<{ reroll: Reroll; allow: (typeof ALLOWS)[keyof typeof ALLOWS] } | null>(null);
  const reroll = (fallback: string) => ({
    mutationFn: (v: Reroll) =>
      api.post<MealPlan>(v.dayId ? `/meal-plans/${v.planId}/days/${v.dayId}/regenerate` : `/meal-plans/${v.planId}/regenerate`, rerollBody(v)),
    onSuccess: () => {
      setRefused(null);
      setInTheWay(null);
      invalidate();
    },
    onError: (e: unknown, v: Reroll) => {
      const allow = e instanceof ApiClientError && e.code in ALLOWS ? ALLOWS[e.code as keyof typeof ALLOWS] : null;
      setRefused(allow && !v[allow] ? { reroll: v, allow } : null);
      const needed = relaxationNeeded(e);
      const kept = plans.data?.items.find((plan) => plan.id === v.planId)?.options.allowRelaxations ?? [];
      setInTheWay(needed ? { needed, allowed: v.allowRelaxations ?? kept, reroll: v } : null);
      if (!needed) fail(fallback)(e);
    },
  });
  const regenerate = useMutation(reroll(t('errRecalculate')));
  const regenerateDay = useMutation(reroll(t('errChangeDay')));

  // Rebalance toast: surfaced after any edit that changed a day's totals.
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

  // A recipe that was offered in the place of a meal, with what the swap
  // would do: nothing is written until the user takes it.
  const [offer, setOffer] = useState<SwapOffer | null>(null);
  const offerSwap = useMutation({
    mutationFn: (v: SwapAsk & { seen: string[] }) =>
      v.strategy === 'ai'
        ? api.post<Offered>('/meal-plans/ai-swap-meal/preview', { planId: v.planId, plannedMealId: v.plannedMealId, respectInventory: swapWithPantry, skip: v.seen })
        : api.post<Offered>('/meal-plans/swap-meal/preview', {
            planId: v.planId,
            plannedMealId: v.plannedMealId,
            strategy: v.strategy,
            respectInventory: swapWithPantry,
            allowOffDiet: v.allowOffDiet ?? false,
            ...(v.favoriteRecipeId ? { favoriteRecipeId: v.favoriteRecipeId } : {}),
            skip: v.seen,
          }),
    onSuccess: (preview, { seen, ...asked }) => {
      setOffer({ asked, preview, seen: [...seen, preview.recipe.id] });
      if (preview.aiMeta) {
        // A model was asked: that counts against the allowance whoever picked in the end.
        qc.invalidateQueries({ queryKey: ['ai-quota'] });
        setNotice(preview.aiMeta.fallbackReason ? tFallback(preview.aiMeta.fallbackReason) : null);
      }
    },
    onError: (e: unknown, v) => {
      setOffer(null);
      fail(t(v.strategy === 'ai' ? 'errAiSwap' : 'errSwap'))(e);
    },
  });
  const takeOffer = useMutation({
    mutationFn: ({ asked, preview }: SwapOffer) =>
      api.post<RebalanceResult>('/meal-plans/swap-meal', {
        planId: asked.planId,
        plannedMealId: asked.plannedMealId,
        recipeId: preview.recipe.id,
        revision: preview.revision,
        // What a model picked is held to what the engine's own pick is.
        strategy: asked.strategy === 'ai' ? 'random' : asked.strategy,
        allowOffDiet: asked.allowOffDiet ?? false,
        // The note that came with a model's own pick: the meal then says who chose its recipe.
        ...(preview.pick ? { pick: preview.pick } : {}),
      }),
    onSuccess: (res, { asked }) => {
      setOffer(null);
      showRebalance(asked.planId, res);
    },
    onError: (e: unknown) => {
      // The offer was for the plan as it was: it does not outlive a refusal.
      setOffer(null);
      fail(t('errSwap'))(e);
    },
  });
  const askFor = (asked: SwapAsk, seen: string[] = []) => {
    setError(null);
    if (asked.strategy === 'ai') setNotice(null);
    offerSwap.mutate({ ...asked, seen });
  };

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
    mutationFn: (v: { planId: string; mealId: string; eaten: boolean }) =>
      api.patch<RebalanceResult>(`/meal-plans/${v.planId}/meals/${v.mealId}/eaten`, { eaten: v.eaten }),
    onSuccess: (res, v) => showRebalance(v.planId, res),
    onError: fail(t('errEaten')),
  });

  const removeMeal = useMutation({
    mutationFn: (v: { planId: string; mealId: string }) => api.delete<RebalanceResult>(`/meal-plans/${v.planId}/meals/${v.mealId}`),
    onSuccess: (res, v) => showRebalance(v.planId, res),
    onError: fail(t('errRemoveMeal')),
  });

  const rebalance = useMutation({
    mutationFn: (v: {
      planId: string;
      scope: 'day' | 'plan';
      date?: string;
      restore?: { mealId: string; scale: number }[];
    }) =>
      api.post<RebalanceResult>(`/meal-plans/${v.planId}/rebalance`, {
        scope: v.scope,
        ...(v.date ? { date: v.date } : {}),
        ...(v.restore ? { restore: v.restore } : {}),
      }),
    onSuccess: (res, v) => {
      // Undo / rest-of-plan re-runs replace the toast (undo simply clears it).
      if (v.restore) {
        invalidate();
        setRebalanceToast(null);
      } else {
        showRebalance(v.planId, res);
      }
    },
    onError: fail(t('errRebalance')),
  });

  const remove = useMutation({
    mutationFn: (planId: string) => api.delete<void>(`/meal-plans/${planId}`),
    onSuccess: invalidate,
    onError: fail(t('errDelete')),
  });

  const busy =
    regenerate.isPending ||
    regenerateDay.isPending ||
    offerSwap.isPending ||
    takeOffer.isPending ||
    addCustomMeal.isPending ||
    toggleEaten.isPending ||
    removeMeal.isPending ||
    rebalance.isPending ||
    remove.isPending;

  function onGenerate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!activeId) return;
    const f = new FormData(event.currentTarget);
    const dates = planDates(startDate, durationDays);
    setInTheWay(null);
    generate.mutate({
      profileId: activeId,
      startDate,
      durationDays,
      // Left out where the form leaves it to the profile: the plan then follows the profile when it is made again.
      ...(diet ? { dietType: diet } : {}),
      ...(mealCount ? { mealCount } : {}),
      ...(calorieTarget.trim() ? { calorieTargetOverride: Number(calorieTarget) } : {}),
      mealPrepFriendly: f.get('mealPrepFriendly') === 'on',
      respectExclusions: f.get('respectExclusions') === 'on',
      respectFavorites: f.get('respectFavorites') === 'on',
      respectInventory: f.get('respectInventory') === 'on',
      ...buildAdvancedRequest(advanced, dates, favoriteSets.data ?? [], planMeals),
    });
  }

  // The day of a plan that the calendar led to. The page goes there once the day is drawn: its plan may still be on
  // its way, and the list still being narrowed to it.
  const sought = useRef<{ planId: string; date: string } | null>(linked);
  useEffect(() => {
    const day = sought.current && document.getElementById(dayAnchor(sought.current.planId, sought.current.date));
    if (!day) return;
    sought.current = null;
    day.scrollIntoView({ block: 'start' });
    day.focus({ preventScroll: true });
  });
  const startDateField = useRef<HTMLInputElement>(null);

  if (profiles.isLoading) return <Skeleton className="h-40 max-w-2xl" />;
  if (profiles.isError) return <LoadFailed error={profiles.error} onRetry={() => void profiles.refetch()} />;

  if (list.length === 0) {
    return (
      <div className="mt-16">
        <EmptyState
          icon={UserRound}
          image={IMAGERY.emptyMealPlans}
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
      <PageBanner image={IMAGERY.mealPlans} title={t('title')} subtitle={t('subhead')} />

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
                setPage(1);
                setOpenPlan(null);
                setError(null);
                // Another profile has its own diet, meals and sets: what was chosen for this one does not carry over.
                setDiet('');
                setMealCount('');
                setCalorieTarget('');
                setAdvanced({ days: {} });
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
                  ref={startDateField}
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
              {/* What the box does is said beside it, and read out with it: its name stays short. */}
              <div className="self-end pb-1 text-sm">
                <label className="flex items-center gap-2">
                  <input name="mealPrepFriendly" type="checkbox" className="h-4 w-4" aria-describedby="meal-prep-hint" />
                  {t('mealPrepFriendly')}
                </label>
                <p id="meal-prep-hint" className="mt-1 text-xs text-muted-foreground">
                  {t('mealPrepFriendlyHint')}
                </p>
              </div>
            </div>
            {active && (
              <div className="space-y-1">
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label={t('diet')}>
                    <select className={selectClass} value={diet} onChange={(e) => setDiet(e.target.value as DietType | '')}>
                      <option value="">{t('asInProfile', { value: tDiet(active.dietType) })}</option>
                      {NAMED_DIETS.map((offered) => {
                        const supply = supplyOf(depth, offered, planMeals)?.supply;
                        return (
                          <option key={offered} value={offered}>
                            {supply === 'none' ? tCatalogue('dietNone', { diet: tDiet(offered) }) : supply === 'thin' ? tCatalogue('dietThin', { diet: tDiet(offered) }) : tDiet(offered)}
                          </option>
                        );
                      })}
                      {/* The custom diet is the profile's own split: there is one to plan to, or the diet is not on offer. */}
                      {active.customMacroSplit && <option value="custom">{t('dietCustom', active.customMacroSplit)}</option>}
                    </select>
                  </Field>
                  <Field label={t('mealsPerDay')}>
                    <select className={selectClass} value={mealCount} onChange={(e) => setMealCount(e.target.value ? Number(e.target.value) : '')}>
                      <option value="">{t('asInProfile', { value: active.mealCount })}</option>
                      {[2, 3, 4, 5].map((count) => (
                        <option key={count} value={count}>
                          {count}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t('calorieTarget')}>
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={MIN_CALORIE_TARGET}
                      max={MAX_CALORIE_TARGET}
                      step={1}
                      value={calorieTarget}
                      placeholder={calories.data ? String(calories.data.dailyTarget) : undefined}
                      onChange={(e) => setCalorieTarget(e.target.value)}
                    />
                  </Field>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('planChoicesHint')}
                  {calories.data && ` ${t('calorieTargetHint', { kcal: calories.data.dailyTarget })}`}
                </p>
              </div>
            )}
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
              defaultMealCount={planMeals}
              favorites={liked.map((f) => f.recipe)}
              sets={favoriteSets.data ?? []}
              defaultMaxRepeats={config?.plans.maxRepeatsPerRecipe ?? null}
              value={advanced}
              onChange={setAdvanced}
            />
            {active && <SupplyNote diet={planDiet} mealCount={planMeals} />}
            <Button type="submit" disabled={generate.isPending}>
              {generate.isPending ? t('generating') : t('generateButton')}
            </Button>
          </form>
        </CardContent>
      </Card>

      {error && <p className="max-w-2xl text-sm text-destructive">{error}</p>}
      {refused && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setError(null);
            (refused.reroll.dayId ? regenerateDay : regenerate).mutate({ ...refused.reroll, [refused.allow]: true });
          }}
        >
          {t(refused.allow === 'includePast' ? 'includePastAndRetry' : 'dropLockAndRetry')}
        </Button>
      )}
      {inTheWay && (
        <div
          className="max-w-2xl space-y-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning"
          role="alert"
        >
          <p>{t('limitsInTheWay', { count: inTheWay.needed.meals.length, limits: limitNames(inTheWay.needed.needs) })}</p>
          <ul className="list-disc pl-5 text-xs">
            {inTheWay.needed.meals.slice(0, MEALS_NAMED).map((meal) => (
              <li key={`${meal.date} ${meal.slot}`}>
                {fmt.day(meal.date)} · {tMeal(meal.slot)}: {limitNames(meal.gaveWay)}
              </li>
            ))}
            {inTheWay.needed.meals.length > MEALS_NAMED && (
              <li>{t('limitsInTheWayMore', { count: inTheWay.needed.meals.length - MEALS_NAMED })}</li>
            )}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || generate.isPending}
              onClick={() => {
                const allowRelaxations = withMore(inTheWay.allowed, inTheWay.needed.needs);
                setError(null);
                if ('generate' in inTheWay) {
                  // The form says from here on what the plan was let do.
                  setAdvanced((value) => ({ ...value, mayGiveWay: allowRelaxations }));
                  generate.mutate({ ...inTheWay.generate, allowRelaxations });
                } else {
                  (inTheWay.reroll.dayId ? regenerateDay : regenerate).mutate({ ...inTheWay.reroll, allowRelaxations });
                }
              }}
            >
              {t('letGiveWay', { count: inTheWay.needed.needs.length })}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setInTheWay(null)}>
              {tCommon('cancel')}
            </Button>
          </div>
        </div>
      )}
      {notice && (
        <p
          className="max-w-2xl rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning"
          role="status"
        >
          {notice}
        </p>
      )}

      <DisclaimerNotice bodyKey={aiEnabled ? 'aiPlans' : 'enginePlans'} />

      {activeId && (
        <Card className="max-w-3xl">
          <CardHeader>
            <CardTitle>{t('calendar.title')}</CardTitle>
            <p className="text-sm text-muted-foreground">{t('calendar.lead')}</p>
          </CardHeader>
          <CardContent>
            <PlanCalendar
              key={activeId}
              profileId={activeId}
              today={localDate()}
              onOpen={(planId, date) => {
                // The list is narrowed to the plans that hold the day, so that the plan is on the page whatever page of the list it was on.
                setStatus('');
                setFrom(date);
                setTo(date);
                setPage(1);
                setOpenPlan(planId);
                sought.current = { planId, date };
              }}
              onStart={(date) => {
                // A day without a plan is where the next one can begin: the form above takes it.
                setStartDate(date);
                startDateField.current?.scrollIntoView({ block: 'center' });
                startDateField.current?.focus({ preventScroll: true });
              }}
            />
          </CardContent>
        </Card>
      )}

      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 className="text-lg font-semibold tracking-tight">
            {active ? t('plansFor', { name: active.name }) : t('plans')}
          </h2>
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-wrap gap-1">
              {(['', 'active', 'upcoming', 'past'] as const).map((s) => {
                const labelKey =
                  s === '' ? 'statusAll' : s === 'active' ? 'statusActive' : s === 'upcoming' ? 'statusUpcoming' : 'statusPast';
                return (
                  <Button
                    key={s || 'all'}
                    size="sm"
                    variant={status === s ? 'primary' : 'outline'}
                    onClick={() => {
                      setStatus(s);
                      setPage(1);
                    }}
                  >
                    {t(labelKey)}
                  </Button>
                );
              })}
            </div>
            <Field label={t('from')}>
              <Input
                type="date"
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value);
                  setPage(1);
                }}
              />
            </Field>
            <Field label={t('to')}>
              <Input
                type="date"
                value={to}
                onChange={(e) => {
                  setTo(e.target.value);
                  setPage(1);
                }}
              />
            </Field>
            {(from || to || status) && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setStatus('');
                  setFrom('');
                  setTo('');
                  setPage(1);
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
        {session.data && !aiEnabled && <AiOffNote id={aiOffNote} />}
        {plans.isLoading ? (
          <Skeleton className="h-24 max-w-3xl" />
        ) : plans.isError ? (
          <LoadFailed error={plans.error} onRetry={() => void plans.refetch()} />
        ) : (plans.data?.items ?? []).length === 0 ? (
          <EmptyState
            icon={CalendarRange}
            image={IMAGERY.emptyMealPlans}
            title={t('noPlansTitle')}
            description={t('noPlans')}
          />
        ) : (
          (plans.data?.items ?? []).map((plan) => (
            <PlanCard
              key={plan.id}
              summary={plan}
              plan={openPlan === plan.id ? opened.data : undefined}
              open={openPlan === plan.id}
              busy={busy}
              dietLabel={tDiet(plan.dietType)}
              onToggle={() => setOpenPlan(openPlan === plan.id ? null : plan.id)}
              onReroll={(asked) => {
                setError(null);
                (asked.dayId ? regenerateDay : regenerate).mutate({ planId: plan.id, ...asked });
              }}
              limitNames={limitNames}
              onDelete={() => {
                setError(null);
                if (window.confirm(t('deleteConfirm'))) {
                  remove.mutate(plan.id);
                }
              }}
              onSwapMeal={(plannedMealId) => askFor({ planId: plan.id, plannedMealId, strategy: 'random' })}
              onSwapByFavorites={(plannedMealId) => askFor({ planId: plan.id, plannedMealId, strategy: 'favorite_ingredients' })}
              onSwapToFavorite={(plannedMealId, favoriteRecipeId, allowOffDiet) =>
                askFor({ planId: plan.id, plannedMealId, strategy: 'favorite', favoriteRecipeId, allowOffDiet })
              }
              onAiSwapMeal={aiEnabled ? (plannedMealId) => askFor({ planId: plan.id, plannedMealId, strategy: 'ai' }) : undefined}
              aiOffNote={aiOffNote}
              offer={offer?.asked.planId === plan.id ? offer : null}
              onTakeOffer={() => offer && takeOffer.mutate(offer)}
              onAnotherOffer={() => offer && askFor(offer.asked, offer.seen)}
              onCancelOffer={() => setOffer(null)}
              onToggleEaten={(mealId, eaten) => {
                setError(null);
                toggleEaten.mutate({ planId: plan.id, mealId, eaten });
              }}
              onIngredientSwapped={(res) => {
                showRebalance(plan.id, res);
                // Set only when a rewording by a model was asked for: say so
                // when the plain replacement stands instead.
                if (res.aiMeta) setNotice(res.aiMeta.fallbackReason ? tFallback(res.aiMeta.fallbackReason) : null);
              }}
              onAddCustomMeal={(date, body) => {
                setError(null);
                addCustomMeal.mutate({ planId: plan.id, date, body });
              }}
              onRemoveMeal={(mealId) => {
                setError(null);
                removeMeal.mutate({ planId: plan.id, mealId });
              }}
              onSpread={(date) => {
                setError(null);
                rebalance.mutate({ planId: plan.id, scope: 'plan', date });
              }}
              onSwapped={(res) => showRebalance(plan.id, res)}
              onChanged={() => void invalidate()}
              favorites={liked}
              tMeal={tMeal}
            />
          ))
        )}
        {(plans.data?.totalPages ?? 0) > 1 && (
          <nav aria-label={t('pages')} className="flex items-center gap-3 text-sm">
            <Button type="button" variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              {t('pageNewer')}
            </Button>
            <span className="text-muted-foreground">{t('pageOf', { page, pages: plans.data!.totalPages })}</span>
            <Button type="button" variant="outline" size="sm" disabled={page >= plans.data!.totalPages} onClick={() => setPage(page + 1)}>
              {t('pageOlder')}
            </Button>
          </nav>
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
          onRebalanceRest={() =>
            rebalance.mutate({ planId: rebalanceToast.planId, scope: 'plan' })
          }
          onDismiss={() => setRebalanceToast(null)}
        />
      )}
    </div>
  );
}

export default function MealPlansPage() {
  return (
    <Suspense fallback={<Skeleton className="h-40 max-w-2xl" />}>
      <MealPlansContent />
    </Suspense>
  );
}
