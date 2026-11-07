// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import type { HouseholdList, MealPlanPage, Profile } from '@diet-app/shared';
import { api } from '@/lib/api';
import { localDate } from '@/lib/http';
import { useAmount } from '@/lib/ingredient-format';
import { dayAfter } from '@/lib/plan-dates';
import { useErrorText } from '@/lib/use-error-text';
import { useFormat } from '@/lib/use-format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { ListView, type RowPatch } from './list-view';

const selectClass = 'h-10 w-full rounded-md border border-input bg-background px-3 text-sm';

/** What marks a change of a row of a household list among the requests on their way. */
const ROW_CHANGE = ['household-list-item'];

/** A tick and nothing with it: the one change of a row the page can show before the server has it. */
const plainTick = (patch: RowPatch): boolean | undefined =>
  Object.keys(patch).length === 1 ? patch.checked : undefined;

/** The household lists with one row ticked, or not. */
const withTick = (
  lists: HouseholdList[] | undefined,
  id: string,
  itemId: string,
  checked: boolean,
): HouseholdList[] | undefined =>
  lists?.map((list) =>
    list.id !== id
      ? list
      : {
          ...list,
          groups: list.groups.map((group) => ({
            ...group,
            items: group.items.map((item) => (item.id === itemId ? { ...item, checked } : item)),
          })),
        },
  );

/** The last day of a plan. */
const lastDay = (plan: MealPlanPage['items'][number]): string =>
  dayAfter(plan.startDate, plan.durationDays - 1);

/**
 * The household lists of the account: one list from the plans of several
 * profiles for the same days, each plan's own list a part of it. Made here
 * with the days and a plan of each profile; shown as one list whose rows say
 * what each profile needs of them.
 */
export function HouseholdLists({
  profiles,
  opened,
  onOpen,
}: {
  profiles: Profile[];
  /** The household list shown, if any. */
  opened: string | null;
  onOpen: (id: string | null) => void;
}) {
  const t = useTranslations('householdLists');
  const tLists = useTranslations('shoppingLists');
  const tCommon = useTranslations('common');
  const tDiet = useTranslations('enums.dietType');
  const tCategory = useTranslations('enums.category');
  const fmt = useFormat();
  const errorText = useErrorText();
  const formatItemQty = useAmount();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const [from, setFrom] = useState(localDate);
  const [to, setTo] = useState(() => dayAfter(localDate(), 6));
  /** The plan chosen of each profile: undefined until the user chooses, null for none. */
  const [chosen, setChosen] = useState<Record<string, string | null>>({});

  const households = useQuery({
    queryKey: ['household-lists'],
    queryFn: () => api.get<HouseholdList[]>('/household-lists'),
  });
  const all = households.data ?? [];
  const shown = all.find((list) => list.id === opened) ?? null;

  // The plans of every profile, as the page reads those of the one it shows.
  const plans = useQueries({
    queries: profiles.map((profile) => ({
      queryKey: ['meal-plans', profile.id],
      queryFn: () => api.get<MealPlanPage>(`/meal-plans?profileId=${profile.id}&pageSize=50`),
      enabled: making,
    })),
  });
  // Of each profile, the plans that have a day of the days: the one that begins last first, as the API gives them.
  const covering = profiles.map((profile, index) => ({
    profile,
    plans: (plans[index]?.data?.items ?? []).filter(
      (plan) => plan.startDate <= to && lastDay(plan) >= from,
    ),
  }));
  const choiceOf = (profileId: string, offered: MealPlanPage['items']): string | null => {
    const picked = chosen[profileId];
    if (picked === undefined) return offered[0]?.id ?? null;
    return picked !== null && offered.some((plan) => plan.id === picked) ? picked : null;
  };
  const planIds = covering.flatMap(({ profile, plans: offered }) => {
    const id = choiceOf(profile.id, offered);
    return id ? [id] : [];
  });

  /** What a household list changes besides itself: the plans' lists it replaced, the pantries, the days on a list. */
  const touched = (): void => {
    void qc.invalidateQueries({ queryKey: ['shopping-lists'] });
    void qc.invalidateQueries({ queryKey: ['inventory'] });
    void qc.invalidateQueries({ queryKey: ['meal-plans'] });
    void qc.invalidateQueries({ queryKey: ['meal-plan'] });
  };

  const make = useMutation({
    mutationFn: (body: { planIds: string[]; fromDate: string; toDate: string }) =>
      api.post<HouseholdList>('/household-lists', body),
    onMutate: () => setError(null),
    onSuccess: (list) => {
      qc.setQueryData<HouseholdList[]>(['household-lists'], (was) => [
        list,
        // The one it was made again from is replaced by it.
        ...(was ?? []).filter((other) => other.id !== list.id && other.id !== opened),
      ]);
      void qc.invalidateQueries({ queryKey: ['household-lists'] });
      touched();
      setMaking(false);
      onOpen(list.id);
    },
    onError: (err) => setError(errorText(err, t('errMake'))),
  });

  // Whether an answer to a change of a row was left unshown because a later change was on its way.
  const answersLeftOut = useRef(false);
  const update = useMutation({
    mutationKey: ROW_CHANGE,
    mutationFn: ({ id, itemId, ...patch }: { id: string; itemId: string } & RowPatch) =>
      api.patch<HouseholdList>(`/household-lists/${id}/items/${itemId}`, patch),
    // A tick is shown at once, as on a list of a plan: in a shop nobody waits for a connection.
    onMutate: async ({ id, itemId, ...patch }) => {
      setError(null);
      const tick = plainTick(patch);
      if (tick === undefined) return;
      await qc.cancelQueries({ queryKey: ['household-lists'] });
      qc.setQueryData<HouseholdList[]>(['household-lists'], (was) =>
        withTick(was, id, itemId, tick),
      );
    },
    onSuccess: (list) => {
      touched();
      if (qc.isMutating({ mutationKey: ROW_CHANGE }) > 1 || answersLeftOut.current) {
        answersLeftOut.current = true;
        return;
      }
      qc.setQueryData<HouseholdList[]>(['household-lists'], (was) =>
        was?.map((other) => (other.id === list.id ? list : other)),
      );
    },
    onError: (err, { id, itemId, ...patch }) => {
      const tick = plainTick(patch);
      if (tick !== undefined)
        qc.setQueryData<HouseholdList[]>(['household-lists'], (was) =>
          withTick(was, id, itemId, !tick),
        );
      setError(errorText(err, tLists('errUpdate')));
    },
    onSettled: () => {
      if (qc.isMutating({ mutationKey: ROW_CHANGE }) > 1 || !answersLeftOut.current) return;
      answersLeftOut.current = false;
      void qc.invalidateQueries({ queryKey: ['household-lists'] });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete<void>(`/household-lists/${id}`),
    onMutate: () => setError(null),
    onSuccess: (_answer, id) => {
      qc.setQueryData<HouseholdList[]>(['household-lists'], (was) =>
        was?.filter((list) => list.id !== id),
      );
      touched();
      onOpen(null);
    },
    onError: (err) => setError(errorText(err, t('errDelete'))),
  });

  const whom = (list: HouseholdList): string => fmt.list(list.parts.map((part) => part.profile));

  return (
    <section className="space-y-3">
      <Card>
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">{t('subhead')}</p>
          {all.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {all.map((list) => (
                <Button
                  key={list.id}
                  type="button"
                  size="sm"
                  variant={list.id === opened ? 'primary' : 'outline'}
                  aria-pressed={list.id === opened}
                  onClick={() => onOpen(list.id === opened ? null : list.id)}
                >
                  {t('pick', {
                    dates: fmt.dates(list.fromDate, list.toDate),
                    profiles: whom(list),
                  })}
                </Button>
              ))}
            </div>
          )}
          {!making ? (
            <Button type="button" variant="outline" onClick={() => setMaking(true)}>
              {t('open')}
            </Button>
          ) : (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (planIds.length >= 2) make.mutate({ planIds, fromDate: from, toDate: to });
              }}
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={tLists('fromDate')}>
                  <Input
                    type="date"
                    value={from}
                    required
                    onChange={(event) => setFrom(event.target.value)}
                  />
                </Field>
                <Field label={tLists('toDate')}>
                  <Input
                    type="date"
                    value={to}
                    min={from}
                    required
                    onChange={(event) => setTo(event.target.value)}
                  />
                </Field>
              </div>
              <fieldset className="space-y-3">
                <legend className="text-sm font-medium">{t('plans')}</legend>
                {covering.map(({ profile, plans: offered }) => {
                  const id = choiceOf(profile.id, offered);
                  const loading = plans[profiles.indexOf(profile)]?.isLoading ?? false;
                  return (
                    <div
                      key={profile.id}
                      className="grid items-center gap-2 sm:grid-cols-[12rem_1fr]"
                    >
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="h-4 w-4"
                          checked={id !== null}
                          disabled={offered.length === 0}
                          onChange={(event) =>
                            setChosen((was) => ({
                              ...was,
                              [profile.id]: event.target.checked ? (offered[0]?.id ?? null) : null,
                            }))
                          }
                        />
                        {profile.name}
                      </label>
                      {offered.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          {loading ? tCommon('loading') : t('noPlan')}
                        </p>
                      ) : (
                        <select
                          className={selectClass}
                          aria-label={t('planOf', { profile: profile.name })}
                          value={id ?? offered[0]!.id}
                          disabled={id === null}
                          onChange={(event) =>
                            setChosen((was) => ({ ...was, [profile.id]: event.target.value }))
                          }
                        >
                          {offered.map((plan) => (
                            <option key={plan.id} value={plan.id}>
                              {tLists('planOption', {
                                date: fmt.date(plan.startDate),
                                days: plan.durationDays,
                                dietType: tDiet(plan.dietType),
                              })}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  );
                })}
              </fieldset>
              <p className="text-sm text-muted-foreground">{t('replaces')}</p>
              {planIds.length < 2 && (
                <p className="text-sm text-muted-foreground">{t('atLeastTwo')}</p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={planIds.length < 2 || make.isPending}>
                  {make.isPending ? tLists('generating') : t('make')}
                </Button>
                <Button type="button" variant="ghost" onClick={() => setMaking(false)}>
                  {tCommon('cancel')}
                </Button>
              </div>
            </form>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </CardContent>
      </Card>
      {shown && (
        <ListView
          profileId={null}
          aiEnabled={false}
          aiOffNote={undefined}
          list={shown}
          proposalsOf={null}
          forWhom={t('forWhom', { profiles: whom(shown) })}
          packsHint={t('packsHint')}
          busy={update.isPending || remove.isPending || make.isPending}
          locked={remove.isPending || make.isPending}
          formatQty={formatItemQty}
          categoryLabel={(c) => (tCategory.has(c) ? tCategory(c) : c)}
          summaryLabel={(checked, total, kcal) => tLists('summary', { checked, total, kcal })}
          boughtLabel={tLists('bought')}
          ofLabel={(amount) => tLists('ofTotal', { amount })}
          deleteLabel={tCommon('delete')}
          deleteConfirm={t('deleteConfirm')}
          printNotebookLabel={tLists('printNotebook')}
          printPdfLabel={tLists('printPdf')}
          printGeneratingPdfLabel={tLists('printGeneratingPdf')}
          printPdfErrorLabel={tLists('printPdfError')}
          notesLabel={tLists('notes')}
          foldHereLabel={tLists('foldHere')}
          appName="Diet App"
          planTitle={t('pdfTitle', { profiles: whom(shown) })}
          haveLabel={tLists('haveShort')}
          staleLabel={t('stale')}
          staleUpdateLabel={tLists('staleUpdate')}
          staleUpdateHint={tLists('staleUpdateHint')}
          onPatch={(item, patch) => update.mutate({ id: shown.id, itemId: item.id, ...patch })}
          onDelete={() => remove.mutate(shown.id)}
          // Made again with the same plans and days: it replaces this one, and counts what was obtained for it.
          onUpdate={() =>
            make.mutate({
              planIds: shown.parts.map((part) => part.planId),
              fromDate: shown.fromDate,
              toDate: shown.toDate,
            })
          }
        />
      )}
    </section>
  );
}
