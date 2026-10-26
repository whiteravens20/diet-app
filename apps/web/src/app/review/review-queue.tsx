// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Check, ChevronLeft, ChevronRight, Keyboard, LoaderCircle, X } from 'lucide-react';
import type {
  Allergen,
  IngredientNameReviewSlice,
  Locale,
  RecipeReviewSlice,
  ReviewAction,
} from '@diet-app/shared';
import { ALLERGENS } from '@diet-app/shared/constants';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { reviewApi } from '@/lib/review-api';
import { useDraftErrorText } from '@/lib/use-draft-error';
import { useErrorText } from '@/lib/use-error-text';
import { useFormat } from '@/lib/use-format';
import { cn } from '@/lib/utils';
import { useReviewKeys, useReviewKeysWanted } from './review-keys';

interface QueueProps {
  locale: Locale;
  kind: 'recipe' | 'ingredient-name';
}

/** What the queue tells the draft on show about the keys and its place. */
interface DraftPlace {
  /** How the draft is named to those who do not see it. */
  label: string;
  keys: boolean;
  takesFocus: boolean;
  /** Left out at the last draft of the page, and at the first. */
  next?: () => void;
  previous?: () => void;
}

/**
 * Renders the focused-review queue for one (locale, kind) pair. Pulls a page
 * of pending drafts on mount + locale/kind change, walks the operator through
 * one at a time, and refetches when the cursor hits the end. Approve / reject
 * remove the row from the in-memory queue; the reviewer never sees their own
 * approvals come back.
 */
export function ReviewQueue({ locale, kind }: QueueProps) {
  const t = useTranslations('review');
  const errorText = useErrorText();
  // `itemsKind` is the kind the current `items` were fetched for. If it
  // doesn't match the prop, the data is stale (mid-switch) and we must treat
  // the queue as still loading — otherwise we'd cast e.g. an ingredient-name
  // slice to a recipe slice and crash on the missing `.steps` field.
  const [items, setItems] = useState<RecipeReviewSlice[] | IngredientNameReviewSlice[] | null>(
    null,
  );
  const [itemsKind, setItemsKind] = useState<QueueProps['kind'] | null>(null);
  const [cursor, setCursor] = useState(0);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [keys, wantKeys] = useReviewKeysWanted();
  // Whether the draft on show came up after a decision on the one before: it
  // then takes the focus that went with the button pressed there.
  const [decided, setDecided] = useState(false);

  const fetchPage = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      if (kind === 'recipe') {
        const page = await reviewApi.listRecipeSlices(locale, { page: 1, pageSize: 25 });
        setItems(page.items);
        setTotal(page.total);
      } else {
        const page = await reviewApi.listIngredientNameSlices(locale, {
          page: 1,
          pageSize: 25,
        });
        setItems(page.items);
        setTotal(page.total);
      }
      setItemsKind(kind);
      setCursor(0);
    } catch (err) {
      setError(errorText(err, t('queueFailed')));
      setItems([]);
      setItemsKind(kind);
    }
  }, [kind, locale, t, errorText]);

  useEffect(() => {
    void (async () => {
      setItems(null);
      setItemsKind(null);
      setDecided(false);
      await fetchPage();
    })();
  }, [fetchPage]);

  if (items === null || itemsKind !== kind) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <LoaderCircle className="h-4 w-4 animate-spin" />
          {t('queueLoading')}
        </CardContent>
      </Card>
    );
  }
  if (error) {
    return (
      <Card className="border-destructive/40 bg-destructive/5">
        <CardContent className="space-y-3 py-6 text-sm">
          <p>{error}</p>
          <Button variant="outline" size="sm" onClick={() => void fetchPage()}>
            {t('retry')}
          </Button>
        </CardContent>
      </Card>
    );
  }
  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="space-y-3 py-6 text-sm text-muted-foreground">
          <p>{t('queueEmpty')}</p>
          <Button variant="outline" size="sm" onClick={() => void fetchPage()}>
            {t('refresh')}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const safeCursor = Math.min(cursor, items.length - 1);
  const current = items[safeCursor];
  const advance = (): void => {
    const next = items.filter((_, i) => i !== safeCursor);
    setTotal((n) => Math.max(0, n - 1));
    setDecided(true);
    if (next.length === 0) {
      // The page is done: the next one is read, and nothing is said to be left over meanwhile.
      setItems(null);
      void fetchPage();
    } else {
      setItems(next as typeof items);
      setCursor((c) => Math.min(c, next.length - 1));
    }
  };
  // A step with a button leaves the focus on the button; the keys keep it on the draft.
  const step = (by: 1 | -1): void => {
    setDecided(false);
    setCursor(safeCursor + by);
  };
  const place: DraftPlace = {
    label: t('draftLabel', { current: safeCursor + 1, visible: items.length }),
    keys,
    takesFocus: keys || decided,
    previous: safeCursor > 0 ? () => step(-1) : undefined,
    next: safeCursor < items.length - 1 ? () => step(1) : undefined,
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {t('queueProgress', {
            current: safeCursor + 1,
            visible: items.length,
            total,
          })}
        </span>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant={keys ? 'primary' : 'outline'}
            aria-pressed={keys}
            onClick={() => wantKeys(!keys)}
          >
            <Keyboard className="h-3 w-3" aria-hidden />
            {t('keys')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label={t('previous')}
            aria-keyshortcuts={keys ? 'ArrowLeft K' : undefined}
            disabled={!place.previous}
            onClick={place.previous}
          >
            <ChevronLeft className="h-3 w-3" aria-hidden />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label={t('next')}
            aria-keyshortcuts={keys ? 'ArrowRight J' : undefined}
            disabled={!place.next}
            onClick={place.next}
          >
            <ChevronRight className="h-3 w-3" aria-hidden />
          </Button>
        </div>
      </div>
      {keys ? (
        <p className="text-xs text-muted-foreground">
          {t.rich('keysLegend', {
            kbd: (key) => (
              <kbd className="rounded border border-border bg-muted px-1 font-mono text-xs text-foreground">
                {key}
              </kbd>
            ),
          })}
        </p>
      ) : null}

      {kind === 'recipe' ? (
        <RecipeReviewCard
          key={(current as RecipeReviewSlice).id}
          slice={current as RecipeReviewSlice}
          locale={locale}
          place={place}
          onReviewed={advance}
        />
      ) : (
        <IngredientNameReviewCard
          key={(current as IngredientNameReviewSlice).id}
          slice={current as IngredientNameReviewSlice}
          locale={locale}
          place={place}
          onReviewed={advance}
        />
      )}
    </div>
  );
}

/**
 * The draft on show, as one thing that can hold the focus: the keys act while
 * it does, and it is named for those who do not see it.
 */
function DraftRegion({
  place,
  act,
  children,
}: {
  place: DraftPlace;
  act: { approve: () => void; reject: () => void; save?: () => void; busy: boolean };
  children: ReactNode;
}) {
  const region = useReviewKeys({
    enabled: place.keys,
    takesFocus: place.takesFocus,
    next: place.next,
    previous: place.previous,
    ...act,
  });
  return (
    <div
      {...region}
      role="group"
      aria-label={place.label}
      // With the keys on, the ring says where they act however the focus came; without them it is the ring of the Tab key.
      className={cn(
        'scroll-mt-4 rounded-lg outline-none',
        place.keys
          ? 'focus:ring-2 focus:ring-ring'
          : 'focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      {children}
    </div>
  );
}

/** The reason of a rejection, the three buttons of a draft, and what came of pressing one. */
function Decide({
  reason,
  onReason,
  dirty,
  saving,
  acting,
  onSave,
  onApprove,
  onReject,
  before,
  keys,
  error,
}: {
  reason: string;
  onReason: (reason: string) => void;
  dirty: boolean;
  saving: boolean;
  acting: 'approve' | 'reject' | null;
  onSave: () => void;
  onApprove: () => void;
  onReject: () => void;
  /** What this language decided about the draft before, when it did. */
  before: ReviewAction | null;
  keys: boolean;
  error: string | null;
}) {
  const t = useTranslations('review');
  const busy = saving || acting !== null;
  return (
    <>
      <textarea
        aria-label={t('rejectReasonPlaceholder')}
        placeholder={t('rejectReasonPlaceholder')}
        value={reason}
        onChange={(e) => onReason(e.target.value)}
        rows={2}
        className="w-full rounded-md border bg-background px-2 py-1 text-sm"
        maxLength={500}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-keyshortcuts={keys ? 'S' : undefined}
          onClick={onSave}
          disabled={!dirty || busy}
        >
          {saving ? t('saving') : t('save')}
        </Button>
        <Button
          type="button"
          size="sm"
          aria-keyshortcuts={keys ? 'A' : undefined}
          onClick={onApprove}
          disabled={busy}
        >
          <Check className="mr-1 h-3 w-3" aria-hidden />
          {acting === 'approve' ? t('working') : t('approve')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="destructive"
          aria-keyshortcuts={keys ? 'R' : undefined}
          onClick={onReject}
          disabled={busy}
        >
          <X className="mr-1 h-3 w-3" aria-hidden />
          {acting === 'reject' ? t('working') : t('reject')}
        </Button>
        {before ? (
          <span className="ml-auto text-xs text-muted-foreground">
            {t('decidedBefore', { action: before })}
          </span>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </>
  );
}

function RecipeReviewCard({
  slice,
  locale,
  place,
  onReviewed,
}: {
  slice: RecipeReviewSlice;
  locale: Locale;
  place: DraftPlace;
  onReviewed: () => void;
}) {
  const t = useTranslations('review');
  const tAllergen = useTranslations('enums.allergen');
  const fmt = useFormat();
  const errorText = useDraftErrorText();
  // What the server holds of the reviewer's text: the draft as it came, then what was last saved.
  const [saved, setSaved] = useState({
    title: slice.title,
    description: slice.description,
    steps: slice.steps,
  });
  const [title, setTitle] = useState(slice.title);
  const [description, setDescription] = useState(slice.description);
  const [steps, setSteps] = useState<string[]>(slice.steps);
  const [saving, setSaving] = useState(false);
  const [acting, setActing] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const dirty =
    title !== saved.title || description !== saved.description || stepsChanged(steps, saved.steps);

  /** Whether the text was saved: a decision is not taken on text the server does not hold. */
  const save = async (): Promise<boolean> => {
    setSaving(true);
    setError(null);
    try {
      await reviewApi.patchRecipeSlice(locale, slice.id, {
        title: title !== saved.title ? title : undefined,
        description: description !== saved.description ? description : undefined,
        steps: stepsChanged(steps, saved.steps) ? steps : undefined,
      });
      setSaved({ title, description, steps });
      return true;
    } catch (err) {
      setError(errorText(err, t('saveFailed')));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const approve = async (): Promise<void> => {
    setActing('approve');
    setError(null);
    try {
      if (dirty && !(await save())) return;
      await reviewApi.approveRecipe(locale, slice.id);
      onReviewed();
    } catch (err) {
      setError(errorText(err, t('approveFailed')));
    } finally {
      setActing(null);
    }
  };

  const reject = async (): Promise<void> => {
    setActing('reject');
    setError(null);
    try {
      await reviewApi.rejectRecipe(locale, slice.id, reason || undefined);
      onReviewed();
    } catch (err) {
      setError(errorText(err, t('rejectFailed')));
    } finally {
      setActing(null);
    }
  };

  // A code this version has no name for is shown as it is.
  const allergens = slice.allergens.map((code) =>
    (ALLERGENS as readonly string[]).includes(code) ? tAllergen(code as Allergen) : code,
  );

  return (
    <DraftRegion
      place={place}
      act={{
        approve: () => void approve(),
        reject: () => void reject(),
        save: dirty ? () => void save() : undefined,
        busy: saving || acting !== null,
      }}
    >
      <Card>
        <CardContent className="space-y-6 py-6">
          <div className="grid gap-4 lg:grid-cols-2">
            <section className="space-y-3">
              <SectionHeader label={t('targetLabel', { locale: t(`locales.${locale}`) })} />
              <LabeledInput label={t('fieldTitle')} value={title} onChange={setTitle} />
              <LabeledTextarea
                label={t('fieldDescription')}
                value={description}
                onChange={setDescription}
              />
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">{t('fieldSteps')}</p>
                {steps.map((step, i) => (
                  <textarea
                    key={i}
                    aria-label={t('fieldStep', { number: i + 1 })}
                    value={step}
                    onChange={(e) => {
                      const next = [...steps];
                      next[i] = e.target.value;
                      setSteps(next);
                    }}
                    className="w-full rounded-md border bg-background px-2 py-1 text-sm"
                    rows={2}
                  />
                ))}
              </div>
            </section>

            <section className="space-y-3">
              <SectionHeader label={t('sourceLabel')} />
              <ReadOnlyField label={t('fieldTitle')} value={slice.titleSource} />
              <ReadOnlyField label={t('fieldDescription')} value={slice.descriptionSource} />
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">{t('fieldSteps')}</p>
                <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
                  {slice.stepsSource.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ol>
              </div>
            </section>
          </div>

          <section className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
            <Stat
              label={t('statCalories')}
              value={`${fmt.number(slice.caloriesPerServing)} kcal`}
            />
            <Stat label={t('statProtein')} value={fmt.unit(slice.proteinPerServing, 'gram', 1)} />
            <Stat label={t('statFat')} value={fmt.unit(slice.fatPerServing, 'gram', 1)} />
            <Stat label={t('statCarbs')} value={fmt.unit(slice.carbsPerServing, 'gram', 1)} />
            <Stat
              label={t('statPrepCook')}
              value={`${fmt.number(slice.prepMinutes)} + ${fmt.unit(slice.cookMinutes, 'minute')}`}
            />
            <Stat label={t('statServings')} value={String(slice.servings)} />
          </section>

          {allergens.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              {t('allergens')}: {fmt.list(allergens)}
            </p>
          ) : null}

          <Decide
            reason={reason}
            onReason={setReason}
            dirty={dirty}
            saving={saving}
            acting={acting}
            onSave={() => void save()}
            onApprove={() => void approve()}
            onReject={() => void reject()}
            before={slice.alreadyReviewedAction}
            keys={place.keys}
            error={error}
          />
        </CardContent>
      </Card>
    </DraftRegion>
  );
}

function IngredientNameReviewCard({
  slice,
  locale,
  place,
  onReviewed,
}: {
  slice: IngredientNameReviewSlice;
  locale: Locale;
  place: DraftPlace;
  onReviewed: () => void;
}) {
  const t = useTranslations('review');
  const errorText = useDraftErrorText();
  // What the server holds of the reviewer's text: the draft as it came, then what was last saved.
  const [saved, setSaved] = useState({ name: slice.name, storageHint: slice.storageHint ?? '' });
  const [name, setName] = useState(slice.name);
  const [storageHint, setStorageHint] = useState(slice.storageHint ?? '');
  const [saving, setSaving] = useState(false);
  const [acting, setActing] = useState<'approve' | 'reject' | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const dirty = name !== saved.name || storageHint !== saved.storageHint;

  /** Whether the text was saved: a decision is not taken on text the server does not hold. */
  const save = async (): Promise<boolean> => {
    setSaving(true);
    setError(null);
    try {
      await reviewApi.patchIngredientNameSlice(locale, slice.id, {
        name: name !== saved.name ? name : undefined,
        storageHint: storageHint !== saved.storageHint ? storageHint : undefined,
      });
      setSaved({ name, storageHint });
      return true;
    } catch (err) {
      setError(errorText(err, t('saveFailed')));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const approve = async (): Promise<void> => {
    setActing('approve');
    setError(null);
    try {
      if (dirty && !(await save())) return;
      await reviewApi.approveIngredientName(locale, slice.id);
      onReviewed();
    } catch (err) {
      setError(errorText(err, t('approveFailed')));
    } finally {
      setActing(null);
    }
  };

  const reject = async (): Promise<void> => {
    setActing('reject');
    setError(null);
    try {
      await reviewApi.rejectIngredientName(locale, slice.id, reason || undefined);
      onReviewed();
    } catch (err) {
      setError(errorText(err, t('rejectFailed')));
    } finally {
      setActing(null);
    }
  };

  return (
    <DraftRegion
      place={place}
      act={{
        approve: () => void approve(),
        reject: () => void reject(),
        save: dirty ? () => void save() : undefined,
        busy: saving || acting !== null,
      }}
    >
      <Card>
        <CardContent className="space-y-4 py-6">
          <p className="text-xs text-muted-foreground">
            <span className="font-medium">{t('rawDescription')}:</span> {slice.rawDescription}
          </p>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="space-y-3">
              <SectionHeader label={t('targetLabel', { locale: t(`locales.${locale}`) })} />
              <LabeledInput label={t('fieldName')} value={name} onChange={setName} />
              <LabeledInput
                label={t('fieldStorageHint')}
                value={storageHint}
                onChange={setStorageHint}
              />
            </section>
            <section className="space-y-3">
              <SectionHeader label={t('sourceLabel')} />
              <ReadOnlyField label={t('fieldName')} value={slice.nameSource} />
              <ReadOnlyField label={t('fieldStorageHint')} value={slice.storageHintSource ?? '—'} />
            </section>
          </div>

          <Decide
            reason={reason}
            onReason={setReason}
            dirty={dirty}
            saving={saving}
            acting={acting}
            onSave={() => void save()}
            onApprove={() => void approve()}
            onReject={() => void reject()}
            before={slice.alreadyReviewedAction}
            keys={place.keys}
            error={error}
          />
        </CardContent>
      </Card>
    </DraftRegion>
  );
}

function SectionHeader({ label }: { label: string }) {
  return (
    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border bg-background px-2 py-1 text-sm"
      />
    </label>
  );
}

function LabeledTextarea({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        className="w-full rounded-md border bg-background px-2 py-1 text-sm"
      />
    </label>
  );
}

function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="rounded-md bg-muted/30 px-2 py-1 text-sm text-muted-foreground">{value}</p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-muted/20 px-2 py-1">
      <p className="text-2xs uppercase tracking-wide">{label}</p>
      <p className="text-sm text-foreground">{value}</p>
    </div>
  );
}

function stepsChanged(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return true;
  return a.some((s, i) => s !== b[i]);
}
