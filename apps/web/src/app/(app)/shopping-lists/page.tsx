// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';
import { ChevronRight, ShoppingBasket } from 'lucide-react';
import type { MealPlanPage, Profile, SessionUser, ShoppingList } from '@diet-app/shared';
import { api } from '@/lib/api';
import { useAmount } from '@/lib/ingredient-format';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/empty-state';
import { PageBanner } from '@/components/page-banner';
import { ProfileChips } from '@/components/profile-chips';
import { IMAGERY } from '@/lib/imagery';
import { useErrorText } from '@/lib/use-error-text';
import { Field, Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useFormat } from '@/lib/use-format';
import { LoadFailed, ReadsFailed, unread } from '@/components/load-failed';
import { cn } from '@/lib/utils';
import { ListView, type RowPatch } from './list-view';

export const selectClass = 'h-10 w-full rounded-md border border-input bg-background px-3 text-sm';

/** Fetched where the account has two profiles or more, the only accounts that are shown it. */
const HouseholdLists = dynamic(
  () => import('./household-lists').then((section) => section.HouseholdLists),
  { ssr: false, loading: () => <Skeleton className="h-16" /> },
);

/** Where the household lists are on the page, which a part of one leads to. */
const HOUSEHOLD_LISTS = 'household-lists';

/** What marks a change of a row among the requests on their way. */
const ROW_CHANGE = ['shopping-list-item'];

/** A tick and nothing with it: the one change of a row the page can show before the server has it. */
const plainTick = (patch: RowPatch): boolean | undefined =>
  Object.keys(patch).length === 1 ? patch.checked : undefined;

/** The lists with one entry ticked, or not. */
const withTick = (
  lists: ShoppingList[] | undefined,
  listId: string,
  itemId: string,
  checked: boolean,
): ShoppingList[] | undefined =>
  lists?.map((list) =>
    list.id !== listId
      ? list
      : {
          ...list,
          groups: list.groups.map((group) => ({
            ...group,
            items: group.items.map((item) => (item.id === itemId ? { ...item, checked } : item)),
          })),
        },
  );

/**
 * Shopping-list page — pick a profile + a plan, generate a list for any range
 * within that plan, then tick items off as you shop. Lists persist so coming
 * back later restores the same checkboxes.
 */
export default function ShoppingListsPage() {
  const t = useTranslations('shoppingLists');
  const tCommon = useTranslations('common');
  const tDiet = useTranslations('enums.dietType');
  const tCategory = useTranslations('enums.category');
  const errorText = useErrorText();
  const fmt = useFormat();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [pickedProfile, setPickedProfile] = useState<string | null>(null);
  const [pickedPlan, setPickedPlan] = useState<string | null>(null);
  const [pickedList, setPickedList] = useState<string | null>(null);
  const [openHousehold, setOpenHousehold] = useState<string | null>(null);
  // The household lists fold under the plan's list, and open where a part of one leads to them.
  const [householdOpen, setHouseholdOpen] = useState(false);
  // The form a list is made with folds under the list, open while the plan has none: undefined until the user says.
  const [makingAsked, setMakingAsked] = useState<boolean | null>(null);
  // What went wrong with a list made by the form, said in the form.
  const [formError, setFormError] = useState<string | null>(null);
  // Where the plan's list is: the page goes there once a list is made.
  const listShown = useRef<HTMLElement>(null);
  /** The days the form names, as they are typed: the plan's own until then. */
  const [range, setRange] = useState<{ fromDate?: string; toDate?: string }>({});

  const profiles = useQuery({
    queryKey: ['profiles'],
    queryFn: () => api.get<Profile[]>('/profiles'),
  });
  const profileList = profiles.data ?? [];
  const activeProfileId = pickedProfile ?? profileList[0]?.id ?? null;
  // Whether the account has a model to ask. Without one, what asks a model stays where it is, disabled, and one line says why.
  const session = useQuery({
    queryKey: ['session'],
    queryFn: () => api.get<SessionUser>('/users/me'),
  });
  const aiEnabled = Boolean(session.data?.aiMode && session.data.aiMode !== 'none');
  const aiOffNote = useId();
  // The form a list is made with, so that a button elsewhere on the page can send it.
  const makeList = useId();

  const plans = useQuery({
    queryKey: ['meal-plans', activeProfileId],
    queryFn: () => api.get<MealPlanPage>(`/meal-plans?profileId=${activeProfileId}&pageSize=50`),
    enabled: Boolean(activeProfileId),
  });
  const planList = plans.data?.items ?? [];
  const activePlanId = pickedPlan ?? planList[0]?.id ?? null;
  const activePlan = planList.find((p) => p.id === activePlanId) ?? null;

  const lists = useQuery({
    queryKey: ['shopping-lists', activePlanId],
    queryFn: () => api.get<ShoppingList[]>(`/shopping-lists?planId=${activePlanId}`),
    enabled: Boolean(activePlanId),
  });
  const listOptions = lists.data ?? [];
  const activeListId =
    (pickedList && listOptions.some((l) => l.id === pickedList) ? pickedList : null) ??
    listOptions[0]?.id ??
    null;
  const activeList = listOptions.find((l) => l.id === activeListId) ?? null;
  const makingOpen = makingAsked ?? (lists.isSuccess && listOptions.length === 0);
  const planEnd = activePlan
    ? new Date(
        new Date(activePlan.startDate).getTime() +
          (activePlan.durationDays - 1) * 24 * 60 * 60 * 1000,
      )
        .toISOString()
        .slice(0, 10)
    : '';
  const formFrom = range.fromDate || activePlan?.startDate || '';
  const formTo = range.toDate || planEnd;
  // A list of the days the form names that is a part of a household list: a new list takes its place there.
  const replacedPart = listOptions.find(
    (l) => l.household && l.fromDate <= formTo && l.toDate >= formFrom,
  )?.household;

  const generate = useMutation({
    mutationFn: (body: { planId: string; fromDate?: string; toDate?: string }) =>
      api.post<ShoppingList>('/shopping-lists/generate', body),
    onSuccess: (list) => {
      // Generation may auto-check rows fully covered by pantry, decrementing
      // inventory as a side-effect. Force the inventory page to refetch.
      void qc.invalidateQueries({ queryKey: ['inventory'] });
      // It may have replaced a part of a household list.
      void qc.invalidateQueries({ queryKey: ['household-lists'] });
      setPickedList(list.id);
      // Done once the plan's lists are read again with it: what was asked for it then finds it on the page.
      return qc.invalidateQueries({ queryKey: ['shopping-lists', activePlanId] });
    },
  });

  // Whether an answer to a change of a row was left unshown because a later change was on its way.
  const answersLeftOut = useRef(false);
  const updateItem = useMutation({
    mutationKey: ROW_CHANGE,
    // What a row sends is what changed of it, and nothing else.
    mutationFn: ({ listId, itemId, ...patch }: { listId: string; itemId: string } & RowPatch) =>
      api.patch<ShoppingList>(`/shopping-lists/${listId}/items/${itemId}`, patch),
    // A tick is shown at once: in a shop nobody waits for a connection between
    // two entries. What else it changes of the row (the pantry, the packs) is
    // the server's to work out, and comes with its answer.
    onMutate: async ({ listId, itemId, ...patch }) => {
      const tick = plainTick(patch);
      if (tick === undefined) return;
      // A list that is being read again would put the row back as it was.
      await qc.cancelQueries({ queryKey: ['shopping-lists', activePlanId] });
      qc.setQueryData<ShoppingList[]>(['shopping-lists', activePlanId], (shown) =>
        withTick(shown, listId, itemId, tick),
      );
    },
    // The answer is the list as the server has it (a row ticked by itself,
    // the totals): shown without another request. The pantry may have changed
    // with it, so what the inventory page holds is read again.
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: ['inventory'] });
      if (updated.household) qc.invalidateQueries({ queryKey: ['household-lists'] });
      // An answer does not know of the changes made after its request was sent: while one of those is on
      // its way it is not shown, and neither is the last of them, which may have been made before an
      // earlier one reached the server. The list is then read once, when all are through.
      if (qc.isMutating({ mutationKey: ROW_CHANGE }) > 1 || answersLeftOut.current) {
        answersLeftOut.current = true;
        return;
      }
      qc.setQueryData<ShoppingList[]>(
        ['shopping-lists', activePlanId],
        (prev) => prev?.map((l) => (l.id === updated.id ? updated : l)) ?? [updated],
      );
    },
    onError: (e, { listId, itemId, ...patch }) => {
      const tick = plainTick(patch);
      // The tick did not hold: the row is shown as the server has it.
      if (tick !== undefined)
        qc.setQueryData<ShoppingList[]>(['shopping-lists', activePlanId], (shown) =>
          withTick(shown, listId, itemId, !tick),
        );
      setError(errorText(e, t('errUpdate')));
    },
    // Once the last change is through, a list of which an answer was left out is read from the server.
    onSettled: () => {
      if (qc.isMutating({ mutationKey: ROW_CHANGE }) > 1 || !answersLeftOut.current) return;
      answersLeftOut.current = false;
      void qc.invalidateQueries({ queryKey: ['shopping-lists', activePlanId] });
    },
  });

  const remove = useMutation({
    mutationFn: (listId: string) => api.delete<void>(`/shopping-lists/${listId}`),
    onSuccess: () => {
      setPickedList(null);
      qc.invalidateQueries({ queryKey: ['shopping-lists', activePlanId] });
      qc.invalidateQueries({ queryKey: ['inventory'] });
      qc.invalidateQueries({ queryKey: ['household-lists'] });
    },
    onError: (e) => setError(errorText(e, t('errDelete'))),
  });

  function onGenerate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    if (!activePlanId) return;
    const f = new FormData(event.currentTarget);
    const fromDate = String(f.get('fromDate') ?? '');
    const toDate = String(f.get('toDate') ?? '');
    generate.mutate(
      {
        planId: activePlanId,
        ...(fromDate ? { fromDate } : {}),
        ...(toDate ? { toDate } : {}),
      },
      {
        // The form has done its part and folds; the page goes to the new list, above it.
        onSuccess: () => {
          setMakingAsked(false);
          requestAnimationFrame(() => {
            listShown.current?.focus({ preventScroll: true });
            listShown.current?.scrollIntoView({ block: 'start' });
          });
        },
        // Said in the form, which opens for it: the button of an empty list sends it folded too.
        onError: (e) => {
          setMakingAsked(true);
          setFormError(errorText(e, t('errGenerate')));
        },
      },
    );
  }

  // The API has rounded every quantity and named its unit; this spells it.
  const formatItemQty = useAmount();

  if (profiles.isLoading) return <Skeleton className="h-40" />;
  if (unread(profiles))
    return <LoadFailed error={profiles.error} onRetry={() => void profiles.refetch()} />;

  if (profileList.length === 0) {
    return (
      <div className="mt-16">
        <EmptyState
          icon={ShoppingBasket}
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
      <PageBanner image={IMAGERY.shopping} title={t('title')} subtitle={t('subhead')} />
      <ReadsFailed reads={[profiles, plans, lists]} />

      <ProfileChips
        profiles={profileList}
        active={activeProfileId}
        onPick={(id) => {
          setPickedProfile(id);
          setPickedPlan(null);
          setPickedList(null);
          setError(null);
          setFormError(null);
          setMakingAsked(null);
        }}
      />

      {plans.isLoading ? (
        <Skeleton className="h-24" />
      ) : unread(plans) ? (
        <LoadFailed error={plans.error} onRetry={() => void plans.refetch()} />
      ) : planList.length === 0 ? (
        // A list is made from a plan: without one there is nothing to make it from, and the way on is the plan page.
        <EmptyState
          icon={ShoppingBasket}
          title={t('noPlansTitle')}
          description={t('noPlans')}
          cta={
            <Link href="/meal-plans" className={buttonVariants({ size: 'md' })}>
              {t('noPlansCta')}
            </Link>
          }
        />
      ) : (
        // The plan whose lists are shown, and which a new list is made from.
        <div className="max-w-md">
          <Field label={t('plan')}>
            <select
              className={selectClass}
              value={activePlanId ?? ''}
              onChange={(e) => {
                setPickedPlan(e.target.value);
                setPickedList(null);
                setRange({});
                setFormError(null);
                setMakingAsked(null);
              }}
            >
              {planList.map((p) => (
                <option key={p.id} value={p.id}>
                  {t('planOption', {
                    date: fmt.date(p.startDate),
                    days: p.durationDays,
                    dietType: tDiet(p.dietType),
                  })}
                </option>
              ))}
            </select>
          </Field>
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      {lists.isLoading ? (
        <Skeleton className="h-24" />
      ) : unread(lists) ? (
        <LoadFailed error={lists.error} onRetry={() => void lists.refetch()} />
      ) : listOptions.length === 0 ? (
        planList.length > 0 && (
          <EmptyState
            icon={ShoppingBasket}
            title={t('noListsTitle')}
            description={t('noLists')}
            cta={
              // The form under it, with the plan and the days it names.
              <Button type="submit" form={makeList} disabled={generate.isPending || !activePlanId}>
                {generate.isPending ? t('generating') : t('noListsCta')}
              </Button>
            }
          />
        )
      ) : (
        <section ref={listShown} tabIndex={-1} className="scroll-mt-4 space-y-3 outline-none">
          {listOptions.length > 1 && (
            <div className="flex flex-wrap gap-2">
              {listOptions.map((l) => (
                <Button
                  key={l.id}
                  type="button"
                  size="sm"
                  variant={l.id === activeListId ? 'primary' : 'outline'}
                  onClick={() => setPickedList(l.id)}
                >
                  {fmt.dates(l.fromDate, l.toDate)}
                </Button>
              ))}
            </div>
          )}
          {activeList?.household && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
              <p>{t('partOf', { profiles: fmt.list(activeList.household.profiles) })}</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setHouseholdOpen(true);
                  setOpenHousehold(activeList.household!.id);
                  // The household lists are under this one: the page goes to them once they are open.
                  requestAnimationFrame(() =>
                    document.getElementById(HOUSEHOLD_LISTS)?.scrollIntoView({ block: 'start' }),
                  );
                }}
              >
                {t('openHousehold')}
              </Button>
            </div>
          )}
          {activeList && (
            <ListView
              // Each list begins with nothing looked for and nothing open.
              key={activeList.id}
              profileId={activeProfileId}
              aiEnabled={aiEnabled}
              aiOffNote={session.data && !aiEnabled ? aiOffNote : undefined}
              list={activeList}
              proposalsOf={activeList}
              busy={updateItem.isPending || remove.isPending || generate.isPending}
              locked={remove.isPending || generate.isPending}
              formatQty={formatItemQty}
              categoryLabel={(c) => (tCategory.has(c) ? tCategory(c) : c)}
              summaryLabel={(checked, total, kcal) => t('summary', { checked, total, kcal })}
              boughtLabel={t('bought')}
              ofLabel={(amount) => t('ofTotal', { amount })}
              deleteLabel={tCommon('delete')}
              deleteConfirm={t('deleteConfirm')}
              printNotebookLabel={t('printNotebook')}
              printPdfLabel={t('printPdf')}
              printGeneratingPdfLabel={t('printGeneratingPdf')}
              printPdfErrorLabel={t('printPdfError')}
              notesLabel={t('notes')}
              foldHereLabel={t('foldHere')}
              appName="Diet App"
              planTitle={
                activePlan
                  ? t('planOption', {
                      date: fmt.date(activePlan.startDate),
                      days: activePlan.durationDays,
                      dietType: tDiet(activePlan.dietType),
                    })
                  : ''
              }
              haveLabel={t('haveShort')}
              staleLabel={t('stale')}
              staleUpdateLabel={t('staleUpdate')}
              staleUpdateHint={t('staleUpdateHint')}
              onPatch={(item, patch) =>
                updateItem.mutate({ listId: activeList.id, itemId: item.id, ...patch })
              }
              onDelete={remove.mutate}
              // A list for the same dates replaces this one, and counts what was obtained for it.
              onUpdate={() => {
                setError(null);
                generate.mutate(
                  {
                    planId: activeList.planId,
                    fromDate: activeList.fromDate,
                    toDate: activeList.toDate,
                  },
                  { onError: (e) => setError(errorText(e, t('errGenerate'))) },
                );
              }}
            />
          )}
        </section>
      )}

      {/* A list for other days of the plan, folded under the list: the list is what the page is for. */}
      {planList.length > 0 && (
        <Card>
          <CardHeader className="p-0">
            <CardTitle>
              <button
                type="button"
                aria-expanded={makingOpen}
                onClick={() => setMakingAsked(!makingOpen)}
                className={cn('flex w-full items-center gap-2 p-5 text-left', makingOpen && 'pb-3')}
              >
                <ChevronRight
                  size={16}
                  aria-hidden
                  className={cn('shrink-0 text-muted-foreground', makingOpen && 'rotate-90')}
                />
                {t('generate')}
              </button>
            </CardTitle>
          </CardHeader>
          {/* Hidden, not taken away: the button of a plan without a list sends this form. */}
          <CardContent hidden={!makingOpen}>
            <form id={makeList} onSubmit={onGenerate} className="grid gap-4 sm:grid-cols-3">
              <Field label={t('fromDate')} optional>
                <Input
                  name="fromDate"
                  type="date"
                  defaultValue={activePlan?.startDate ?? ''}
                  onChange={(e) => setRange((was) => ({ ...was, fromDate: e.target.value }))}
                />
              </Field>
              <Field label={t('toDate')} optional>
                <Input
                  name="toDate"
                  type="date"
                  defaultValue={planEnd}
                  onChange={(e) => setRange((was) => ({ ...was, toDate: e.target.value }))}
                />
              </Field>
              <div className="flex items-end">
                <Button type="submit" disabled={generate.isPending || !activePlanId}>
                  {generate.isPending ? t('generating') : t('generateButton')}
                </Button>
              </div>
              {replacedPart && (
                <p className="text-sm text-muted-foreground sm:col-span-3">
                  {t('replacesPart', { profiles: fmt.list(replacedPart.profiles) })}
                </p>
              )}
              {formError && (
                <p role="alert" className="text-sm text-destructive sm:col-span-3">
                  {formError}
                </p>
              )}
            </form>
          </CardContent>
        </Card>
      )}

      {profileList.length > 1 && (
        <div id={HOUSEHOLD_LISTS} className="scroll-mt-4">
          <HouseholdLists
            profiles={profileList}
            open={householdOpen}
            onFold={setHouseholdOpen}
            opened={openHousehold}
            onOpen={setOpenHousehold}
          />
        </div>
      )}
    </div>
  );
}
