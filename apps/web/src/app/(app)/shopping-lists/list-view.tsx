// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

/** One shopping list: its rows by aisle, what is ticked and what is at home, and the ways to take it out of the application. */
import { useLocale, useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
import { Package } from 'lucide-react';
import type { DisplayUnit, ShoppingList, ShoppingListItem } from '@diet-app/shared';
import { copyText } from '@/lib/clipboard';
import { CSV_DIALECTS, csvOf } from '@/lib/csv';
import { useUnitName } from '@/lib/ingredient-format';
import { saveText } from '@/lib/save-file';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Card, CardContent } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { useFormat } from '@/lib/use-format';
import { AiOffNote } from '@/components/ai-off-note';
import { ListProposals } from './list-proposals';
import { packsStand, packsText } from './packs';

export function ListView({
  profileId,
  aiEnabled,
  aiOffNote,
  list,
  busy,
  locked,
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
  /** Something of the list is on its way to the server: what the server works out of a row waits for its answer. */
  busy: boolean;
  /** The list is being made again or removed: nothing of it can be ticked either. */
  locked: boolean;
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
  const groups = wanted
    ? list.groups
        .map((g) => ({
          ...g,
          items: g.items.filter((i) => i.name.toLocaleLowerCase().includes(wanted)),
        }))
        .filter((g) => g.items.length > 0)
    : list.groups;
  const fmt = useFormat();
  const dateRangeLabel = fmt.dates(list.fromDate, list.toDate);
  const tCommon = useTranslations('common');
  const unitName = useUnitName();
  const locale = useLocale();

  /** What is still to be obtained for a row: its need less everything the user has for it. */
  const stillToBuy = (item: ShoppingListItem): number =>
    Math.max(0, item.totalQuantity - (item.purchasedQuantity ?? item.alreadyHaveQuantity));
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
          ...left.map(
            (item) =>
              `- ${item.name}: ${formatQty(stillToBuy(item), item.displayUnit)}${packsStand(item) ? ` (${packsText(item.packs, formatQty)})` : ''}`,
          ),
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
    const head = (
      [
        'csvAisle',
        'csvEntry',
        'csvNeeded',
        'csvUnit',
        'csvAtHome',
        'csvHave',
        'csvToBuy',
        'csvPacks',
        'csvTicked',
        'csvEnergy',
      ] as const
    ).map((column) => t(column));
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
    saveText(
      csvOf([head, ...rows], CSV_DIALECTS[locale] ?? CSV_DIALECTS.en!),
      `shopping-list-${list.fromDate}_${list.toDate}.csv`,
      'text/csv',
    );
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
    <Card>
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
      {pdfError && <p className="px-4 py-2 text-sm text-destructive">{pdfError}</p>}
      {/* Said where it happened, and read out: a text on the clipboard cannot be seen. */}
      <p role="status" className={copied ? 'px-4 py-2 text-sm text-muted-foreground' : 'sr-only'}>
        {copied
          ? t(copied.entries === 0 ? 'copiedNothing' : 'copied', { count: copied.entries })
          : ''}
      </p>
      <Dialog
        open={byHand !== null}
        onClose={() => setByHand(null)}
        label={t('copyByHand')}
        className="max-w-md"
      >
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
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onUpdate(list)}
            disabled={busy}
          >
            {staleUpdateLabel}
          </Button>
        </div>
      )}
      <CardContent className="space-y-5 pt-4">
        {/* Asked of the list as it is: another list, or the same list made anew, begins without an answer. */}
        <div className="space-y-2">
          <ListProposals
            key={`${list.id}-${list.createdAt}`}
            list={list}
            profileId={profileId}
            aiEnabled={aiEnabled}
            aiOffNote={aiOffNote}
          />
          {aiOffNote && <AiOffNote id={aiOffNote} />}
        </div>
        <div className="max-w-sm">
          <Field label={t('findEntry')}>
            <Input
              type="search"
              value={find}
              onChange={(e) => setFind(e.target.value)}
              placeholder={t('findEntryPlaceholder')}
            />
          </Field>
        </div>
        {everyItem.some(packsStand) && (
          <p className="text-xs text-muted-foreground">{t('packsHint')}</p>
        )}
        {wanted && groups.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {t('findEntryNone', { words: find.trim() })}
          </p>
        )}
        {groups.map((g) => (
          <div key={g.category}>
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                {categoryLabel(g.category)}
              </h3>
              {/* What the whole aisle comes to, whatever part of it is looked for. */}
              <p className="text-xs text-muted-foreground">
                {t('aisleEnergy', { kcal: g.estimatedCalories })}
              </p>
            </div>
            <ul className="divide-y divide-border">
              {g.items.map((i) => (
                <ItemRow
                  key={`${i.id}-${i.alreadyHaveQuantity}-${i.purchasedQuantity ?? 'na'}-${i.checked}`}
                  item={i}
                  busy={busy}
                  locked={locked}
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
export interface RowPatch {
  checked?: boolean;
  purchasedQuantity?: number | null;
  alreadyHaveQuantity?: number;
}

/** A number somebody typed into a field of a row: nothing for an empty field, never under nothing. */
const typed = (field: string): number | null =>
  field.trim() === '' ? null : Math.max(0, Number(field) || 0);

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
  locked,
  formatQty,
  boughtLabel,
  ofLabel,
  onPatch,
}: {
  item: ShoppingListItem;
  busy: boolean;
  locked: boolean;
  formatQty: (qty: number, unit: DisplayUnit) => string;
  boughtLabel: string;
  ofLabel: (amount: string) => string;
  onPatch: (patch: RowPatch) => void;
}) {
  const t = useTranslations('shoppingLists');
  const fmt = useFormat();
  const unitName = useUnitName();
  // What was bought beyond what was at home, as the API has it.
  const boughtBefore = Math.max(
    0,
    (item.purchasedQuantity ?? item.alreadyHaveQuantity) - item.alreadyHaveQuantity,
  );
  // Local copies of the two fields, so that they can be typed in without a
  // request for every key. They are sent when the field is left. The parent
  // makes the row anew when the server changed it, so these begin fresh then.
  const [home, setHome] = useState(
    item.alreadyHaveQuantity > 0 ? String(item.alreadyHaveQuantity) : '',
  );
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
      {/* A tick does not wait for the one before it: only a list that is being replaced takes none. */}
      <input
        type="checkbox"
        aria-label={item.name}
        className="h-4 w-4 shrink-0"
        checked={item.checked}
        disabled={locked}
        onChange={(e) => onPatch({ checked: e.target.checked, ...pending() })}
      />
      <span
        className={
          item.checked ? 'min-w-32 flex-1 text-muted-foreground line-through' : 'min-w-32 flex-1'
        }
      >
        {item.name}
        {item.pantryBestBefore != null && item.alreadyHaveQuantity > 0 && (
          <span className="ml-2 inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground no-underline">
            {t('bestBefore', { date: fmt.date(item.pantryBestBefore) })}
          </span>
        )}
      </span>
      <span className="tabular-nums text-muted-foreground">
        {formatQty(remainingToBuy, item.displayUnit)}
        {showOfTotal && (
          <span className="ml-1 text-xs">
            {ofLabel(formatQty(item.totalQuantity, item.displayUnit))}
          </span>
        )}
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
          onClick={() =>
            onPatch({
              purchasedQuantity: item.alreadyHaveQuantity + item.packs.quantity,
              checked: true,
            })
          }
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
            onChange={(e) =>
              (e.target.value === '' || Number(e.target.value) >= 0) && setHome(e.target.value)
            }
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
            onChange={(e) =>
              (e.target.value === '' || Number(e.target.value) >= 0) && setBought(e.target.value)
            }
            onBlur={send}
          />
          {unitName(item.displayUnit)}
        </label>
      </span>
    </li>
  );
}
