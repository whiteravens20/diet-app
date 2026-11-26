// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Package, Plus, Snowflake, Trash } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { Ingredient, InventoryItem, Profile, Unit } from '@diet-app/shared';
import { FROZEN_KEEPS_DAYS } from '@diet-app/shared/constants';
import { UNITS } from '@diet-app/shared/units';
import { api } from '@/lib/api';
import { localDate } from '@/lib/http';
import { dayAfter } from '@/lib/plan-dates';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input, OptionalFrame } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/empty-state';
import { PageBanner } from '@/components/page-banner';
import { RemovedBar, useRemovedLater } from '@/components/removed-later';
import { ProfileChips } from '@/components/profile-chips';
import { IMAGERY } from '@/lib/imagery';
import { useAmount, useUnitName } from '@/lib/ingredient-format';
import { useErrorText } from '@/lib/use-error-text';
import { useFormat } from '@/lib/use-format';
import { LoadFailed, ReadsFailed, unread } from '@/components/load-failed';
import { FreezeDialog, portionCount, portionsFit, PortionsLine } from './portions';
import { StillGoodDialog } from './still-good-dialog';

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
  const locale = useLocale();
  const fmt = useFormat();
  const tCategory = useTranslations('enums.category');
  const errorText = useErrorText();
  const unitName = useUnitName();
  const amount = useAmount();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [pickedProfile, setPickedProfile] = useState<string | null>(null);
  // The fresh row whose window of freezing is open.
  const [freezing, setFreezing] = useState<InventoryItem | null>(null);
  // The fresh row past its day whose window of "Nadal dobre" is open.
  const [stillGood, setStillGood] = useState<InventoryItem | null>(null);
  // The client's day: fresh stock past its day counts at home for no list and no plan until it is said to be good.
  const today = localDate();
  // Whether the window things are added to the pantry in is open: it stays open for the next until it is closed.
  const [adding, setAdding] = useState(false);
  // What ties the window's way to a row's amount to the field of that row.
  const rowsId = useId();
  const quantityId = (item: InventoryItem) => `${rowsId}-quantity-${item.id}`;

  const profiles = useQuery({
    queryKey: ['profiles'],
    queryFn: () => api.get<Profile[]>('/profiles'),
  });
  const profileList = profiles.data ?? [];
  const activeProfileId = pickedProfile ?? profileList[0]?.id ?? null;

  const inventory = useQuery({
    queryKey: ['inventory', activeProfileId],
    queryFn: () => api.get<InventoryItem[]>(`/inventory?profileId=${activeProfileId}`),
    enabled: Boolean(activeProfileId),
  });
  const items = inventory.data ?? [];

  // What went wrong is said in the window it was added from.
  const upsert = useMutation({
    mutationFn: (body: NewRow) => api.post<InventoryItem>('/inventory', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventory', activeProfileId] }),
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
    // Sent so that it outlives the page: a removal still held goes when the page is closed as well.
    mutationFn: (id: string) =>
      api.request<void>(`/inventory/${id}`, { method: 'DELETE', keepalive: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventory', activeProfileId] }),
    onError: (e) => setError(errorText(e, t('errDelete'))),
  });
  // A row is cheap to put in again: it goes at once, and is sent once the moments to take it back are over.
  const later = useRemovedLater<InventoryItem>(
    (item) => remove.mutateAsync(item.id),
    (item) => item.id,
  );

  const keep = useMutation({
    mutationFn: (v: { id: string; bestBefore: string | null }) =>
      api.post<InventoryItem>(`/inventory/${v.id}/still-good`, { bestBefore: v.bestBefore }),
    onSuccess: () => {
      setStillGood(null);
      void qc.invalidateQueries({ queryKey: ['inventory', activeProfileId] });
    },
  });

  // Answered with the pantry of the row's profile as it is then: the row is gone, its packages in the freezer.
  const freeze = useMutation({
    mutationFn: (v: { profileId: string; id: string; portions: number }) =>
      api.post<InventoryItem[]>(`/inventory/${v.id}/freeze`, { portions: v.portions }),
    onSuccess: (rows, v) => {
      qc.setQueryData(['inventory', v.profileId], rows);
      setFreezing(null);
    },
  });

  if (profiles.isLoading) return <Skeleton className="h-40" />;
  if (unread(profiles))
    return <LoadFailed error={profiles.error} onRetry={() => void profiles.refetch()} />;

  if (profileList.length === 0) {
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

  const grouped = new Map<string, InventoryItem[]>();
  for (const item of items) {
    if (later.hidden(item)) continue;
    const bucket = grouped.get(item.ingredient.category) ?? [];
    bucket.push(item);
    grouped.set(item.ingredient.category, bucket);
  }
  // By name, a food's packages in the freezer right after its fresh row, the one going off first first.
  for (const bucket of grouped.values())
    bucket.sort(
      (a, b) =>
        a.ingredient.name.localeCompare(b.ingredient.name, locale) ||
        Number(a.frozen) - Number(b.frozen) ||
        (a.bestBefore ?? '9999-12-31').localeCompare(b.bestBefore ?? '9999-12-31'),
    );

  return (
    <div className="space-y-8">
      <PageBanner image={IMAGERY.inventory} title={t('title')} subtitle={t('subhead')} />
      <ReadsFailed reads={[profiles, inventory]} />

      <ProfileChips profiles={profileList} active={activeProfileId} onPick={setPickedProfile} />

      {/* The rows first: what is added is added in a window over them. */}
      {activeProfileId && (
        <Button type="button" onClick={() => setAdding(true)}>
          <Plus className="h-4 w-4" aria-hidden />
          {t('addButton')}
        </Button>
      )}

      {error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      {inventory.isLoading ? (
        <Skeleton className="h-40" />
      ) : unread(inventory) ? (
        <LoadFailed error={inventory.error} onRetry={() => void inventory.refetch()} />
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
                  {rows.map((item) => {
                    // A package in the freezer has a row of its own beside the fresh one, and beside the other
                    // packages of its food, counted in the order they stand: each field says which row it is of.
                    const packages = rows.filter(
                      (row) => row.frozen && row.ingredient.id === item.ingredient.id,
                    );
                    const name = !item.frozen
                      ? fmt.text(item.ingredient.name)
                      : packages.length > 1
                        ? t('frozenPackageName', {
                            name: fmt.text(item.ingredient.name),
                            number: String(packages.indexOf(item) + 1),
                          })
                        : t('frozenName', { name: fmt.text(item.ingredient.name) });
                    // Fresh stock past its day: counted nowhere until it is said to be still good, or kept so.
                    const past =
                      !item.frozen && item.bestBefore !== null && item.bestBefore < today;
                    return (
                      <li key={item.id} className="flex flex-wrap items-center gap-3 py-3">
                        <span className="flex-1 min-w-[8rem] text-sm font-medium">
                          {fmt.text(item.ingredient.name)}
                          {item.frozen && (
                            <span className="ml-2 inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-foreground">
                              {t('frozen')}
                            </span>
                          )}
                          {past && !item.keptPastDate ? (
                            <span className="ml-2 inline-flex items-center rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
                              {t('pastDate')}
                            </span>
                          ) : past ? (
                            <span className="ml-2 inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                              {t('keptPastDate')}
                            </span>
                          ) : (
                            item.bestBefore &&
                            isExpiringSoon(item.bestBefore) && (
                              <span className="ml-2 inline-flex items-center rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
                                {t('expiringSoon')}
                              </span>
                            )
                          )}
                          {past && !item.keptPastDate && (
                            <span className="block text-xs font-normal text-muted-foreground">
                              {t('pastDateNote')}
                            </span>
                          )}
                        </span>
                        {/* An amount and its unit stay on one line, however the row wraps. */}
                        <span className="flex items-center gap-3">
                          {/* The field shows the amount as the API rounds it; leaving it
                            untouched must not write the rounded number over the exact one. */}
                          <Input
                            key={`${item.id}-${item.display.quantity}`}
                            id={quantityId(item)}
                            type="number"
                            step="0.01"
                            min="0"
                            defaultValue={item.display.quantity}
                            className="w-24"
                            aria-label={t('quantityOf', { name })}
                            onBlur={(e) => {
                              const typed = e.currentTarget.value.trim();
                              const next = Number(typed);
                              // An empty field or a number under nothing is not taken: the field shows what is kept.
                              if (typed === '' || !Number.isFinite(next) || next < 0) {
                                e.currentTarget.value = String(item.display.quantity);
                                return;
                              }
                              if (next === item.display.quantity) return;
                              patch.mutate({ id: item.id, quantity: next });
                            }}
                          />
                          <span className="min-w-14 text-xs text-muted-foreground">
                            {unitName(item.display.unit)}
                            {/* What the pieces weigh, a piece taken at its average. */}
                            {item.display.grams !== undefined &&
                              ` (${amount(item.display.grams, 'g')})`}
                          </span>
                        </span>
                        {/* The day and the row's buttons on one line, a phone's too: the day's label is over it there. */}
                        <div className="flex items-end gap-1 sm:items-center">
                          <label className="mr-2 flex flex-col gap-1 text-xs text-muted-foreground sm:flex-row sm:items-center sm:gap-2">
                            {t('bestBeforeLabel')}
                            <Input
                              type="date"
                              defaultValue={item.bestBefore ?? ''}
                              className="w-36 sm:w-40"
                              aria-label={t('bestBeforeOf', { name })}
                              onBlur={(e) => {
                                const next = e.currentTarget.value || null;
                                if (next === (item.bestBefore ?? null)) return;
                                patch.mutate({ id: item.id, bestBefore: next });
                              }}
                            />
                          </label>
                          {item.frozen ? (
                            // The room of the fresh rows' button, unseen, so that the fields of every row stand in
                            // one column where a row is one line; nothing where rows wrap.
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled
                              tabIndex={-1}
                              aria-hidden
                              className="invisible max-sm:hidden"
                            >
                              <Snowflake className="h-4 w-4" />
                              {t('freeze')}
                            </Button>
                          ) : (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              aria-label={t('freezeLabel', { name })}
                              title={t('freezeLabel', { name })}
                              onClick={() => {
                                freeze.reset();
                                setFreezing(item);
                              }}
                            >
                              <Snowflake className="h-4 w-4" />
                              {/* A phone has the snowflake alone, as the room of a line asks. */}
                              <span className="max-sm:hidden">{t('freeze')}</span>
                            </Button>
                          )}
                          {past && !item.keptPastDate && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              aria-label={t('stillGoodLabel', { name })}
                              onClick={() => {
                                keep.reset();
                                setStillGood(item);
                              }}
                            >
                              {t('stillGood')}
                            </Button>
                          )}
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            aria-label={t('removeLabel', { name })}
                            title={t('removeLabel', { name })}
                            onClick={() => later.remove(item)}
                          >
                            <Trash className="h-4 w-4" />
                          </Button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {adding && activeProfileId && (
        <AddInventoryDialog
          // The window adds to the profile it was opened for.
          key={activeProfileId}
          profileId={activeProfileId}
          // What is frozen stands apart: fresh of a food can be added beside its packages, and any food frozen.
          fresh={new Map(items.filter((i) => !i.frozen).map((i) => [i.ingredient.id, i]))}
          onChangeAmount={(row) => {
            setAdding(false);
            // Once the window is gone and has given the focus back: the row's amount, brought into sight by the focus
            // and to be typed over.
            requestAnimationFrame(() => {
              const field = document.getElementById(quantityId(row)) as HTMLInputElement | null;
              field?.focus();
              field?.select();
            });
          }}
          onAdd={(body) => upsert.mutateAsync(body)}
          errorOf={(e) => errorText(e, t('errAdd'))}
          onClose={() => setAdding(false)}
        />
      )}
      {freezing && activeProfileId && (
        <FreezeDialog
          item={freezing}
          busy={freeze.isPending}
          error={freeze.isError ? errorText(freeze.error, t('errFreeze')) : null}
          onFreeze={(portions) =>
            freeze.mutate({ profileId: activeProfileId, id: freezing.id, portions })
          }
          onClose={() => setFreezing(null)}
        />
      )}
      {stillGood && (
        <StillGoodDialog
          item={stillGood}
          busy={keep.isPending}
          error={keep.isError ? errorText(keep.error, t('errStillGood')) : null}
          onSave={(bestBefore) => keep.mutate({ id: stillGood.id, bestBefore })}
          onClose={() => setStillGood(null)}
        />
      )}
      {later.waiting && <RemovedBar name={later.waiting.ingredient.name} onUndo={later.undo} />}
    </div>
  );
}

/** What the window sends for a row of the pantry. */
type NewRow = {
  profileId: string;
  ingredientId: string;
  quantity: number;
  unit: Unit;
  bestBefore?: string | null;
  frozen?: boolean;
  portions?: number;
};

/**
 * The window things are put into the pantry in, one after another: after each it stays open with its fields
 * emptied, the focus back in the search and a line saying what went in, until it is closed.
 */
function AddInventoryDialog({
  profileId,
  fresh,
  onChangeAmount,
  onAdd,
  errorOf,
  onClose,
}: {
  profileId: string;
  /**
   * The fresh row of each food the pantry holds fresh, by its ingredient: found again, such a food is the row's to
   * change the amount of ([onChangeAmount]), unless it goes into the freezer as packages of its own.
   */
  fresh: ReadonlyMap<string, InventoryItem>;
  /** The window gives way to the amount of a row the pantry has. */
  onChangeAmount: (row: InventoryItem) => void;
  /** Puts the row in; settles once the server has it, or with why it does not. */
  onAdd: (body: NewRow) => Promise<unknown>;
  /** What went wrong, in the reader's words. */
  errorOf: (error: unknown) => string;
  onClose: () => void;
}) {
  const t = useTranslations('inventory');
  const tCommon = useTranslations('common');
  const unitName = useUnitName();
  const amount = useAmount();
  const fmt = useFormat();
  const [search, setSearch] = useState('');
  const [pickedIngredient, setPickedIngredient] = useState<Ingredient | null>(null);
  // What ties each label of the form to its field.
  const id = useId();
  const ids = {
    ingredient: `${id}-ingredient`,
    quantity: `${id}-quantity`,
    unit: `${id}-unit`,
    bestBefore: `${id}-best-before`,
    portions: `${id}-portions`,
    portionsLine: `${id}-portions-line`,
  };
  const [quantity, setQuantity] = useState('');
  const [unit, setUnit] = useState<Unit>('g');
  const [bestBefore, setBestBefore] = useState('');
  const [frozen, setFrozen] = useState(false);
  // The date the box wrote itself, taken away with the box while nobody changed it.
  const [boxDate, setBoxDate] = useState<string | null>(null);
  const [portionsTyped, setPortionsTyped] = useState('1');
  const portions = frozen ? portionCount(portionsTyped) : 1;
  const qty = Number(quantity);
  // What goes into the freezer goes in whole packages of at least one of its unit; fresh is one row whatever it is.
  const fits = !frozen || (portions !== null && (!(qty > 0) || portionsFit(qty, portions)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What went in last, said until the next goes.
  const [added, setAdded] = useState<string | null>(null);
  const searchField = useRef<HTMLInputElement>(null);

  // The window opens on the search: what is added begins with what it is. Taken once the window has the focus.
  useEffect(() => searchField.current?.focus(), []);

  const results = useQuery({
    queryKey: ['ingredients-search', search],
    queryFn: () => api.get<Ingredient[]>(`/ingredients?search=${encodeURIComponent(search)}`),
    enabled: search.trim().length >= 2,
  });
  const available = (results.data ?? []).slice(0, 8);

  /** Into the freezer or not: what goes in is dated as the freezer keeps it, unless a date is typed already. */
  function freezeIt(on: boolean) {
    setFrozen(on);
    if (on && bestBefore === '') {
      const date = dayAfter(localDate(), FROZEN_KEEPS_DAYS);
      setBestBefore(date);
      setBoxDate(date);
    } else if (!on) {
      if (boxDate !== null && bestBefore === boxDate) setBestBefore('');
      setBoxDate(null);
    }
  }

  function reset() {
    setSearch('');
    setPickedIngredient(null);
    setQuantity('');
    setBestBefore('');
    setFrozen(false);
    setBoxDate(null);
    setPortionsTyped('1');
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pickedIngredient || busy) return;
    if (!Number.isFinite(qty) || qty <= 0) return;
    if (portions === null || !fits) return;
    const values = {
      name: fmt.text(pickedIngredient.name),
      amount: amount(qty, unit === 'piece' ? (pickedIngredient.displayUnit ?? 'piece') : unit),
    };
    const said = !frozen
      ? t('added', values)
      : portions > 1
        ? t('addedPortions', { ...values, count: portions })
        : t('addedFrozen', values);
    setBusy(true);
    setError(null);
    setAdded(null);
    try {
      await onAdd({
        profileId,
        ingredientId: pickedIngredient.id,
        quantity: qty,
        unit,
        ...(bestBefore ? { bestBefore } : {}),
        ...(frozen ? { frozen: true } : {}),
        ...(portions > 1 ? { portions } : {}),
      });
      // Emptied for the next, which begins where this one did.
      flushSync(() => {
        reset();
        setAdded(said);
      });
      searchField.current?.focus();
    } catch (e) {
      // What was typed stays, to be sent again.
      setError(errorOf(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={onClose} label={t('addTitle')} className="max-w-lg">
      <div className="flex items-center justify-between border-b border-border p-4">
        <h2 className="font-semibold">{t('addTitle')}</h2>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {tCommon('close')}
        </Button>
      </div>
      <form onSubmit={(e) => void submit(e)} className="space-y-4 p-4">
        {/* Read out as it changes: the focus is back in the search by then. */}
        <p role="status" className={added ? 'text-sm text-muted-foreground' : 'sr-only'}>
          {added ?? ''}
        </p>
        <div className="relative">
          <label
            htmlFor={ids.ingredient}
            className="mb-1.5 block text-xs font-medium text-muted-foreground"
          >
            {t('ingredientLabel')}
          </label>
          {pickedIngredient ? (
            <div className="mt-1 flex items-center gap-2">
              <span className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
                {fmt.text(pickedIngredient.name)}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  flushSync(() => setPickedIngredient(null));
                  searchField.current?.focus();
                }}
              >
                {t('clearPick')}
              </Button>
            </div>
          ) : (
            <>
              <Input
                ref={searchField}
                id={ids.ingredient}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('searchPlaceholder')}
              />
              {search.trim().length >= 2 && unread(results) && (
                <ReadsFailed reads={[results]} unanswered />
              )}
              {search.trim().length >= 2 && available.length > 0 && (
                <ul className="absolute z-10 mt-1 max-h-60 w-full overflow-y-auto rounded-md border border-border bg-background shadow-md">
                  {available.map((i) => {
                    // Held fresh already: one fresh row a food, whose amount is changed where it stands.
                    const held = frozen ? undefined : fresh.get(i.id);
                    return (
                      <li key={i.id}>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-auto min-h-9 w-full flex-wrap justify-start gap-x-2 rounded-none text-left"
                          onClick={() => {
                            if (held) {
                              onChangeAmount(held);
                              return;
                            }
                            setPickedIngredient(i);
                            setSearch('');
                            // The unit the API offers first: pieces of what is counted, the rest as it is weighed or measured.
                            setUnit(i.pantryUnits[0]!);
                          }}
                        >
                          {fmt.text(i.name)}
                          {held && ' '}
                          {held && (
                            <span className="text-xs font-normal text-muted-foreground">
                              {t('heldFresh', {
                                amount: amount(held.display.quantity, held.display.unit),
                              })}
                            </span>
                          )}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label
              htmlFor={ids.quantity}
              className="mb-1.5 block text-xs font-medium text-muted-foreground"
            >
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
            <label
              htmlFor={ids.unit}
              className="mb-1.5 block text-xs font-medium text-muted-foreground"
            >
              {t('unitLabel')}
            </label>
            <select
              id={ids.unit}
              className={selectClass + ' w-24'}
              value={unit}
              onChange={(e) => setUnit(e.target.value as Unit)}
            >
              {/* Only what the ingredient can be converted from: stock in any other unit would count as nothing. */}
              {(pickedIngredient?.pantryUnits ?? UNITS).map((choice) => (
                <option key={choice} value={choice}>
                  {choice === 'piece' ? unitName(pickedIngredient?.displayUnit ?? 'piece') : choice}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label
              htmlFor={ids.bestBefore}
              className="mb-1.5 block text-xs font-medium text-muted-foreground"
            >
              {t('bestBeforeLabel')}
            </label>
            <OptionalFrame className="w-40">
              <Input
                id={ids.bestBefore}
                type="date"
                value={bestBefore}
                onChange={(e) => setBestBefore(e.target.value)}
                className="w-full"
              />
            </OptionalFrame>
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex h-10 items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={frozen}
              onChange={(e) => freezeIt(e.target.checked)}
            />
            {t('frozenLabel')}
          </label>
          {frozen && (
            <div>
              <label
                htmlFor={ids.portions}
                className="mb-1.5 block text-xs font-medium text-muted-foreground"
              >
                {t('portionsLabel')}
              </label>
              <Input
                id={ids.portions}
                type="number"
                inputMode="numeric"
                value={portionsTyped}
                onChange={(e) => setPortionsTyped(e.target.value)}
                aria-invalid={!fits || undefined}
                aria-describedby={ids.portionsLine}
                className="w-20"
              />
            </div>
          )}
          {frozen && (
            <div className="basis-full">
              <PortionsLine
                id={ids.portionsLine}
                quantity={qty}
                unit={unit}
                shownUnit={unit === 'piece' ? (pickedIngredient?.displayUnit ?? 'piece') : unit}
                portions={portions}
              />
            </div>
          )}
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end">
          <Button type="submit" disabled={!pickedIngredient || busy || !fits}>
            {t('addButton')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
