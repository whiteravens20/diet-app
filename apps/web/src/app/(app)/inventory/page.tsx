// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Package, Trash } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import type { Ingredient, InventoryItem, Profile, Unit } from '@diet-app/shared';
import { pantryUnits, UNITS } from '@diet-app/shared/units';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/empty-state';
import { PageBanner } from '@/components/page-banner';
import { IMAGERY } from '@/lib/imagery';
import { useUnitName } from '@/lib/ingredient-format';
import { useErrorText } from '@/lib/use-error-text';
import { LoadFailed } from '@/components/load-failed';

const selectClass = 'h-10 w-full rounded-md border border-input bg-background px-3 text-sm';

/**
 * Best-before urgency: an item is "expiring soon" if today is within
 * 2 days of `bestBefore` (inclusive of past dates — already expired is the
 * loudest case). Compared on the day boundary in UTC so DST / timezone don't
 * flip the result by a few hours.
 */
function isExpiringSoon(bestBefore: string): boolean {
  const due = new Date(`${bestBefore}T00:00:00.000Z`).getTime();
  if (Number.isNaN(due)) return false;
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return due - today <= 2 * 24 * 60 * 60 * 1000;
}

/**
 * Pantry-aware planning surface. Pick a profile, see what's in stock,
 * add/remove rows. The optimiser reads from this on the backend — every plan,
 * day re-roll and swap defaults to pantry-friendly when there's anything
 * here. The toggles to opt out per-request live on the plan / swap forms.
 */
export default function InventoryPage() {
  const t = useTranslations('inventory');
  const tCategory = useTranslations('enums.category');
  const errorText = useErrorText();
  const unitName = useUnitName();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [pickedProfile, setPickedProfile] = useState<string | null>(null);
  const profileId = useId();

  const profiles = useQuery({ queryKey: ['profiles'], queryFn: () => api.get<Profile[]>('/profiles') });
  const profileList = profiles.data ?? [];
  const activeProfileId = pickedProfile ?? profileList[0]?.id ?? null;

  const inventory = useQuery({
    queryKey: ['inventory', activeProfileId],
    queryFn: () => api.get<InventoryItem[]>(`/inventory?profileId=${activeProfileId}`),
    enabled: Boolean(activeProfileId),
  });
  const items = inventory.data ?? [];

  const upsert = useMutation({
    mutationFn: (body: {
      profileId: string;
      ingredientId: string;
      quantity: number;
      unit: Unit;
      bestBefore?: string | null;
    }) => api.post<InventoryItem>('/inventory', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventory', activeProfileId] }),
    onError: (e) => setError(errorText(e, t('errAdd'))),
  });

  const patch = useMutation({
    mutationFn: (v: { id: string; quantity?: number; bestBefore?: string | null }) =>
      api.patch<InventoryItem>(`/inventory/${v.id}`, {
        ...(v.quantity !== undefined ? { quantity: v.quantity } : {}),
        ...(v.bestBefore !== undefined ? { bestBefore: v.bestBefore } : {}),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventory', activeProfileId] }),
    onError: (e) => setError(errorText(e, t('errUpdate'))),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete<void>(`/inventory/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventory', activeProfileId] }),
    onError: (e) => setError(errorText(e, t('errDelete'))),
  });

  if (profiles.isLoading) return <Skeleton className="h-40 max-w-2xl" />;
  if (profiles.isError) return <LoadFailed error={profiles.error} onRetry={() => void profiles.refetch()} />;

  if (profileList.length === 0) {
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

  const grouped = new Map<string, InventoryItem[]>();
  for (const item of items) {
    const bucket = grouped.get(item.ingredient.category) ?? [];
    bucket.push(item);
    grouped.set(item.ingredient.category, bucket);
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-8">
      <PageBanner image={IMAGERY.inventory} title={t('title')} subtitle={t('subhead')} />

      {profileList.length > 1 && (
        <div className="max-w-xs">
          <label htmlFor={profileId} className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('profileLabel')}
          </label>
          <select
            id={profileId}
            className={selectClass}
            value={activeProfileId ?? ''}
            onChange={(e) => setPickedProfile(e.target.value)}
          >
            {profileList.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
      )}

      {error && (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {activeProfileId && (
        <AddInventoryForm
          profileId={activeProfileId}
          existingIds={new Set(items.map((i) => i.ingredient.id))}
          onSubmit={(body) => {
            setError(null);
            upsert.mutate(body);
          }}
          submitting={upsert.isPending}
        />
      )}

      {inventory.isLoading ? (
        <Skeleton className="h-40" />
      ) : items.length === 0 ? (
        <EmptyState
          icon={Package}
          image={IMAGERY.emptyInventory}
          title={t('emptyTitle')}
          description={t('emptyState')}
        />
      ) : (
        <div className="space-y-4">
          {[...grouped.entries()].map(([category, rows]) => (
            <Card key={category}>
              <CardHeader>
                <CardTitle className="text-base">{tCategory(category)}</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="divide-y divide-border">
                  {rows.map((item) => (
                    <li key={item.id} className="flex flex-wrap items-center gap-3 py-3">
                      <span className="flex-1 min-w-[8rem] text-sm font-medium">
                        {item.ingredient.name}
                        {item.bestBefore && isExpiringSoon(item.bestBefore) && (
                          <span
                            className="ml-2 inline-flex items-center rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive"
                          >
                            {t('expiringSoon')}
                          </span>
                        )}
                      </span>
                      {/* An amount and its unit stay on one line, however the row wraps. */}
                      <span className="flex items-center gap-3">
                        {/* The field shows the amount as the API rounds it; leaving it
                            untouched must not write the rounded number over the exact one. */}
                        <Input
                          key={`${item.id}-${item.display.quantity}`}
                          type="number"
                          step="0.01"
                          min="0"
                          defaultValue={item.display.quantity}
                          className="w-24"
                          aria-label={t('quantityOf', { name: item.ingredient.name })}
                          onBlur={(e) => {
                            const next = Number(e.currentTarget.value);
                            if (!Number.isFinite(next) || next < 0 || next === item.display.quantity) return;
                            patch.mutate({ id: item.id, quantity: next });
                          }}
                        />
                        <span className="w-14 text-xs text-muted-foreground">{unitName(item.display.unit)}</span>
                      </span>
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        {t('bestBeforeLabel')}
                        <Input
                          type="date"
                          defaultValue={item.bestBefore ?? ''}
                          className="w-40"
                          aria-label={t('bestBeforeOf', { name: item.ingredient.name })}
                          onBlur={(e) => {
                            const next = e.currentTarget.value || null;
                            if (next === (item.bestBefore ?? null)) return;
                            patch.mutate({ id: item.id, bestBefore: next });
                          }}
                        />
                      </label>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={t('removeLabel', { name: item.ingredient.name })}
                        onClick={() => remove.mutate(item.id)}
                      >
                        <Trash className="h-4 w-4" />
                      </Button>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function AddInventoryForm({
  profileId,
  existingIds,
  onSubmit,
  submitting,
}: {
  profileId: string;
  existingIds: Set<string>;
  onSubmit: (body: {
    profileId: string;
    ingredientId: string;
    quantity: number;
    unit: Unit;
    bestBefore?: string | null;
  }) => void;
  submitting: boolean;
}) {
  const t = useTranslations('inventory');
  const unitName = useUnitName();
  const [search, setSearch] = useState('');
  const [pickedIngredient, setPickedIngredient] = useState<Ingredient | null>(null);
  // What ties each label of the form to its field.
  const id = useId();
  const ids = { ingredient: `${id}-ingredient`, quantity: `${id}-quantity`, unit: `${id}-unit`, bestBefore: `${id}-best-before` };
  const [quantity, setQuantity] = useState('');
  const [unit, setUnit] = useState<Unit>('g');
  const [bestBefore, setBestBefore] = useState('');

  const results = useQuery({
    queryKey: ['ingredients-search', search],
    queryFn: () => api.get<Ingredient[]>(`/ingredients?search=${encodeURIComponent(search)}`),
    enabled: search.trim().length >= 2,
  });
  const available = (results.data ?? []).filter((i) => !existingIds.has(i.id)).slice(0, 8);

  function reset() {
    setSearch('');
    setPickedIngredient(null);
    setQuantity('');
    setBestBefore('');
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pickedIngredient) return;
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) return;
    onSubmit({
      profileId,
      ingredientId: pickedIngredient.id,
      quantity: qty,
      unit,
      ...(bestBefore ? { bestBefore } : {}),
    });
    reset();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('addTitle')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
          <div className="relative flex-1 min-w-[14rem]">
            <label htmlFor={ids.ingredient} className="block text-xs font-medium text-muted-foreground">
              {t('ingredientLabel')}
            </label>
            {pickedIngredient ? (
              <div className="mt-1 flex items-center gap-2">
                <span className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
                  {pickedIngredient.name}
                </span>
                <Button type="button" variant="ghost" size="sm" onClick={() => setPickedIngredient(null)}>
                  {t('clearPick')}
                </Button>
              </div>
            ) : (
              <>
                <Input
                  id={ids.ingredient}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t('searchPlaceholder')}
                />
                {search.trim().length >= 2 && available.length > 0 && (
                  <ul className="absolute z-10 mt-1 max-h-60 w-full overflow-y-auto rounded-md border border-border bg-background shadow-md">
                    {available.map((i) => (
                      <li key={i.id}>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="w-full justify-start rounded-none"
                          onClick={() => {
                            setPickedIngredient(i);
                            setSearch('');
                            // What is counted is kept in pieces of its own, the rest as it is weighed or measured.
                            setUnit(i.displayUnit && pantryUnits(i).includes('piece') ? 'piece' : i.canonicalUnit);
                          }}
                        >
                          {i.name}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
          <div>
            <label htmlFor={ids.quantity} className="block text-xs font-medium text-muted-foreground">
              {t('quantityLabel')}
            </label>
            <Input
              id={ids.quantity}
              type="number"
              step="0.01"
              min="0"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              className="w-28"
              required
            />
          </div>
          <div>
            <label htmlFor={ids.unit} className="block text-xs font-medium text-muted-foreground">
              {t('unitLabel')}
            </label>
            <select
              id={ids.unit}
              className={selectClass + ' w-24'}
              value={unit}
              onChange={(e) => setUnit(e.target.value as Unit)}
            >
              {/* Only what the ingredient can be converted from: stock in any other unit would count as nothing. */}
              {(pickedIngredient ? pantryUnits(pickedIngredient) : UNITS).map((choice) => (
                <option key={choice} value={choice}>
                  {choice === 'piece' ? unitName(pickedIngredient?.displayUnit ?? 'piece') : choice}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={ids.bestBefore} className="block text-xs font-medium text-muted-foreground">
              {t('bestBeforeLabel')}
            </label>
            <Input
              id={ids.bestBefore}
              type="date"
              value={bestBefore}
              onChange={(e) => setBestBefore(e.target.value)}
              className="w-40"
            />
          </div>
          <Button type="submit" disabled={!pickedIngredient || submitting}>
            {t('addButton')}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
