'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import type { MealPlan, Profile, ShoppingList, ShoppingListItem } from '@diet-app/shared';
import { api, ApiClientError } from '@/lib/api';
import { roundKitchenAmount } from '@/lib/ingredient-format';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

const selectClass = 'h-10 w-full rounded-md border border-border bg-background px-3 text-sm';

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
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [pickedProfile, setPickedProfile] = useState<string | null>(null);
  const [pickedPlan, setPickedPlan] = useState<string | null>(null);
  const [pickedList, setPickedList] = useState<string | null>(null);

  const profiles = useQuery({ queryKey: ['profiles'], queryFn: () => api.get<Profile[]>('/profiles') });
  const profileList = profiles.data ?? [];
  const activeProfileId = pickedProfile ?? profileList[0]?.id ?? null;

  const plans = useQuery({
    queryKey: ['meal-plans', activeProfileId],
    queryFn: () => api.get<MealPlan[]>(`/meal-plans?profileId=${activeProfileId}`),
    enabled: Boolean(activeProfileId),
  });
  const planList = plans.data ?? [];
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
      setPickedList(list.id);
    },
    onError: (e) =>
      setError(e instanceof ApiClientError ? e.message : t('errGenerate')),
  });

  const updateItem = useMutation({
    mutationFn: (v: {
      listId: string;
      itemId: string;
      alreadyHaveQuantity?: number;
      checked?: boolean;
    }) =>
      api.patch<ShoppingList>(`/shopping-lists/${v.listId}/items/${v.itemId}`, {
        ...(v.alreadyHaveQuantity !== undefined
          ? { alreadyHaveQuantity: v.alreadyHaveQuantity }
          : {}),
        ...(v.checked !== undefined ? { checked: v.checked } : {}),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['shopping-lists', activePlanId] }),
    onError: (e) =>
      setError(e instanceof ApiClientError ? e.message : t('errUpdate')),
  });

  const remove = useMutation({
    mutationFn: (listId: string) => api.delete<void>(`/shopping-lists/${listId}`),
    onSuccess: () => {
      setPickedList(null);
      qc.invalidateQueries({ queryKey: ['shopping-lists', activePlanId] });
    },
    onError: (e) =>
      setError(e instanceof ApiClientError ? e.message : t('errDelete')),
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

  /** Pretty-print a unit value: "240 g" / "1.5 pieces" — locale-aware. */
  function formatItemQty(qty: number, unit: string): string {
    const rounded = unit === 'piece' ? Math.round(qty * 4) / 4 : roundKitchenAmount(qty);
    if (unit === 'piece') return t('piecePlural', { count: rounded });
    return `${rounded} ${unit}`;
  }

  if (profiles.isLoading) return <Skeleton className="h-40 max-w-2xl" />;

  if (profileList.length === 0) {
    return (
      <Card className="mx-auto mt-20 max-w-md text-center">
        <CardHeader>
          <CardTitle>{t('noProfile')}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{t('noProfileBody')}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-8">
      <header data-print-hide>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subhead')}</p>
      </header>

      {profileList.length > 1 && (
        <div className="flex gap-2" data-print-hide>
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

      <Card className="max-w-3xl" data-print-hide>
        <CardHeader>
          <CardTitle>{t('generate')}</CardTitle>
        </CardHeader>
        <CardContent>
          {planList.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('noPlans')}</p>
          ) : (
            <form onSubmit={onGenerate} className="grid gap-4 sm:grid-cols-4">
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
                        date: p.startDate,
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
          )}
        </CardContent>
      </Card>

      {error && <p className="max-w-3xl text-sm text-destructive" data-print-hide>{error}</p>}

      {lists.isLoading ? (
        <Skeleton className="h-24 max-w-3xl" />
      ) : listOptions.length === 0 ? (
        planList.length > 0 && (
          <p className="max-w-3xl text-sm text-muted-foreground" data-print-hide>{t('noLists')}</p>
        )
      ) : (
        <section className="space-y-3">
          {listOptions.length > 1 && (
            <div className="flex flex-wrap gap-2" data-print-hide>
              {listOptions.map((l) => (
                <Button
                  key={l.id}
                  type="button"
                  size="sm"
                  variant={l.id === activeListId ? 'primary' : 'outline'}
                  onClick={() => setPickedList(l.id)}
                >
                  {l.fromDate} → {l.toDate}
                </Button>
              ))}
            </div>
          )}
          {activeList && (
            <ListView
              list={activeList}
              busy={updateItem.isPending || remove.isPending}
              formatQty={formatItemQty}
              categoryLabel={(c) => (tCategory.has(c) ? tCategory(c) : c)}
              summaryLabel={(checked, total, kcal) =>
                t('summary', { checked, total, kcal: kcal.toLocaleString() })
              }
              haveLabel={t('have')}
              ofLabel={(amount) => t('ofTotal', { amount })}
              deleteLabel={tCommon('delete')}
              deleteConfirm={t('deleteConfirm')}
              printLabel={t('print')}
              onPatch={(item, patch) =>
                updateItem.mutate({ listId: activeList.id, itemId: item.id, ...patch })
              }
              onDelete={remove.mutate}
            />
          )}
        </section>
      )}
    </div>
  );
}

function ListView({
  list,
  busy,
  formatQty,
  categoryLabel,
  summaryLabel,
  haveLabel,
  ofLabel,
  deleteLabel,
  deleteConfirm,
  printLabel,
  onPatch,
  onDelete,
}: {
  list: ShoppingList;
  busy: boolean;
  formatQty: (qty: number, unit: string) => string;
  categoryLabel: (key: string) => string;
  summaryLabel: (checked: number, total: number, kcal: number) => string;
  haveLabel: string;
  ofLabel: (amount: string) => string;
  deleteLabel: string;
  deleteConfirm: string;
  printLabel: string;
  onPatch: (
    item: ShoppingListItem,
    patch: { checked?: boolean; alreadyHaveQuantity?: number },
  ) => void;
  onDelete: (listId: string) => void;
}) {
  const totalItems = useMemo(
    () => list.groups.reduce((n, g) => n + g.items.length, 0),
    [list.groups],
  );
  const checkedItems = useMemo(
    () => list.groups.reduce((n, g) => n + g.items.filter((i) => i.checked).length, 0),
    [list.groups],
  );

  return (
    <Card className="max-w-3xl" data-print-area>
      <div className="flex items-center justify-between gap-4 border-b border-border p-4">
        <div>
          <p className="font-medium">
            {list.fromDate} → {list.toDate}
          </p>
          <p className="text-sm text-muted-foreground">
            {summaryLabel(checkedItems, totalItems, list.totalEstimatedCalories)}
          </p>
        </div>
        <div className="flex items-center gap-2" data-print-hide>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => window.print()}
            disabled={busy}
          >
            {printLabel}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-destructive"
            onClick={() => {
              if (window.confirm(deleteConfirm)) onDelete(list.id);
            }}
            disabled={busy}
          >
            {deleteLabel}
          </Button>
        </div>
      </div>
      <CardContent className="space-y-5 pt-4">
        {list.groups.map((g) => (
          <div key={g.category}>
            <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {categoryLabel(g.category)}
            </h3>
            <ul className="divide-y divide-border">
              {g.items.map((i) => (
                <ItemRow
                  key={`${i.id}-${i.alreadyHaveQuantity}`}
                  item={i}
                  busy={busy}
                  formatQty={formatQty}
                  haveLabel={haveLabel}
                  ofLabel={ofLabel}
                  onPatch={(patch) => onPatch(i, patch)}
                />
              ))}
            </ul>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function ItemRow({
  item,
  busy,
  formatQty,
  haveLabel,
  ofLabel,
  onPatch,
}: {
  item: ShoppingListItem;
  busy: boolean;
  formatQty: (qty: number, unit: string) => string;
  haveLabel: string;
  ofLabel: (amount: string) => string;
  onPatch: (patch: { checked?: boolean; alreadyHaveQuantity?: number }) => void;
}) {
  // Local copy of the "already have" value so the input is editable without
  // an API round-trip per keystroke. We commit on blur. The parent re-keys
  // this component on server-side changes, so initial state is always fresh.
  const [have, setHave] = useState(String(item.alreadyHaveQuantity || ''));

  return (
    <li className="flex items-center gap-3 py-2 text-sm">
      <input
        type="checkbox"
        className="h-4 w-4 shrink-0"
        checked={item.checked}
        disabled={busy}
        onChange={(e) => onPatch({ checked: e.target.checked })}
      />
      <span className={item.checked ? 'flex-1 line-through text-muted-foreground' : 'flex-1'}>
        {item.name}
      </span>
      <span className="tabular-nums text-muted-foreground">
        {formatQty(item.toBuyQuantity, item.unit)}
        {item.alreadyHaveQuantity > 0 && (
          <span className="ml-1 text-xs">
            {ofLabel(formatQty(item.totalQuantity, item.unit))}
          </span>
        )}
      </span>
      <label className="flex items-center gap-1 text-xs text-muted-foreground" data-print-hide>
        {haveLabel}
        <input
          type="number"
          min={0}
          step={item.unit === 'piece' ? 0.25 : 1}
          className="h-7 w-16 rounded border border-border bg-background px-1 text-right text-sm"
          value={have}
          disabled={busy}
          onChange={(e) => setHave(e.target.value)}
          onBlur={() => {
            const next = Number(have) || 0;
            if (next !== item.alreadyHaveQuantity) onPatch({ alreadyHaveQuantity: next });
          }}
        />
        {item.unit}
      </label>
    </li>
  );
}
