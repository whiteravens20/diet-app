// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { ShoppingBasket } from 'lucide-react';
import type { MealPlanPage, Profile, SessionUser, ShoppingList } from '@diet-app/shared';
import { api } from '@/lib/api';
import { ApiClientError } from '@/lib/http';
import { offline } from '@/lib/offline';
import { useAmount } from '@/lib/ingredient-format';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/empty-state';
import { PageBanner } from '@/components/page-banner';
import { IMAGERY } from '@/lib/imagery';
import { useErrorText } from '@/lib/use-error-text';
import { Field, Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useFormat } from '@/lib/use-format';
import { LoadFailed } from '@/components/load-failed';
import { ListView, type RowPatch } from './list-view';

export const selectClass = 'h-10 w-full rounded-md border border-input bg-background px-3 text-sm';

/**
 * Shopping-list page — pick a profile + a plan, generate a list for any range
 * within that plan, then tick items off as you shop. Lists persist so coming
 * back later restores the same checkboxes.
 */
export default function ShoppingListsPage() {
  const t = useTranslations('shoppingLists');
  const tCommon = useTranslations('common');
  const tOffline = useTranslations('offline');
  const tDiet = useTranslations('enums.dietType');
  const tCategory = useTranslations('enums.category');
  const errorText = useErrorText();
  const fmt = useFormat();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [pickedProfile, setPickedProfile] = useState<string | null>(null);
  const [pickedPlan, setPickedPlan] = useState<string | null>(null);
  const [pickedList, setPickedList] = useState<string | null>(null);

  const profiles = useQuery({ queryKey: ['profiles'], queryFn: () => api.get<Profile[]>('/profiles') });
  const profileList = profiles.data ?? [];
  const activeProfileId = pickedProfile ?? profileList[0]?.id ?? null;
  // Whether the account has a model to ask. Without one, what asks a model stays where it is, disabled, and one line says why.
  const session = useQuery({ queryKey: ['session'], queryFn: () => api.get<SessionUser>('/users/me') });
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

  const generate = useMutation({
    mutationFn: (body: { planId: string; fromDate?: string; toDate?: string }) =>
      api.post<ShoppingList>('/shopping-lists/generate', body),
    onSuccess: (list) => {
      qc.invalidateQueries({ queryKey: ['shopping-lists', activePlanId] });
      // Generation may auto-check rows fully covered by pantry, decrementing
      // inventory as a side-effect. Force the inventory page to refetch.
      qc.invalidateQueries({ queryKey: ['inventory'] });
      setPickedList(list.id);
    },
    onError: (e) =>
      setError(errorText(e, t('errGenerate'))),
  });

  const updateItem = useMutation({
    // What a row sends is what changed of it, and nothing else.
    mutationFn: ({ listId, itemId, ...patch }: { listId: string; itemId: string } & RowPatch) => api.patch<ShoppingList>(`/shopping-lists/${listId}/items/${itemId}`, patch),
    // Update the cache synchronously from the response so the row reflects the
    // server-derived state (auto-check, recomputed totals) without waiting on
    // a refetch round-trip. Pantry inventory may have changed too — invalidate
    // it so the inventory page reflects the consumption / leftover.
    onSuccess: (updated) => {
      qc.setQueryData<ShoppingList[]>(['shopping-lists', activePlanId], (prev) =>
        prev?.map((l) => (l.id === updated.id ? updated : l)) ?? [updated],
      );
      qc.invalidateQueries({ queryKey: ['inventory'] });
    },
    onError: (e, { listId, itemId, ...patch }) => {
      if (e instanceof ApiClientError && e.code === 'NETWORK') {
        // The server cannot be reached. A tick waits for it (`lib/offline.ts`) and the row shows it at once, on
        // this page and on the one loaded next; what a quantity does to a row is the server's to work out.
        const tick = Object.keys(patch).length === 1 ? patch.checked : undefined;
        if (tick === undefined) return setError(tOffline('onlyTicks'));
        if (offline.wait({ listId, itemId, checked: tick })) {
          const withTick = (lists: ShoppingList[] | undefined): ShoppingList[] | undefined =>
            lists?.map((list) =>
              list.id !== listId ? list : { ...list, groups: list.groups.map((group) => ({ ...group, items: group.items.map((item) => (item.id === itemId ? { ...item, checked: tick } : item)) })) },
            );
          const shown = withTick(qc.getQueryData<ShoppingList[]>(['shopping-lists', activePlanId]));
          if (shown) {
            qc.setQueryData(['shopping-lists', activePlanId], shown);
            void offline.remember(`/shopping-lists?planId=${activePlanId}`, shown);
          }
          return setError(null);
        }
      }
      setError(errorText(e, t('errUpdate')));
    },
  });

  const remove = useMutation({
    mutationFn: (listId: string) => api.delete<void>(`/shopping-lists/${listId}`),
    onSuccess: () => {
      setPickedList(null);
      qc.invalidateQueries({ queryKey: ['shopping-lists', activePlanId] });
      qc.invalidateQueries({ queryKey: ['inventory'] });
    },
    onError: (e) =>
      setError(errorText(e, t('errDelete'))),
  });

  function onGenerate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!activePlanId) return;
    const f = new FormData(event.currentTarget);
    const fromDate = String(f.get('fromDate') ?? '');
    const toDate = String(f.get('toDate') ?? '');
    generate.mutate({
      planId: activePlanId,
      ...(fromDate ? { fromDate } : {}),
      ...(toDate ? { toDate } : {}),
    });
  }

  // The API has rounded every quantity and named its unit; this spells it.
  const formatItemQty = useAmount();

  if (profiles.isLoading) return <Skeleton className="h-40 max-w-2xl" />;
  if (profiles.isError) return <LoadFailed error={profiles.error} onRetry={() => void profiles.refetch()} />;

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

      {profileList.length > 1 && (
        <div className="flex gap-2">
          {profileList.map((p) => (
            <Button
              key={p.id}
              type="button"
              variant={p.id === activeProfileId ? 'primary' : 'outline'}
              size="sm"
              onClick={() => {
                setPickedProfile(p.id);
                setPickedPlan(null);
                setPickedList(null);
                setError(null);
              }}
            >
              {p.name}
            </Button>
          ))}
        </div>
      )}

      {plans.isLoading ? (
        <Skeleton className="h-24 max-w-3xl" />
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
        <Card className="max-w-3xl">
          <CardHeader>
            <CardTitle>{t('generate')}</CardTitle>
          </CardHeader>
          <CardContent>
            <form id={makeList} onSubmit={onGenerate} className="grid gap-4 sm:grid-cols-4">
              <Field label={t('plan')}>
                <select
                  className={selectClass}
                  value={activePlanId ?? ''}
                  onChange={(e) => {
                    setPickedPlan(e.target.value);
                    setPickedList(null);
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
              <Field label={t('fromDate')}>
                <Input name="fromDate" type="date" defaultValue={activePlan?.startDate ?? ''} />
              </Field>
              <Field label={t('toDate')}>
                <Input
                  name="toDate"
                  type="date"
                  defaultValue={
                    activePlan
                      ? new Date(
                          new Date(activePlan.startDate).getTime() +
                            (activePlan.durationDays - 1) * 24 * 60 * 60 * 1000,
                        )
                          .toISOString()
                          .slice(0, 10)
                      : ''
                  }
                />
              </Field>
              <div className="flex items-end">
                <Button type="submit" disabled={generate.isPending || !activePlanId}>
                  {generate.isPending ? t('generating') : t('generateButton')}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {error && <p className="max-w-3xl text-sm text-destructive">{error}</p>}

      {lists.isLoading ? (
        <Skeleton className="h-24 max-w-3xl" />
      ) : listOptions.length === 0 ? (
        planList.length > 0 && (
          <EmptyState
            icon={ShoppingBasket}
            title={t('noListsTitle')}
            description={t('noLists')}
            cta={
              // The form above, with the plan and the days it names.
              <Button type="submit" form={makeList} disabled={generate.isPending || !activePlanId}>
                {generate.isPending ? t('generating') : t('noListsCta')}
              </Button>
            }
          />
        )
      ) : (
        <section className="space-y-3">
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
          {activeList && (
            <ListView
              profileId={activeProfileId}
              aiEnabled={aiEnabled}
              aiOffNote={session.data && !aiEnabled ? aiOffNote : undefined}
              list={activeList}
              busy={updateItem.isPending || remove.isPending || generate.isPending}
              formatQty={formatItemQty}
              categoryLabel={(c) => (tCategory.has(c) ? tCategory(c) : c)}
              summaryLabel={(checked, total, kcal) =>
                t('summary', { checked, total, kcal })
              }
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
              onUpdate={(list) =>
                generate.mutate({ planId: list.planId, fromDate: list.fromDate, toDate: list.toDate })
              }
            />
          )}
        </section>
      )}
    </div>
  );
}
