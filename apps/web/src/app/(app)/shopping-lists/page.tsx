// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useId, useMemo, useState } from 'react';
import { Package, ShoppingBasket } from 'lucide-react';
import type { DisplayUnit, MealPlanPage, Profile, SessionUser, ShoppingList, ShoppingListItem } from '@diet-app/shared';
import { api } from '@/lib/api';
import { copyText } from '@/lib/clipboard';
import { ApiClientError } from '@/lib/http';
import { offline } from '@/lib/offline';
import { CSV_DIALECTS, csvOf } from '@/lib/csv';
import { useAmount, useUnitName } from '@/lib/ingredient-format';
import { saveText } from '@/lib/save-file';
import { Button, buttonVariants } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/empty-state';
import { PageBanner } from '@/components/page-banner';
import { IMAGERY } from '@/lib/imagery';
import { useErrorText } from '@/lib/use-error-text';
import { Field, Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useFormat } from '@/lib/use-format';
import { LoadFailed } from '@/components/load-failed';
import { AiOffNote } from '@/components/ai-off-note';
import { ListProposals } from './list-proposals';
import { packsStand, packsText } from './packs';

const selectClass = 'h-10 w-full rounded-md border border-input bg-background px-3 text-sm';

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

function ListView({
  profileId,
  aiEnabled,
  aiOffNote,
  list,
  busy,
  formatQty,
  categoryLabel,
  summaryLabel,
  boughtLabel,
  ofLabel,
  deleteLabel,
  deleteConfirm,
  printNotebookLabel,
  printPdfLabel,
  printGeneratingPdfLabel,
  printPdfErrorLabel,
  notesLabel,
  foldHereLabel,
  appName,
  planTitle,
  haveLabel,
  staleLabel,
  staleUpdateLabel,
  staleUpdateHint,
  onPatch,
  onDelete,
  onUpdate,
}: {
  profileId: string | null;
  aiEnabled: boolean;
  /** The id of the line that says why what asks a model is off, on an account where it is. */
  aiOffNote: string | undefined;
  list: ShoppingList;
  busy: boolean;
  formatQty: (qty: number, unit: DisplayUnit) => string;
  categoryLabel: (key: string) => string;
  summaryLabel: (checked: number, total: number, kcal: number) => string;
  boughtLabel: string;
  ofLabel: (amount: string) => string;
  deleteLabel: string;
  deleteConfirm: string;
  printNotebookLabel: string;
  printPdfLabel: string;
  printGeneratingPdfLabel: string;
  printPdfErrorLabel: string;
  notesLabel: string;
  foldHereLabel: string;
  appName: string;
  planTitle: string;
  haveLabel: string;
  staleLabel: string;
  staleUpdateLabel: string;
  staleUpdateHint: string;
  onPatch: (item: ShoppingListItem, patch: RowPatch) => void;
  onDelete: (listId: string) => void;
  onUpdate: (list: ShoppingList) => void;
}) {
  const totalItems = useMemo(
    () => list.groups.reduce((n, g) => n + g.items.length, 0),
    [list.groups],
  );
  const checkedItems = useMemo(
    () => list.groups.reduce((n, g) => n + g.items.filter((i) => i.checked).length, 0),
    [list.groups],
  );
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const t = useTranslations('shoppingLists');
  // What somebody in a shop is looking for on the list: the entries whose name holds the words, under the aisles they are in.
  const [find, setFind] = useState('');
  const wanted = find.trim().toLocaleLowerCase();
  const groups = wanted ? list.groups.map((g) => ({ ...g, items: g.items.filter((i) => i.name.toLocaleLowerCase().includes(wanted)) })).filter((g) => g.items.length > 0) : list.groups;
  const fmt = useFormat();
  const dateRangeLabel = fmt.dates(list.fromDate, list.toDate);
  const tCommon = useTranslations('common');
  const unitName = useUnitName();
  const locale = useLocale();

  /** What is still to be obtained for a row: its need less everything the user has for it. */
  const stillToBuy = (item: ShoppingListItem): number => Math.max(0, item.totalQuantity - (item.purchasedQuantity ?? item.alreadyHaveQuantity));
  const everyItem = list.groups.flatMap((group) => group.items);
  const open = everyItem.filter((item) => !item.checked);

  // The list as a text somebody can send: what is still to be bought, under its aisles. What is ticked is done with.
  const asText = (): string =>
    [
      t('copyTitle', { dates: dateRangeLabel }),
      ...(open.length === 0 ? ['', t('copyNothing')] : []),
      ...list.groups
        .map((group) => ({ group, left: group.items.filter((item) => !item.checked) }))
        .filter(({ left }) => left.length > 0)
        .flatMap(({ group, left }) => [
          '',
          categoryLabel(group.category),
          // What is sold in packs says how many, for whoever stands at the shelf.
          ...left.map((item) => `- ${item.name}: ${formatQty(stillToBuy(item), item.displayUnit)}${packsStand(item) ? ` (${packsText(item.packs, formatQty)})` : ''}`),
        ]),
    ].join('\n');
  // What happened to the last copy: it is on the clipboard, or it is shown to be copied by hand.
  const [copied, setCopied] = useState<{ entries: number } | null>(null);
  const [byHand, setByHand] = useState<string | null>(null);
  async function copy() {
    const text = asText();
    setCopied(null);
    if (await copyText(text)) setCopied({ entries: open.length });
    else setByHand(text);
  }

  // The whole list as a table for a spreadsheet: every row, ticked or not, with its numbers as numbers.
  function downloadCsv() {
    const head = (['csvAisle', 'csvEntry', 'csvNeeded', 'csvUnit', 'csvAtHome', 'csvHave', 'csvToBuy', 'csvPacks', 'csvTicked', 'csvEnergy'] as const).map((column) => t(column));
    const rows = list.groups.flatMap((group) =>
      group.items.map((item) => [
        categoryLabel(group.category),
        item.name,
        item.totalQuantity,
        unitName(item.displayUnit),
        item.alreadyHaveQuantity,
        item.purchasedQuantity ?? item.alreadyHaveQuantity,
        stillToBuy(item),
        packsStand(item) ? packsText(item.packs, formatQty) : '',
        tCommon(item.checked ? 'yes' : 'no'),
        item.estimatedCalories,
      ]),
    );
    saveText(csvOf([head, ...rows], CSV_DIALECTS[locale] ?? CSV_DIALECTS.en!), `shopping-list-${list.fromDate}_${list.toDate}.csv`, 'text/csv');
  }

  // Two PDF flavours from the same generator:
  //   - download → 'pretty-a4': finished A4 shopping notebook with per-item
  //     write-in lines.
  //   - print    → 'foldable-a4': A4 sheet with list in top half, fold line,
  //     blank Notatki area in bottom half. Opens in a new tab so the PDF
  //     viewer's native print can fire.
  // Lazy-import so the ~400 kB @react-pdf bundle only ships when a user clicks.
  async function runPdf(action: 'print' | 'download') {
    setPdfError(null);
    setPdfBusy(true);
    try {
      const mod = await import('./pdf-document');
      const opts = {
        list,
        appName,
        planTitle,
        dateRangeLabel,
        categoryLabel,
        formatQty,
        ofLabel,
        haveLabel,
        boughtLabel,
        notesLabel,
        foldHereLabel,
        mode: action === 'print' ? ('foldable-a4' as const) : ('pretty-a4' as const),
      };
      if (action === 'download') {
        await mod.downloadShoppingListPdf({
          ...opts,
          filename: `shopping-list-${list.fromDate}_${list.toDate}.pdf`,
        });
      } else {
        await mod.printShoppingListPdf(opts);
      }
    } catch (err) {
      console.error('[shopping-list pdf] generation failed', err);
      setPdfError(printPdfErrorLabel);
    } finally {
      setPdfBusy(false);
    }
  }

  return (
    <Card className="max-w-3xl">
      <div className="flex items-center justify-between gap-4 border-b border-border p-4">
        <div>
          <p className="font-medium">{dateRangeLabel}</p>
          <p className="text-sm text-muted-foreground">
            {summaryLabel(checkedItems, totalItems, list.totalEstimatedCalories)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => runPdf('print')}
            disabled={busy || pdfBusy}
          >
            {pdfBusy ? printGeneratingPdfLabel : printNotebookLabel}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => runPdf('download')}
            disabled={busy || pdfBusy}
          >
            {pdfBusy ? printGeneratingPdfLabel : printPdfLabel}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
            {t('copy')}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={downloadCsv}>
            {t('csv')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-destructive"
            onClick={() => {
              if (window.confirm(deleteConfirm)) onDelete(list.id);
            }}
            disabled={busy || pdfBusy}
          >
            {deleteLabel}
          </Button>
        </div>
      </div>
      {pdfError && (
        <p className="px-4 py-2 text-sm text-destructive">
          {pdfError}
        </p>
      )}
      {/* Said where it happened, and read out: a text on the clipboard cannot be seen. */}
      <p role="status" className={copied ? 'px-4 py-2 text-sm text-muted-foreground' : 'sr-only'}>
        {copied ? t(copied.entries === 0 ? 'copiedNothing' : 'copied', { count: copied.entries }) : ''}
      </p>
      <Dialog open={byHand !== null} onClose={() => setByHand(null)} label={t('copyByHand')} className="max-w-md">
        <div className="space-y-3 p-4">
          <h2 className="font-semibold">{t('copyByHand')}</h2>
          <p className="text-sm text-muted-foreground">{t('copyByHandHint')}</p>
          <textarea
            readOnly
            rows={12}
            aria-label={t('copyByHand')}
            className="w-full rounded-md border border-input bg-background p-2 font-mono text-xs"
            value={byHand ?? ''}
            onFocus={(event) => event.currentTarget.select()}
          />
          <div className="flex justify-end">
            <Button type="button" variant="ghost" size="sm" onClick={() => setByHand(null)}>
              {tCommon('close')}
            </Button>
          </div>
        </div>
      </Dialog>
      {list.stale && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 border-b border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning"
        >
          <p>
            {staleLabel} <span className="text-xs">{staleUpdateHint}</span>
          </p>
          <Button type="button" size="sm" variant="outline" onClick={() => onUpdate(list)} disabled={busy}>
            {staleUpdateLabel}
          </Button>
        </div>
      )}
      <CardContent className="space-y-5 pt-4">
        {/* Asked of the list as it is: another list, or the same list made anew, begins without an answer. */}
        <div className="space-y-2">
          <ListProposals key={`${list.id}-${list.createdAt}`} list={list} profileId={profileId} aiEnabled={aiEnabled} aiOffNote={aiOffNote} />
          {aiOffNote && <AiOffNote id={aiOffNote} />}
        </div>
        <div className="max-w-sm">
          <Field label={t('findEntry')}>
            <Input type="search" value={find} onChange={(e) => setFind(e.target.value)} placeholder={t('findEntryPlaceholder')} />
          </Field>
        </div>
        {everyItem.some(packsStand) && <p className="text-xs text-muted-foreground">{t('packsHint')}</p>}
        {wanted && groups.length === 0 && <p className="text-sm text-muted-foreground">{t('findEntryNone', { words: find.trim() })}</p>}
        {groups.map((g) => (
          <div key={g.category}>
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{categoryLabel(g.category)}</h3>
              {/* What the whole aisle comes to, whatever part of it is looked for. */}
              <p className="text-xs text-muted-foreground">{t('aisleEnergy', { kcal: g.estimatedCalories })}</p>
            </div>
            <ul className="divide-y divide-border">
              {g.items.map((i) => (
                <ItemRow
                  key={`${i.id}-${i.alreadyHaveQuantity}-${i.purchasedQuantity ?? 'na'}-${i.checked}`}
                  item={i}
                  busy={busy}
                  formatQty={formatQty}
                  boughtLabel={boughtLabel}
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

/** What a row sends when it is changed: what is at home, everything the user has for it, whether it is done. */
interface RowPatch {
  checked?: boolean;
  purchasedQuantity?: number | null;
  alreadyHaveQuantity?: number;
}

/** A number somebody typed into a field of a row: nothing for an empty field, never under nothing. */
const typed = (field: string): number | null => (field.trim() === '' ? null : Math.max(0, Number(field) || 0));

/**
 * A row of the list: what is still to be bought of it, how much of it is at
 * home, and how much was bought. The API keeps one number for everything the
 * user has for a row; the row shows it as its two parts, and sends the part
 * that changed. What is at home starts at what the pantry had when the list
 * was made, and is the user's to correct: a pantry does not know everything
 * that is in a kitchen.
 */
function ItemRow({
  item,
  busy,
  formatQty,
  boughtLabel,
  ofLabel,
  onPatch,
}: {
  item: ShoppingListItem;
  busy: boolean;
  formatQty: (qty: number, unit: DisplayUnit) => string;
  boughtLabel: string;
  ofLabel: (amount: string) => string;
  onPatch: (patch: RowPatch) => void;
}) {
  const t = useTranslations('shoppingLists');
  const fmt = useFormat();
  const unitName = useUnitName();
  // What was bought beyond what was at home, as the API has it.
  const boughtBefore = Math.max(0, (item.purchasedQuantity ?? item.alreadyHaveQuantity) - item.alreadyHaveQuantity);
  // Local copies of the two fields, so that they can be typed in without a
  // request for every key. They are sent when the field is left. The parent
  // makes the row anew when the server changed it, so these begin fresh then.
  const [home, setHome] = useState(item.alreadyHaveQuantity > 0 ? String(item.alreadyHaveQuantity) : '');
  const [bought, setBought] = useState(boughtBefore > 0 ? String(boughtBefore) : '');
  // Eggs come whole; half a loaf's slice is as fine as it gets.
  const step = item.unit === 'piece' ? 0.5 : 1;

  // What is left to buy follows the fields while they are typed in.
  const homeNow = typed(home) ?? 0;
  const boughtNow = typed(bought) ?? 0;
  const remainingToBuy = Math.max(0, item.totalQuantity - homeNow - boughtNow);
  const showOfTotal = homeNow > 0 || boughtNow > 0;

  /**
   * What the fields hold that the server does not have yet. A tick sends it
   * along, so that a click on the box while a field still has the focus does
   * not race the request the field sends when it is left.
   */
  function pending(): RowPatch {
    // What is at home is sent alone: the server leaves what was bought beyond it as it was.
    const atHome = homeNow !== item.alreadyHaveQuantity ? { alreadyHaveQuantity: homeNow } : {};
    if (boughtNow === boughtBefore) return atHome;
    // Everything the user has for the row: the part at home, as the server will count it, and what was bought.
    const have = Math.min(homeNow, item.totalQuantity) + boughtNow;
    return { ...atHome, purchasedQuantity: have > 0 ? have : null };
  }
  const send = (): void => {
    const patch = pending();
    if (Object.keys(patch).length > 0) onPatch(patch);
  };
  const field = 'h-7 w-16 rounded border border-input bg-background px-1 text-right text-sm';

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2 text-sm">
      <input type="checkbox" aria-label={item.name} className="h-4 w-4 shrink-0" checked={item.checked} disabled={busy} onChange={(e) => onPatch({ checked: e.target.checked, ...pending() })} />
      <span className={item.checked ? 'min-w-32 flex-1 text-muted-foreground line-through' : 'min-w-32 flex-1'}>
        {item.name}
        {item.pantryBestBefore != null && item.alreadyHaveQuantity > 0 && (
          <span className="ml-2 inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground no-underline">{t('bestBefore', { date: fmt.date(item.pantryBestBefore) })}</span>
        )}
      </span>
      <span className="tabular-nums text-muted-foreground">
        {formatQty(remainingToBuy, item.displayUnit)}
        {showOfTotal && <span className="ml-1 text-xs">{ofLabel(formatQty(item.totalQuantity, item.displayUnit))}</span>}
      </span>
      {/* The packs are counted by the server from what it knows is at home: while that is being typed anew, they are not said. */}
      {packsStand(item) && homeNow === item.alreadyHaveQuantity && boughtNow === 0 && (
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1 rounded border border-input px-2 text-xs tabular-nums text-muted-foreground hover:bg-muted disabled:opacity-50"
          disabled={busy}
          aria-label={t('buyPacks', { packs: packsText(item.packs, formatQty), name: item.name })}
          title={t('buyPacksTitle')}
          // Everything the user has for the row then: what was at home, and what the packs give it. That is the need at least, so the row is done.
          onClick={() => onPatch({ purchasedQuantity: item.alreadyHaveQuantity + item.packs.quantity, checked: true })}
        >
          <Package size={12} aria-hidden />
          {packsText(item.packs, formatQty)}
        </button>
      )}
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          {t('atHome')}
          <input
            type="number"
            min={0}
            step={step}
            className={field}
            value={home}
            disabled={busy}
            // A number under nothing is not taken; an empty field is.
            onChange={(e) => (e.target.value === '' || Number(e.target.value) >= 0) && setHome(e.target.value)}
            onBlur={send}
          />
          {unitName(item.displayUnit)}
        </label>
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          {boughtLabel}
          <input
            type="number"
            min={0}
            step={step}
            className={field}
            value={bought}
            disabled={busy}
            onChange={(e) => (e.target.value === '' || Number(e.target.value) >= 0) && setBought(e.target.value)}
            onBlur={send}
          />
          {unitName(item.displayUnit)}
        </label>
      </span>
    </li>
  );
}
