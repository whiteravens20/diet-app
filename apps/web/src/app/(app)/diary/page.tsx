// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Copy, NotebookPen, Pencil, Plus, Trash } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Suspense, useId, useState } from 'react';
import type {
  CreateDiaryEntryRequest,
  DiaryDay,
  DiaryEntry,
  DiaryPlanMeal,
  MealType,
  Profile,
  RebalanceRequest,
  RebalanceResult,
  UpdateDiaryEntryRequest,
  WrittenDiaryCopy,
  WrittenDiaryEntry,
} from '@diet-app/shared';
import {
  DIARY_DAYS_BACK,
  FIRST_DAY,
  LAST_DAY,
  MAX_DIARY_ENTRIES_A_DAY,
  MEAL_SLOTS_BY_COUNT,
} from '@diet-app/shared/constants';
import { useShownAmount } from '@/lib/ingredient-format';
import { api } from '@/lib/api';
import { useConfig } from '@/lib/use-config';
import { localDate } from '@/lib/http';
import { IMAGERY } from '@/lib/imagery';
import { dayAfter } from '@/lib/plan-dates';
import { useErrorText } from '@/lib/use-error-text';
import { useFormat } from '@/lib/use-format';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/empty-state';
import { LabelLegend, LabelLine, LabelNotes } from '@/components/label-figures';
import { LoadFailed, ReadsFailed, unread } from '@/components/load-failed';
import { PageBanner } from '@/components/page-banner';
import { ProfileChips } from '@/components/profile-chips';
import { RebalanceToast, type PlanWord } from '../meal-plans/rebalance-toast';
import { AddEntryDialog } from './add-entry-dialog';
import { EditEntryDialog } from './edit-entry-dialog';
import { useEntryAmount } from '@/components/diary-entry-amount';
import { RemovedBar, useRemovedLater } from '@/components/removed-later';
import { WaterCard } from '@/components/water-card';
import { WeekSummaryCard } from '@/components/week-summary';
import { DOT, held } from '@/lib/figure-line';
import { carbsBandOf } from '@/lib/carbs-band';

/** The meals of a day in the order they are eaten. */
const EATING_ORDER = MEAL_SLOTS_BY_COUNT[5]!;

/** A calendar day as an address writes it, one there is, in the years a request may name. */
function isDay(text: string | null): text is string {
  return (
    text !== null &&
    /^\d{4}-\d{2}-\d{2}$/.test(text) &&
    !Number.isNaN(Date.parse(`${text}T00:00:00Z`)) &&
    new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) === text &&
    text >= FIRST_DAY &&
    text <= LAST_DAY
  );
}

/**
 * The diary: what a profile ate on a day, the meals its plan marks as eaten
 * and the entries written for the day, against the day's target. A day of
 * today or of the year before it takes entries; a link from a plan names the
 * day (`?profile=&date=`).
 */
export default function DiaryPage() {
  return (
    <Suspense fallback={<Skeleton className="h-40" />}>
      <DiaryContent />
    </Suspense>
  );
}

function DiaryContent() {
  const t = useTranslations('diary');
  const productsOffered = useConfig().data?.products.offered ?? false;
  const tPlans = useTranslations('mealPlans');
  const errorText = useErrorText();
  const qc = useQueryClient();
  const params = useSearchParams();
  const today = localDate();

  const profiles = useQuery({
    queryKey: ['profiles'],
    queryFn: () => api.get<Profile[]>('/profiles'),
  });
  const list = profiles.data ?? [];
  const [picked, setPicked] = useState<string | null>(null);
  const active =
    list.find((profile) => profile.id === (picked ?? params.get('profile'))) ?? list[0] ?? null;
  const [date, setDate] = useState(() => {
    const asked = params.get('date');
    return isDay(asked) ? asked : today;
  });

  // Read anew whenever the page opens: the plan's page, a profile and a recipe change what a day shows.
  const day = useQuery({
    queryKey: ['diary', active?.id, date],
    queryFn: () => api.get<DiaryDay>(`/diary/day?profileId=${active!.id}&date=${date}`),
    enabled: active !== null,
    staleTime: 0,
  });

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Whether the window that copies another day into this one is open.
  const [copying, setCopying] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [adding, setAdding] = useState<MealType | null>(null);
  const [editing, setEditing] = useState<DiaryEntry | null>(null);
  const [toast, setToast] = useState<PlanWord | null>(null);
  /** What a change of a plan's meal came to, where it resized the day. */
  const wordOf = (planId: string, result: RebalanceResult): PlanWord | null =>
    result.rebalance && result.rebalance.changes.length > 0
      ? {
          planId,
          revision: result.plan.revision,
          swap: false,
          day: result.plan.days.find((day) => day.date === date) ?? null,
          rebalance: result.rebalance,
        }
      : null;

  /** What a change of the diary or of a plan's day touches: the day, and every view of a plan, which counts the diary. */
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['diary'] }),
      qc.invalidateQueries({ queryKey: ['meal-plans'] }),
      qc.invalidateQueries({ queryKey: ['meal-plan'] }),
      qc.invalidateQueries({ queryKey: ['plan-overview'] }),
    ]);

  /** What was said of the step before goes when the next one starts. */
  const nextStep = () => {
    setError(null);
    setNotice(null);
  };

  /** An entry of today sizes the day of its plan again, as a meal of one's own does there: said with the plan's note. */
  const planChanged = (written: { planChange: RebalanceResult | null }) => {
    if (written.planChange) setToast(wordOf(written.planChange.plan.id, written.planChange));
  };
  const add = useMutation({
    mutationFn: (body: CreateDiaryEntryRequest) =>
      api.post<WrittenDiaryEntry>('/diary/entries', body),
    onMutate: nextStep,
    onSuccess: async (written) => {
      setAdding(null);
      planChanged(written);
      await refresh();
    },
    onError: (e) => setDialogError(errorText(e, t('errAdd'))),
  });
  const update = useMutation({
    mutationFn: ({ id, change }: { id: string; change: UpdateDiaryEntryRequest }) =>
      api.patch<WrittenDiaryEntry>(`/diary/entries/${id}`, change),
    onMutate: nextStep,
    onSuccess: async (written) => {
      setEditing(null);
      planChanged(written);
      await refresh();
    },
    onError: (e) => setDialogError(errorText(e, t('errUpdate'))),
  });
  const remove = useMutation({
    // Sent so that it outlives the page: a removal still held goes when the page is closed as well.
    mutationFn: (id: string) =>
      api.request<void>(`/diary/entries/${id}`, { method: 'DELETE', keepalive: true }),
    onMutate: nextStep,
    onSuccess: refresh,
    onError: (e) => setError(errorText(e, t('errRemove'))),
  });
  // An entry is cheap to write again: it goes at once, and is sent once the moments to take it back are over.
  const later = useRemovedLater<DiaryEntry>(
    (entry) => remove.mutateAsync(entry.id),
    (entry) => entry.id,
  );
  // Marking a meal of the plan as eaten rebalances its day, as on the plan's page, and says so with the same note.
  const eat = useMutation({
    mutationFn: ({ planId, meal }: { planId: string; meal: DiaryPlanMeal }) =>
      api.patch<RebalanceResult>(`/meal-plans/${planId}/meals/${meal.id}/eaten`, {
        eaten: !meal.eaten,
      }),
    onMutate: nextStep,
    onSuccess: async (result, { planId }) => {
      setToast(wordOf(planId, result));
      await refresh();
    },
    onError: (e) => setError(errorText(e, t('errEaten'))),
  });
  const rebalance = useMutation({
    mutationFn: ({ planId, body }: { planId: string; body: RebalanceRequest }) =>
      api.post<RebalanceResult>(`/meal-plans/${planId}/rebalance`, body),
    onMutate: nextStep,
    onSuccess: async (result, { planId, body }) => {
      // An undo puts the portions back and has nothing more to say.
      setToast(body.restore ? null : wordOf(planId, result));
      // A press that changes nothing says so, or it looks as if it had not been heard.
      if (!body.restore && result.rebalance?.changes.length === 0) {
        const left = result.rebalance.unabsorbedKcal;
        setNotice(
          left === 0
            ? tPlans('resizeNothing')
            : tPlans(left > 0 ? 'rebalanceLeftOver' : 'rebalanceLeftUnder', {
                kcal: Math.abs(left),
              }),
        );
      }
      await refresh();
    },
    onError: (e) => setError(errorText(e, t('errRebalance'))),
  });
  const copy = useMutation({
    mutationFn: (from: string) =>
      api.post<WrittenDiaryCopy>('/diary/copy', { profileId: active!.id, from, to: date }),
    onSuccess: async (result) => {
      setCopying(false);
      setNotice(t('copied', { count: result.copied }));
      planChanged(result);
      await refresh();
    },
    onError: (e) => setError(errorText(e, t('errCopy'))),
  });

  /** Another day, or another profile: what was said of the one before goes. */
  const leave = () => {
    setError(null);
    setNotice(null);
    setToast(null);
    copy.reset();
  };
  /** Another day, or another profile: the window that copies into the day before closes with it. */
  const leaveDay = () => {
    leave();
    setCopying(false);
  };

  if (profiles.isLoading) return <Skeleton className="h-40" />;
  if (unread(profiles))
    return <LoadFailed error={profiles.error} onRetry={() => void profiles.refetch()} />;
  if (!active) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{t('createProfileFirst')}</p>
        </CardContent>
      </Card>
    );
  }

  const shown = day.data;
  const ahead = date > today;
  const tooOld = date < dayAfter(today, -DIARY_DAYS_BACK);
  const full = (shown?.entries.length ?? 0) >= MAX_DIARY_ENTRIES_A_DAY;
  // The meals the day has: those of its plan and those something was written for, in the order they are eaten.
  const meals = shown
    ? EATING_ORDER.filter(
        (slot) =>
          shown.plan?.meals.some((meal) => meal.mealType === slot) ||
          shown.entries.some((entry) => entry.mealType === slot),
      )
    : [];
  const busy = eat.isPending || rebalance.isPending || remove.isPending;

  return (
    <div className="space-y-8">
      <PageBanner image={IMAGERY.diary} title={t('title')} subtitle={t('subhead')} />
      <ReadsFailed reads={[profiles, day]} />

      <ProfileChips
        profiles={list}
        active={active.id}
        onPick={(id) => {
          setPicked(id);
          leaveDay();
        }}
      />

      <DayPicker
        date={date}
        today={today}
        onPick={(next) => {
          setDate(next);
          leaveDay();
        }}
      >
        {/* Copying another day here is a thing done to this day: beside its date. */}
        {!ahead && !tooOld && (
          <Button type="button" variant="outline" size="sm" onClick={() => setCopying(true)}>
            <Copy className="h-4 w-4" aria-hidden />
            {t('copyTitle')}
          </Button>
        )}
      </DayPicker>

      {error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      )}
      {notice && (
        <p role="status" className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
          {notice}
        </p>
      )}

      {day.isLoading ? (
        <Skeleton className="h-60" />
      ) : unread(day) ? (
        <LoadFailed error={day.error} onRetry={() => void day.refetch()} />
      ) : (
        shown && (
          <>
            <DaySummary
              day={shown}
              past={date < today}
              busy={busy}
              onRebalance={(planId) =>
                rebalance.mutate({ planId, body: { scope: 'day', date: shown.date } })
              }
            />

            {ahead ? (
              <p className="text-sm text-muted-foreground">{t('aheadNote')}</p>
            ) : tooOld ? (
              <p className="text-sm text-muted-foreground">{t('tooOldNote')}</p>
            ) : full ? (
              <p className="text-sm text-muted-foreground">
                {t('fullNote', { count: MAX_DIARY_ENTRIES_A_DAY })}
              </p>
            ) : (
              <div>
                <Button
                  type="button"
                  onClick={() => {
                    setDialogError(null);
                    setAdding(meals[0] ?? EATING_ORDER[0]!);
                  }}
                >
                  <Plus className="h-4 w-4" />
                  {t('addTitle')}
                </Button>
              </div>
            )}

            {meals.length === 0 && !ahead && !tooOld && (
              <EmptyState
                icon={NotebookPen}
                title={t('emptyTitle')}
                description={t(productsOffered ? 'emptyTextProducts' : 'emptyText')}
              />
            )}
            {meals.map((slot) => (
              <MealSection
                key={slot}
                slot={slot}
                day={shown}
                canAdd={!ahead && !tooOld && !full}
                canEat={!ahead}
                busy={busy}
                onAdd={() => {
                  setDialogError(null);
                  setAdding(slot);
                }}
                onEat={(meal) => eat.mutate({ planId: shown.plan!.id, meal })}
                onEdit={(entry) => {
                  setDialogError(null);
                  setEditing(entry);
                }}
                hidden={later.hidden}
                onRemove={later.remove}
              />
            ))}

            {/* The day's water, after what was eaten, where the diary takes entries for it: not a day still to
                come, nor one over a year back. */}
            {active?.waterTracking && !ahead && !tooOld && (
              <WaterCard profile={active} day={shown.date} />
            )}
          </>
        )
      )}

      {/* The profile's weeks in sum, from the one before today back a week at a time, folded to one line. */}
      {active && <WeekSummaryCard profile={active} weeks folded />}

      {copying && (
        <CopyDay
          date={date}
          today={today}
          busy={copy.isPending}
          onClose={() => setCopying(false)}
          onCopy={(from) => {
            leave();
            copy.mutate(from);
          }}
        />
      )}

      {adding && (
        <AddEntryDialog
          meal={adding}
          date={date}
          busy={add.isPending}
          error={dialogError}
          onClose={() => setAdding(null)}
          onSubmit={(entry) => {
            setDialogError(null);
            add.mutate({ ...entry, profileId: active.id, date });
          }}
        />
      )}
      {editing && (
        <EditEntryDialog
          entry={editing}
          busy={update.isPending}
          error={dialogError}
          onClose={() => setEditing(null)}
          onSubmit={(change) => {
            setDialogError(null);
            update.mutate({ id: editing.id, change });
          }}
        />
      )}
      {later.waiting && <RemovedBar name={later.waiting.name} onUndo={later.undo} />}
      {toast && (
        <RebalanceToast
          word={toast}
          busy={rebalance.isPending}
          onUndo={() =>
            rebalance.mutate({
              planId: toast.planId,
              body: {
                scope: 'day',
                restore: (toast.rebalance?.changes ?? []).map((change) => ({
                  mealId: change.mealId,
                  scale: change.before,
                })),
              },
            })
          }
          onRebalanceRest={() =>
            rebalance.mutate({ planId: toast.planId, body: { scope: 'plan' } })
          }
          onDismiss={() => setToast(null)}
        />
      )}
    </div>
  );
}

/** The day shown, the days on either side of it, and today. */
function DayPicker({
  date,
  today,
  onPick,
  children,
}: {
  date: string;
  today: string;
  onPick: (day: string) => void;
  /** What is done to the day shown, beside its date. */
  children?: React.ReactNode;
}) {
  const t = useTranslations('diary');
  const fmt = useFormat();
  const id = useId();
  // What the field holds while a day is typed into it: every step of typing a year names a day, and only one a request may name is gone to.
  const [typed, setTyped] = useState(date);
  const [typedFor, setTypedFor] = useState(date);
  if (typedFor !== date) {
    setTypedFor(date);
    setTyped(date);
  }
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label={t('previousDay')}
        disabled={date <= FIRST_DAY}
        onClick={() => onPick(dayAfter(date, -1))}
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <div>
        <label htmlFor={id} className="block text-xs font-medium text-muted-foreground">
          {t('dayLabel')}
        </label>
        <Input
          id={id}
          type="date"
          value={typed}
          min={FIRST_DAY}
          max={LAST_DAY}
          onChange={(e) => {
            setTyped(e.target.value);
            if (isDay(e.target.value)) onPick(e.target.value);
          }}
          onBlur={() => setTyped(date)}
          className="w-44"
        />
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label={t('nextDay')}
        disabled={date >= LAST_DAY}
        onClick={() => onPick(dayAfter(date, 1))}
      >
        <ChevronRight className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => onPick(today)}
        disabled={date === today}
      >
        {t('today')}
      </Button>
      {children}
      <p className="w-full text-sm font-medium sm:w-auto sm:pb-2">{fmt.date(date)}</p>
    </div>
  );
}

/** The macronutrients, in the order the day's figures give them. */
const MACROS = ['protein', 'fat', 'carbs'] as const;

/** What was eaten against the day's target, and where the plan's day stands with the diary counted. */
function DaySummary({
  day,
  past,
  busy,
  onRebalance,
}: {
  day: DiaryDay;
  /** The day is before today: its meals are done with, and what it is off by goes to the days after it. */
  past: boolean;
  busy: boolean;
  onRebalance: (planId: string) => void;
}) {
  const t = useTranslations('diary');
  const tMacro = useTranslations('macrosLine');
  const fmt = useFormat();
  const id = useId();
  const band = carbsBandOf(day.target);
  const share = day.target.calories > 0 ? Math.min(1, day.eaten.calories / day.target.calories) : 0;
  const plan = day.plan;
  // Where nothing is written, the plan's day stands as its own meals put it.
  const written = day.entries.length > 0;
  // Offered where sizing the day again would move a meal, as the server works it out.
  const resizable = plan?.resizes ?? false;
  return (
    <Card>
      <CardHeader>
        <h2 className="text-base font-semibold tracking-tight">{t('eatenTitle')}</h2>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-2xl font-semibold tabular-nums">
          {day.estimated && '≈ '}
          {t('eatenLine', { eaten: day.eaten.calories, target: day.target.calories })}
        </p>
        {/* The line above says it in figures. */}
        <div aria-hidden className="h-2 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary" style={{ width: `${share * 100}%` }} />
        </div>
        {/* Each macronutrient as a figure against what the day aims at: on low-carb and keto carbohydrate
            against the diet's band. The name is read before the figure, the figure is seen first. */}
        <dl className="grid grid-cols-3 gap-2 text-center">
          {MACROS.map((macro) => (
            <div key={macro} className="flex flex-col">
              <dt className="order-2 text-xs text-muted-foreground">{tMacro(macro)}</dt>
              <dd className="order-1 text-lg font-semibold tabular-nums">
                {fmt.unit(day.eaten[macro], 'gram', 0)}
              </dd>
              <dd className="order-3 text-xs text-muted-foreground">
                {macro === 'carbs' && band !== 'none'
                  ? t('inBand', {
                      band,
                      floor: day.target.carbsFloor ?? 0,
                      ceiling: day.target.carbs,
                    })
                  : t('ofTarget', { target: day.target[macro] })}
              </dd>
            </div>
          ))}
        </dl>
        <LabelLine totals={day.eatenLabel} className="text-sm" />
        {/* What a limit says of the day holds the day's own figures: it stays in sight. */}
        <LabelNotes notes={day.labelNotes} />

        {plan && (
          <div className="space-y-2 border-t border-border pt-3 text-sm">
            {plan.skipped ? null : plan.offTarget ? (
              <>
                <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-warning">
                  <span className="whitespace-nowrap rounded bg-warning/15 px-1.5 py-0.5 text-2xs font-medium">
                    {t(plan.offTarget === 'over' ? 'planOver' : 'planUnder')}
                  </span>
                  <span>
                    {t(
                      plan.offTarget === 'over'
                        ? written
                          ? 'planOverNote'
                          : 'planOverPlain'
                        : written
                          ? 'planUnderNote'
                          : 'planUnderPlain',
                      { kcal: Math.abs(plan.calorieDelta) },
                    )}
                  </span>
                </p>
                {past ? (
                  <p className="text-xs text-muted-foreground">{t('planPastNote')}</p>
                ) : (
                  resizable && (
                    // What resizing does is said beside the button, before it is pressed.
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        aria-describedby={`${id}-rebalance`}
                        onClick={() => onRebalance(plan.id)}
                      >
                        {t('rebalance')}
                      </Button>
                      <span id={`${id}-rebalance`} className="text-xs text-muted-foreground">
                        {t('rebalanceNote')}
                      </span>
                    </div>
                  )
                )}
              </>
            ) : (
              <p className="text-muted-foreground">
                {t(written ? 'planOnTarget' : 'planOnTargetPlain')}
              </p>
            )}
            <Link
              href={`/meal-plans?profile=${day.profileId}&plan=${plan.id}&day=${day.date}`}
              className={buttonVariants({ variant: 'ghost', size: 'sm' })}
            >
              {t('openPlan')}
            </Link>
          </div>
        )}
        {/* Where the target comes from, what ≈ and the marks of the label mean: once, under the figures they explain. */}
        <details className="text-xs text-muted-foreground">
          <summary className="w-fit cursor-pointer py-1">{t('howItWorks')}</summary>
          <div className="mt-1 space-y-1">
            <p>
              {t(
                plan?.skipped
                  ? 'targetFromSkipped'
                  : day.target.from === 'plan'
                    ? 'targetFromPlan'
                    : 'targetFromProfile',
              )}
            </p>
            {day.estimated && <p>{t('estimatedNote')}</p>}
            <LabelLegend totals={day.eatenLabel} />
          </div>
        </details>
      </CardContent>
    </Card>
  );
}

/** A meal of the day: what its plan has for it, and what was written for it. */
function MealSection({
  slot,
  day,
  canAdd,
  canEat,
  busy,
  onAdd,
  onEat,
  onEdit,
  hidden,
  onRemove,
}: {
  slot: MealType;
  day: DiaryDay;
  canAdd: boolean;
  /** The day has come: what is still to come cannot have been eaten. */
  canEat: boolean;
  busy: boolean;
  onAdd: () => void;
  onEat: (meal: DiaryPlanMeal) => void;
  onEdit: (entry: DiaryEntry) => void;
  /** Whether an entry was removed: not shown while it can be taken back, nor once its removal is sent. */
  hidden: (entry: DiaryEntry) => boolean;
  onRemove: (entry: DiaryEntry) => void;
}) {
  const t = useTranslations('diary');
  const shownAmount = useShownAmount();
  const tMeal = useTranslations('enums.mealType');
  const amountOf = useEntryAmount();
  const fmt = useFormat();
  const id = useId();
  const planned = day.plan?.meals.filter((meal) => meal.mealType === slot) ?? [];
  const entries = day.entries.filter((entry) => entry.mealType === slot && !hidden(entry));
  return (
    <section aria-labelledby={`${id}-title`} className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h2 id={`${id}-title`} className="text-lg font-semibold">
          {tMeal(slot)}
        </h2>
        {canAdd && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={t('addTo', { meal: tMeal(slot) })}
            onClick={onAdd}
          >
            <Plus className="h-4 w-4" />
            {t('add')}
          </Button>
        )}
      </div>
      <Card>
        <ul className="divide-y divide-border">
          {planned.map((meal) => (
            <li key={meal.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
              <div className="min-w-0 flex-1 basis-48">
                <p id={`${id}-${meal.id}`} className="break-words text-sm font-medium">
                  {/* A meal of a recipe opens in its window, as the plan shows it; closing it comes back here. */}
                  {meal.recipeId && day.plan ? (
                    <Link
                      href={`/meal-plans?profile=${day.profileId}&plan=${day.plan.id}&day=${day.date}&meal=${meal.id}&from=diary`}
                      className="text-primary hover:underline"
                    >
                      {fmt.text(meal.name)}
                    </Link>
                  ) : (
                    fmt.text(meal.name)
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('fromPlan')}
                  {DOT}
                  {/* A portion of a shared pot is the plan's, which a split by weight comes only near. */}
                  {meal.fromPot
                    ? t('mealKcalFromPot', { kcal: meal.nutrition.calories })
                    : t('mealKcal', { kcal: meal.nutrition.calories })}
                </p>
                {/* What was put on this plate alone is counted with the meal. */}
                {meal.topping && (
                  <p className="text-xs text-muted-foreground">
                    {t('mealTopping', {
                      name: fmt.text(meal.topping.name),
                      amount: shownAmount(meal.topping.display),
                    })}
                  </p>
                )}
              </div>
              <label className="flex min-h-6 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={meal.eaten}
                  disabled={busy || !canEat}
                  aria-describedby={`${id}-${meal.id}`}
                  onChange={() => onEat(meal)}
                />
                {t('eatenToggle')}
              </label>
            </li>
          ))}
          {entries.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
              <div className="min-w-0 flex-1 basis-48">
                <p className="break-words text-sm font-medium">{fmt.text(entry.name)}</p>
                <p className="text-xs text-muted-foreground">
                  {held(amountOf(entry))}
                  {DOT}
                  {held(t('mealKcal', { kcal: entry.nutrition.calories }))}
                  {DOT}
                  {t('entryMacros', entry.nutrition)}
                  {entry.estimated && (
                    <>
                      {DOT}
                      <span className="whitespace-nowrap font-medium text-foreground">
                        ≈ {t('estimated')}
                      </span>
                    </>
                  )}
                  {entry.kind === 'product' && (
                    <>
                      {DOT}
                      <span className="whitespace-nowrap">
                        {t(
                          entry.productSource === 'own'
                            ? 'entrySourceOwn'
                            : entry.productSource === 'instance'
                              ? 'entrySourceInstance'
                              : 'entrySource',
                        )}
                      </span>
                    </>
                  )}
                </p>
              </div>
              <div className="flex gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={t('editLabel', { name: entry.name })}
                  onClick={() => onEdit(entry)}
                >
                  <Pencil className="h-4 w-4" />
                  {t('edit')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  aria-label={t('removeLabel', { name: entry.name })}
                  onClick={() => onRemove(entry)}
                >
                  <Trash className="h-4 w-4" />
                  {t('remove')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}

/**
 * The window that copies what another day holds into the day shown: the day to copy from, and the
 * button. It closes once the copy is made, and the page says what came.
 */
function CopyDay({
  date,
  today,
  busy,
  onClose,
  onCopy,
}: {
  date: string;
  today: string;
  busy: boolean;
  onClose: () => void;
  onCopy: (from: string) => void;
}) {
  const t = useTranslations('diary');
  const tCommon = useTranslations('common');
  const fmt = useFormat();
  const id = useId();
  const [from, setFrom] = useState(() => dayAfter(date, -1));
  const itself = from === date;
  return (
    <Dialog open onClose={onClose} label={t('copyTitle')} className="max-w-md">
      <div className="flex items-center justify-between border-b border-border p-4">
        <h2 className="font-semibold">{t('copyTitle')}</h2>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {tCommon('close')}
        </Button>
      </div>
      <form
        className="space-y-3 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          // The browser holds the day to one there is, today or before it.
          if (isDay(from) && !itself) onCopy(from);
        }}
      >
        <p id={`${id}-note`} className="text-sm text-muted-foreground">
          {t('copyNote')}
        </p>
        <div>
          <label htmlFor={id} className="block text-xs font-medium text-muted-foreground">
            {t('copyFrom')}
          </label>
          <Input
            id={id}
            type="date"
            value={from}
            min={FIRST_DAY}
            max={today}
            onChange={(e) => setFrom(e.target.value)}
            className="w-44"
            required
          />
        </div>
        {itself && (
          <p id={`${id}-itself`} className="text-xs text-muted-foreground">
            {t('copySameDay')}
          </p>
        )}
        <div className="flex justify-end">
          {/* Off while the copy is sent: a quick double press would write it twice. */}
          <Button
            type="submit"
            disabled={busy || itself}
            aria-describedby={itself ? `${id}-itself` : `${id}-note`}
          >
            {t('copyButton', { day: fmt.day(date) })}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
