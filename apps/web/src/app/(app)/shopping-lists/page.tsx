'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { MealPlan, Profile, ShoppingList, ShoppingListItem } from '@diet-app/shared';
import { api, ApiClientError } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

const selectClass = 'h-10 w-full rounded-md border border-border bg-background px-3 text-sm';

/** Pretty-print a unit value: "240 g" / "1.5 pieces". */
function formatItemQty(qty: number, unit: string): string {
  const rounded = unit === 'piece' ? Math.round(qty * 4) / 4 : Math.round(qty);
  if (unit === 'piece') return `${rounded} ${rounded === 1 ? 'piece' : 'pieces'}`;
  return `${rounded} ${unit}`;
}

const CATEGORY_LABEL: Record<string, string> = {
  vegetables: 'Vegetables',
  fruits: 'Fruits',
  dairy: 'Dairy',
  meat: 'Meat',
  fish: 'Fish',
  grains: 'Grains',
  legumes: 'Legumes',
  nuts_seeds: 'Nuts & seeds',
  fats_oils: 'Fats & oils',
  spices: 'Spices',
  pantry: 'Pantry',
  beverages: 'Beverages',
  other: 'Other',
};

/**
 * Shopping-list page — pick a profile + a plan, generate a list for any range
 * within that plan, then tick items off as you shop. Lists persist so coming
 * back later restores the same checkboxes.
 */
export default function ShoppingListsPage() {
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
  // Honour an explicit pick only when it still exists in the current plan's
  // lists — otherwise (plan changed, list deleted) fall back to the newest.
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
      setError(e instanceof ApiClientError ? e.message : 'Could not generate the list.'),
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
      setError(e instanceof ApiClientError ? e.message : 'Could not update the item.'),
  });

  const remove = useMutation({
    mutationFn: (listId: string) => api.delete<void>(`/shopping-lists/${listId}`),
    onSuccess: () => {
      setPickedList(null);
      qc.invalidateQueries({ queryKey: ['shopping-lists', activePlanId] });
    },
    onError: (e) =>
      setError(e instanceof ApiClientError ? e.message : 'Could not delete the list.'),
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

  if (profiles.isLoading) return <Skeleton className="h-40 max-w-2xl" />;

  if (profileList.length === 0) {
    return (
      <Card className="mx-auto mt-20 max-w-md text-center">
        <CardHeader>
          <CardTitle>No profile yet</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Create a profile and generate a meal plan first — a shopping list is built from a plan.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Shopping lists</h1>
        <p className="text-sm text-muted-foreground">
          Consolidated, aisle-grouped lists generated from a meal plan. Tick items off as
          you shop; mark what you already have to deduct it from the buy amount.
        </p>
      </header>

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

      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>Generate a list</CardTitle>
        </CardHeader>
        <CardContent>
          {planList.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No plans for this profile yet — generate a meal plan first.
            </p>
          ) : (
            <form onSubmit={onGenerate} className="grid gap-4 sm:grid-cols-4">
              <Field label="Plan">
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
                      {p.startDate} · {p.durationDays}-day · {p.dietType.replace('_', ' ')}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="From date (optional)">
                <Input name="fromDate" type="date" defaultValue={activePlan?.startDate ?? ''} />
              </Field>
              <Field label="To date (optional)">
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
                  {generate.isPending ? 'Generating…' : 'Generate'}
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>

      {error && <p className="max-w-3xl text-sm text-destructive">{error}</p>}

      {lists.isLoading ? (
        <Skeleton className="h-24 max-w-3xl" />
      ) : listOptions.length === 0 ? (
        planList.length > 0 && (
          <p className="max-w-3xl text-sm text-muted-foreground">
            No lists for this plan yet — generate one above.
          </p>
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
                  {l.fromDate} → {l.toDate}
                </Button>
              ))}
            </div>
          )}
          {activeList && (
            <ListView
              list={activeList}
              busy={updateItem.isPending || remove.isPending}
              onPatch={(item, patch) =>
                updateItem.mutate({ listId: activeList.id, itemId: item.id, ...patch })
              }
              onDelete={() => {
                if (window.confirm('Delete this shopping list?')) remove.mutate(activeList.id);
              }}
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
  onPatch,
  onDelete,
}: {
  list: ShoppingList;
  busy: boolean;
  onPatch: (
    item: ShoppingListItem,
    patch: { checked?: boolean; alreadyHaveQuantity?: number },
  ) => void;
  onDelete: () => void;
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
    <Card className="max-w-3xl">
      <div className="flex items-center justify-between gap-4 border-b border-border p-4">
        <div>
          <p className="font-medium">
            {list.fromDate} → {list.toDate}
          </p>
          <p className="text-sm text-muted-foreground">
            {checkedItems}/{totalItems} items checked ·{' '}
            {list.totalEstimatedCalories.toLocaleString()} kcal total
          </p>
        </div>
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
      </div>
      <CardContent className="space-y-5 pt-4">
        {list.groups.map((g) => (
          <div key={g.category}>
            <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {CATEGORY_LABEL[g.category] ?? g.category}
            </h3>
            <ul className="divide-y divide-border">
              {g.items.map((i) => (
                // Keying on alreadyHaveQuantity remounts ItemRow when the
                // server value changes, so its local input state re-initialises
                // without an in-effect setState.
                <ItemRow
                  key={`${i.id}-${i.alreadyHaveQuantity}`}
                  item={i}
                  busy={busy}
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
  onPatch,
}: {
  item: ShoppingListItem;
  busy: boolean;
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
        {formatItemQty(item.toBuyQuantity, item.unit)}
        {item.alreadyHaveQuantity > 0 && (
          <span className="ml-1 text-xs">
            (of {formatItemQty(item.totalQuantity, item.unit)})
          </span>
        )}
      </span>
      <label className="flex items-center gap-1 text-xs text-muted-foreground">
        have
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
