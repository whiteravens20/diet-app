// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, NotebookPen, Pencil, Plus, Trash } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Suspense, useId, useState } from 'react';
import type {
  CreateDiaryEntryRequest,
  DiaryCopyResult,
  DiaryDay,
  DiaryEntry,
  DiaryPlanMeal,
  DisplayAmount,
  MealType,
  Profile,
  RebalanceRequest,
  RebalanceResult,
  UpdateDiaryEntryRequest,
} from '@diet-app/shared';
import {
  DIARY_DAYS_BACK,
  FIRST_DAY,
  LAST_DAY,
  MAX_DIARY_ENTRIES_A_DAY,
  MEAL_SLOTS_BY_COUNT,
} from '@diet-app/shared/constants';
import { api } from '@/lib/api';
import { localDate } from '@/lib/http';
import { IMAGERY } from '@/lib/imagery';
import { useAmount, useUnitName } from '@/lib/ingredient-format';
import { dayAfter } from '@/lib/plan-dates';
import { useErrorText } from '@/lib/use-error-text';
import { useFormat } from '@/lib/use-format';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/empty-state';
import { LoadFailed } from '@/components/load-failed';
import { PageBanner } from '@/components/page-banner';
import { RebalanceToast } from '../meal-plans/rebalance-toast';
import { AddEntryDialog } from './add-entry-dialog';
import { EditEntryDialog, shownServings } from './edit-entry-dialog';

/** The meals of a day in the order they are eaten. */
const EATING_ORDER = MEAL_SLOTS_BY_COUNT[5]!;

const selectClass = 'h-10 w-full rounded-md border border-input bg-background px-3 text-sm';

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
    <Suspense fallback={<Skeleton className="h-40 max-w-2xl" />}>
      <DiaryContent />
    </Suspense>
  );
}

function DiaryContent() {
  const t = useTranslations('diary');
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

  const day = useQuery({
    queryKey: ['diary', active?.id, date],
    queryFn: () => api.get<DiaryDay>(`/diary/day?profileId=${active!.id}&date=${date}`),
    enabled: active !== null,
  });

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [adding, setAdding] = useState<MealType | null>(null);
  const [editing, setEditing] = useState<DiaryEntry | null>(null);
  const [toast, setToast] = useState<{
    planId: string;
    rebalance: NonNullable<RebalanceResult['rebalance']>;
  } | null>(null);

  /** What a change of the diary or of a plan's day touches: the day, and every view of a plan, which counts the diary. */
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['diary'] }),
      qc.invalidateQueries({ queryKey: ['meal-plans'] }),
      qc.invalidateQueries({ queryKey: ['meal-plan'] }),
      qc.invalidateQueries({ queryKey: ['plan-overview'] }),
    ]);

  const add = useMutation({
    mutationFn: (body: CreateDiaryEntryRequest) => api.post<DiaryEntry>('/diary/entries', body),
    onSuccess: async () => {
      setAdding(null);
      await refresh();
    },
    onError: (e) => setDialogError(errorText(e, t('errAdd'))),
  });
  const update = useMutation({
    mutationFn: ({ id, change }: { id: string; change: UpdateDiaryEntryRequest }) =>
      api.patch<DiaryEntry>(`/diary/entries/${id}`, change),
    onSuccess: async () => {
      setEditing(null);
      await refresh();
    },
    onError: (e) => setDialogError(errorText(e, t('errUpdate'))),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete<void>(`/diary/entries/${id}`),
    onSuccess: refresh,
    onError: (e) => setError(errorText(e, t('errRemove'))),
  });
  // Marking a meal of the plan as eaten rebalances its day, as on the plan's page, and says so with the same note.
  const eat = useMutation({
    mutationFn: ({ planId, meal }: { planId: string; meal: DiaryPlanMeal }) =>
      api.patch<RebalanceResult>(`/meal-plans/${planId}/meals/${meal.id}/eaten`, {
        eaten: !meal.eaten,
      }),
    onSuccess: async (result, { planId }) => {
      setToast(
        result.rebalance && result.rebalance.changes.length > 0
          ? { planId, rebalance: result.rebalance }
          : null,
      );
      await refresh();
    },
    onError: (e) => setError(errorText(e, t('errEaten'))),
  });
  const rebalance = useMutation({
    mutationFn: ({ planId, body }: { planId: string; body: RebalanceRequest }) =>
      api.post<RebalanceResult>(`/meal-plans/${planId}/rebalance`, body),
    onSuccess: async (result, { planId, body }) => {
      // An undo puts the portions back and has nothing more to say.
      setToast(
        !body.restore && result.rebalance && result.rebalance.changes.length > 0
          ? { planId, rebalance: result.rebalance }
          : null,
      );
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
      api.post<DiaryCopyResult>('/diary/copy', { profileId: active!.id, from, to: date }),
    onSuccess: async (result) => {
      setNotice(t('copied', { count: result.copied }));
      await refresh();
    },
    onError: (e) => setError(errorText(e, t('errCopy'))),
  });

  /** Another day, or another profile: what was said of the one before goes. */
  const leave = () => {
    setError(null);
    setNotice(null);
    setToast(null);
  };

  if (profiles.isLoading) return <Skeleton className="h-40 max-w-2xl" />;
  if (profiles.isError)
    return <LoadFailed error={profiles.error} onRetry={() => void profiles.refetch()} />;
  if (!active) {
    return (
      <Card className="max-w-2xl">
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
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <PageBanner image={IMAGERY.diary} title={t('title')} subtitle={t('subhead')} />

      {list.length > 1 && (
        <ProfilePicker
          profiles={list}
          active={active.id}
          onPick={(id) => {
            setPicked(id);
            leave();
          }}
        />
      )}

      <DayPicker
        date={date}
        today={today}
        onPick={(next) => {
          setDate(next);
          leave();
        }}
      />

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
      ) : day.isError ? (
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
              <EmptyState icon={NotebookPen} title={t('emptyTitle')} description={t('emptyText')} />
            )}
            {meals.map((slot) => (
              <MealSection
                key={slot}
                slot={slot}
                day={shown}
                canAdd={!ahead && !tooOld && !full}
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
                onRemove={(entry) => {
                  setError(null);
                  remove.mutate(entry.id);
                }}
              />
            ))}

            {!ahead && !tooOld && (
              <CopyDay
                key={date}
                date={date}
                today={today}
                busy={copy.isPending}
                onCopy={(from) => {
                  leave();
                  copy.mutate(from);
                }}
              />
            )}
          </>
        )
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
      {toast && (
        <RebalanceToast
          rebalance={toast.rebalance}
          busy={rebalance.isPending}
          onUndo={() =>
            rebalance.mutate({
              planId: toast.planId,
              body: {
                scope: 'day',
                restore: toast.rebalance.changes.map((change) => ({
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

function ProfilePicker({
  profiles,
  active,
  onPick,
}: {
  profiles: Profile[];
  active: string;
  onPick: (id: string) => void;
}) {
  const t = useTranslations('diary');
  const id = useId();
  return (
    <div className="max-w-xs">
      <label
        htmlFor={id}
        className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
      >
        {t('profileLabel')}
      </label>
      <select
        id={id}
        className={selectClass}
        value={active}
        onChange={(e) => onPick(e.target.value)}
      >
        {profiles.map((profile) => (
          <option key={profile.id} value={profile.id}>
            {profile.name}
          </option>
        ))}
      </select>
    </div>
  );
}

/** The day shown, the days on either side of it, and today. */
function DayPicker({
  date,
  today,
  onPick,
}: {
  date: string;
  today: string;
  onPick: (day: string) => void;
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
      <p className="w-full text-sm font-medium sm:w-auto sm:pb-2">{fmt.date(date)}</p>
    </div>
  );
}

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
  const id = useId();
  const share = day.target.calories > 0 ? Math.min(1, day.eaten.calories / day.target.calories) : 0;
  const plan = day.plan;
  // Where nothing is written, the plan's day stands as its own meals put it.
  const written = day.entries.length > 0;
  // A meal from a recipe that is not eaten yet is all a rebalance moves.
  const resizable = plan?.meals.some((meal) => !meal.eaten && meal.recipeId !== null) ?? false;
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
        <p className="text-sm text-muted-foreground">
          {t('eatenMacros', {
            protein: day.eaten.protein,
            proteinTarget: day.target.protein,
            fat: day.eaten.fat,
            fatTarget: day.target.fat,
            carbs: day.eaten.carbs,
            carbsTarget: day.target.carbs,
          })}
        </p>
        <p className="text-xs text-muted-foreground">
          {t(
            plan?.skipped
              ? 'targetFromSkipped'
              : day.target.from === 'plan'
                ? 'targetFromPlan'
                : 'targetFromProfile',
          )}
        </p>
        {day.estimated && <p className="text-xs text-muted-foreground">{t('estimatedNote')}</p>}

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
      </CardContent>
    </Card>
  );
}

/** A meal of the day: what its plan has for it, and what was written for it. */
function MealSection({
  slot,
  day,
  canAdd,
  busy,
  onAdd,
  onEat,
  onEdit,
  onRemove,
}: {
  slot: MealType;
  day: DiaryDay;
  canAdd: boolean;
  busy: boolean;
  onAdd: () => void;
  onEat: (meal: DiaryPlanMeal) => void;
  onEdit: (entry: DiaryEntry) => void;
  onRemove: (entry: DiaryEntry) => void;
}) {
  const t = useTranslations('diary');
  const tMeal = useTranslations('enums.mealType');
  const amount = useAmount();
  const unitName = useUnitName();
  const fmt = useFormat();
  const id = useId();
  // Weights and volumes as they were written, a part of a gram in the reader's own numbers; what is counted has its plurals.
  const written = ({ quantity, unit }: DisplayAmount): string =>
    unit === 'g' || unit === 'ml'
      ? `${fmt.number(quantity, 2)} ${unitName(unit)}`
      : amount(quantity, unit);
  const planned = day.plan?.meals.filter((meal) => meal.mealType === slot) ?? [];
  const entries = day.entries.filter((entry) => entry.mealType === slot);
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
                <p id={`${id}-${meal.id}`} className="text-sm font-medium">
                  {meal.name}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('fromPlan')} · {t('mealKcal', { kcal: meal.nutrition.calories })}
                </p>
              </div>
              <label className="flex min-h-6 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={meal.eaten}
                  disabled={busy}
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
                <p className="text-sm font-medium">{entry.name}</p>
                <p className="text-xs text-muted-foreground">
                  {entry.amount
                    ? written(entry.amount.shown)
                    : t('servingsShown', { count: shownServings(entry.servings) })}
                  {' · '}
                  {t('mealKcal', { kcal: entry.nutrition.calories })}
                  {' · '}
                  {t('entryMacros', entry.nutrition)}
                  {entry.estimated && (
                    <>
                      {' · '}
                      <span className="font-medium text-foreground">≈ {t('estimated')}</span>
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

/** Copy into the day shown what was eaten on another day before it or after it, up to today. */
function CopyDay({
  date,
  today,
  busy,
  onCopy,
}: {
  date: string;
  today: string;
  busy: boolean;
  onCopy: (from: string) => void;
}) {
  const t = useTranslations('diary');
  const fmt = useFormat();
  const id = useId();
  const [from, setFrom] = useState(() => dayAfter(date, -1));
  const itself = from === date;
  return (
    <Card>
      <CardHeader>
        <h2 className="text-base font-semibold tracking-tight">{t('copyTitle')}</h2>
        <p id={`${id}-note`} className="text-sm text-muted-foreground">
          {t('copyNote')}
        </p>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            // The browser holds the day to one there is, today or before it.
            if (isDay(from) && !itself) onCopy(from);
          }}
        >
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
          <Button
            type="submit"
            variant="outline"
            disabled={busy || itself}
            aria-describedby={itself ? `${id}-itself` : `${id}-note`}
          >
            {t('copyButton', { day: fmt.day(date) })}
          </Button>
          {itself && (
            <p id={`${id}-itself`} className="w-full text-xs text-muted-foreground">
              {t('copySameDay')}
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
