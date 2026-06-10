'use client';

import {
  Document,
  Font,
  Page,
  Path,
  Rect,
  StyleSheet,
  Svg,
  Text,
  View,
  Circle,
  pdf,
} from '@react-pdf/renderer';
import type { ShoppingList } from '@diet-app/shared';

/*
 * Self-hosted PDF generator for the shopping list. The default @react-pdf
 * built-in fonts (Helvetica/Times/Courier) cover only basic Latin and
 * mangle Polish diacritics. We register Inter (latin-ext) from /public so
 * the PDF renders correctly without any third-party font CDN call at
 * runtime — important for offline self-hosted instances.
 *
 * Registration is deferred + absolute-URL because @react-pdf internally
 * `fetch()`es the src at render time; with a relative path the resolution
 * is not always what you'd expect inside a bundler-emitted module.
 * Idempotent: registering twice with the same family is a no-op.
 */
let fontRegistered = false;
function ensureFontRegistered() {
  if (fontRegistered || typeof window === 'undefined') return;
  const origin = window.location.origin;
  Font.register({
    family: 'Inter',
    fonts: [
      { src: `${origin}/fonts/Inter-Regular.ttf`, fontWeight: 400 },
      { src: `${origin}/fonts/Inter-Bold.ttf`, fontWeight: 700 },
    ],
  });
  fontRegistered = true;
}

/*
 * Two on-disk shapes from the same generator:
 *
 *  - 'pretty-a4'  — full-page A4 portrait shopping notebook with per-item
 *                   dashed write-in lines for marking actual bought
 *                   quantities. Looks like a finished document.
 *  - 'foldable-a4' — A4 portrait. List in the top half, dashed fold line
 *                    across the middle, blank lined "Notatki" area in the
 *                    bottom half. Print on A4, fold once → A5 landscape
 *                    pocket notebook.
 */
const A4 = { width: 595.28, height: 841.89 } as const;
const FOLD_Y = A4.height / 2;

type Mode = 'pretty-a4' | 'foldable-a4';

const sharedStyles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    paddingBottom: 5,
    marginBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#000',
  },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  brandText: { fontSize: 11, fontFamily: 'Inter', fontWeight: 700 },
  dateText: {
    fontSize: 6.5,
    color: '#555',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: 1,
  },
  planText: {
    fontSize: 8,
    fontFamily: 'Inter',
    fontWeight: 700,
    textAlign: 'right',
    maxWidth: 220,
  },
  columnsRow: { flexDirection: 'row', gap: 14 },
  column: { flex: 1, flexDirection: 'column' },
  section: { marginBottom: 6 },
  sectionTitle: {
    fontSize: 7.5,
    fontFamily: 'Inter',
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    paddingBottom: 1,
    marginBottom: 3,
    borderBottomWidth: 0.5,
    borderBottomColor: '#999',
  },
});

const prettyStyles = StyleSheet.create({
  page: { padding: 32, fontSize: 11, fontFamily: 'Inter', color: '#000' },
  item: { marginBottom: 8 },
  itemTopRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  checkbox: { width: 11, height: 11, borderWidth: 0.9, borderColor: '#000' },
  checkboxFilled: { backgroundColor: '#000' },
  itemMain: { flex: 1, flexDirection: 'row', alignItems: 'baseline', gap: 4 },
  itemName: { fontSize: 10.5 },
  pantryHint: { fontSize: 8, color: '#666' },
  qty: { fontSize: 10, color: '#333', minWidth: 90, textAlign: 'right' },
  qtyOf: { fontSize: 7.5, color: '#777' },
  writeInRow: {
    marginTop: 3,
    marginLeft: 18,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 4,
  },
  writeInLabel: { fontSize: 7, color: '#888' },
  writeInLine: {
    flex: 1,
    borderBottomWidth: 0.5,
    borderBottomColor: '#888',
    borderStyle: 'dashed',
    height: 10,
  },
});

const foldableStyles = StyleSheet.create({
  page: { fontSize: 9, fontFamily: 'Inter', color: '#000' },
  topHalf: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: FOLD_Y,
    padding: 24,
  },
  bottomHalf: {
    position: 'absolute',
    top: FOLD_Y,
    left: 0,
    right: 0,
    bottom: 0,
    padding: 24,
  },
  foldLineRow: {
    position: 'absolute',
    top: FOLD_Y - 4,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
  },
  foldLine: {
    flex: 1,
    borderTopWidth: 0.5,
    borderTopColor: '#999',
    borderStyle: 'dashed',
    height: 0,
  },
  foldLabel: {
    fontSize: 6,
    color: '#999',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  item: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 2 },
  checkbox: { width: 8, height: 8, borderWidth: 0.7, borderColor: '#000' },
  checkboxFilled: { backgroundColor: '#000' },
  itemMain: { flex: 1, flexDirection: 'row', alignItems: 'baseline', gap: 3 },
  itemName: { fontSize: 8 },
  pantryHint: { fontSize: 6, color: '#666' },
  qty: { fontSize: 7.5, color: '#333', minWidth: 70, textAlign: 'right' },
  qtyOf: { fontSize: 6, color: '#777' },
  notesTitle: {
    fontSize: 8,
    fontFamily: 'Inter',
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 8,
    color: '#555',
  },
  notesLine: {
    borderBottomWidth: 0.4,
    borderBottomColor: '#bbb',
    height: 18,
  },
});

function Logo({ size = 22 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Rect width={64} height={64} rx={14} fill="#2f9e6f" />
      <Path
        d="M32 14c8 6 12 13 12 21a12 12 0 1 1-24 0c0-8 4-15 12-21Z"
        fill="#ffffff"
      />
      <Circle cx={32} cy={36} r={5} fill="#2f9e6f" />
    </Svg>
  );
}

type BuildOpts = {
  list: ShoppingList;
  appName: string;
  planTitle: string;
  dateRangeLabel: string;
  notesLabel: string;
  foldHereLabel: string;
  boughtLabel: string;
  categoryLabel: (key: string) => string;
  formatQty: (qty: number, unit: string) => string;
  ofLabel: (amount: string) => string;
  haveLabel: string;
  mode: Mode;
};

/**
 * Build the document. Strings are passed pre-translated by the caller so this
 * module stays decoupled from next-intl (which would not work inside the PDF
 * worker context anyway).
 */
export function buildShoppingListPdf(opts: BuildOpts) {
  ensureFontRegistered();
  return opts.mode === 'foldable-a4' ? buildFoldable(opts) : buildPretty(opts);
}

function splitGroups(list: ShoppingList) {
  // Two-column split, balance by item count so each column ends roughly the
  // same height — visually steadier than dumping every group in the left col.
  const counts = list.groups.map((g) => g.items.length);
  const total = counts.reduce((a, b) => a + b, 0);
  let acc = 0;
  let splitAt = list.groups.length;
  for (let i = 0; i < list.groups.length; i++) {
    acc += counts[i] ?? 0;
    if (acc >= total / 2) {
      splitAt = i + 1;
      break;
    }
  }
  return {
    leftGroups: list.groups.slice(0, splitAt),
    rightGroups: list.groups.slice(splitAt),
  };
}

function buildPretty(opts: BuildOpts) {
  const { list, appName, planTitle, dateRangeLabel, categoryLabel, formatQty, ofLabel, haveLabel, boughtLabel } = opts;
  const { leftGroups, rightGroups } = splitGroups(list);

  function renderItem(i: ShoppingList['groups'][number]['items'][number]) {
    // Auto-mark items fully covered by the pantry — nothing to buy means the
    // shopper can ignore the row, but it still appears so they can see "this
    // recipe needed flour, you already have it".
    const isCovered = i.toBuyQuantity === 0 && i.alreadyHaveQuantity > 0;
    const isChecked = i.checked || isCovered;
    return (
      <View key={i.id} style={prettyStyles.item} wrap={false}>
        <View style={prettyStyles.itemTopRow}>
          <View style={isChecked ? [prettyStyles.checkbox, prettyStyles.checkboxFilled] : prettyStyles.checkbox} />
          <View style={prettyStyles.itemMain}>
            <Text style={prettyStyles.itemName}>
              {i.name}
              {i.alreadyHaveQuantity > 0 && (
                <Text style={prettyStyles.pantryHint}> ({haveLabel})</Text>
              )}
            </Text>
          </View>
          <Text style={prettyStyles.qty}>
            {formatQty(i.toBuyQuantity, i.unit)}
            {i.alreadyHaveQuantity > 0 && (
              <Text style={prettyStyles.qtyOf}> {ofLabel(formatQty(i.totalQuantity, i.unit))}</Text>
            )}
          </Text>
        </View>
        <View style={prettyStyles.writeInRow}>
          <Text style={prettyStyles.writeInLabel}>{boughtLabel}:</Text>
          <View style={prettyStyles.writeInLine} />
        </View>
      </View>
    );
  }

  function renderGroup(g: ShoppingList['groups'][number]) {
    return (
      <View key={g.category} style={sharedStyles.section} wrap={false}>
        <Text style={sharedStyles.sectionTitle}>{categoryLabel(g.category)}</Text>
        {g.items.map(renderItem)}
      </View>
    );
  }

  return (
    <Document>
      <Page size={[A4.width, A4.height]} style={prettyStyles.page}>
        <View style={sharedStyles.header}>
          <View style={sharedStyles.brandRow}>
            <Logo size={26} />
            <View>
              <Text style={sharedStyles.brandText}>{appName}</Text>
              <Text style={sharedStyles.dateText}>{dateRangeLabel}</Text>
            </View>
          </View>
          <Text style={sharedStyles.planText}>{planTitle}</Text>
        </View>
        <View style={sharedStyles.columnsRow}>
          <View style={sharedStyles.column}>{leftGroups.map(renderGroup)}</View>
          <View style={sharedStyles.column}>{rightGroups.map(renderGroup)}</View>
        </View>
      </Page>
    </Document>
  );
}

function buildFoldable(opts: BuildOpts) {
  const { list, appName, planTitle, dateRangeLabel, notesLabel, foldHereLabel, categoryLabel, formatQty, ofLabel, haveLabel } = opts;
  const { leftGroups, rightGroups } = splitGroups(list);

  function renderItem(i: ShoppingList['groups'][number]['items'][number]) {
    const isCovered = i.toBuyQuantity === 0 && i.alreadyHaveQuantity > 0;
    const isChecked = i.checked || isCovered;
    return (
      <View key={i.id} style={foldableStyles.item} wrap={false}>
        <View style={isChecked ? [foldableStyles.checkbox, foldableStyles.checkboxFilled] : foldableStyles.checkbox} />
        <View style={foldableStyles.itemMain}>
          <Text style={foldableStyles.itemName}>
            {i.name}
            {i.alreadyHaveQuantity > 0 && (
              <Text style={foldableStyles.pantryHint}> ({haveLabel})</Text>
            )}
          </Text>
        </View>
        <Text style={foldableStyles.qty}>
          {formatQty(i.toBuyQuantity, i.unit)}
          {i.alreadyHaveQuantity > 0 && (
            <Text style={foldableStyles.qtyOf}> {ofLabel(formatQty(i.totalQuantity, i.unit))}</Text>
          )}
        </Text>
      </View>
    );
  }

  function renderGroup(g: ShoppingList['groups'][number]) {
    return (
      <View key={g.category} style={sharedStyles.section} wrap={false}>
        <Text style={sharedStyles.sectionTitle}>{categoryLabel(g.category)}</Text>
        {g.items.map(renderItem)}
      </View>
    );
  }

  // Bottom-half lined rows. 18pt per row, ~A4 half minus padding gives room
  // for ~18 lines — enough for write-ins without crowding the fold.
  const notesLines = Array.from({ length: 18 });

  return (
    <Document>
      <Page size={[A4.width, A4.height]} style={foldableStyles.page}>
        <View style={foldableStyles.topHalf}>
          <View style={sharedStyles.header}>
            <View style={sharedStyles.brandRow}>
              <Logo />
              <View>
                <Text style={sharedStyles.brandText}>{appName}</Text>
                <Text style={sharedStyles.dateText}>{dateRangeLabel}</Text>
              </View>
            </View>
            <Text style={sharedStyles.planText}>{planTitle}</Text>
          </View>
          <View style={sharedStyles.columnsRow}>
            <View style={sharedStyles.column}>{leftGroups.map(renderGroup)}</View>
            <View style={sharedStyles.column}>{rightGroups.map(renderGroup)}</View>
          </View>
        </View>

        <View style={foldableStyles.foldLineRow}>
          <View style={foldableStyles.foldLine} />
          <Text style={foldableStyles.foldLabel}>{foldHereLabel}</Text>
          <View style={foldableStyles.foldLine} />
        </View>

        <View style={foldableStyles.bottomHalf}>
          <Text style={foldableStyles.notesTitle}>{notesLabel}</Text>
          {notesLines.map((_, idx) => (
            <View key={idx} style={foldableStyles.notesLine} />
          ))}
        </View>
      </Page>
    </Document>
  );
}

/** Trigger a browser download of the generated PDF. */
export async function downloadShoppingListPdf(opts: BuildOpts & { filename: string }) {
  const { filename, ...rest } = opts;
  const doc = buildShoppingListPdf(rest);
  const blob = await pdf(doc).toBlob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Open the PDF in a new tab so the user can review and print it with their
 * PDF viewer's native print button. The hidden-iframe + iframe.print() trick
 * is unreliable for blob PDFs in modern Chrome (the viewer mounts inside the
 * iframe but its contentWindow.print() silently no-ops), so we just hand the
 * PDF off to the browser's viewer. Blob URL is revoked after a generous
 * timeout — long enough for the viewer to fetch + render.
 */
export async function printShoppingListPdf(opts: BuildOpts) {
  const doc = buildShoppingListPdf(opts);
  const blob = await pdf(doc).toBlob();
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank', 'noopener');
  // Best-effort auto-print when the viewer loads. Many setups will ignore
  // this (cross-origin viewer frame, popup-blocker rules), but when it does
  // fire the print dialog opens unattended. Failure mode is identical to
  // success-minus-print: PDF visible, user hits Ctrl/Cmd+P.
  if (win) {
    win.addEventListener('load', () => {
      try {
        win.focus();
        win.print();
      } catch {
        /* viewer ignored — user prints manually */
      }
    });
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
