'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Loader2, X } from 'lucide-react';
import type {
  IngredientNameReviewSlice,
  Locale,
  RecipeReviewSlice,
} from '@diet-app/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { reviewApi } from '@/lib/review-api';

interface QueueProps {
  locale: Locale;
  kind: 'recipe' | 'ingredient-name';
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
  // `itemsKind` is the kind the current `items` were fetched for. If it
  // doesn't match the prop, the data is stale (mid-switch) and we must treat
  // the queue as still loading — otherwise we'd cast e.g. an ingredient-name
  // slice to a recipe slice and crash on the missing `.steps` field.
  const [items, setItems] = useState<
    RecipeReviewSlice[] | IngredientNameReviewSlice[] | null
  >(null);
  const [itemsKind, setItemsKind] = useState<QueueProps['kind'] | null>(null);
  const [cursor, setCursor] = useState(0);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

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
      setError(err instanceof Error ? err.message : t('queueFailed'));
      setItems([]);
      setItemsKind(kind);
    }
  }, [kind, locale, t]);

  useEffect(() => {
    void (async () => {
      setItems(null);
      setItemsKind(null);
      await fetchPage();
    })();
  }, [fetchPage]);

  if (items === null || itemsKind !== kind) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
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
    setItems(next as typeof items);
    setTotal((n) => Math.max(0, n - 1));
    if (next.length === 0) {
      // Page exhausted — pull a fresh one.
      void fetchPage();
    } else {
      setCursor((c) => Math.min(c, next.length - 1));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
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
            variant="outline"
            disabled={safeCursor === 0}
            onClick={() => setCursor((c) => Math.max(0, c - 1))}
          >
            <ChevronLeft className="h-3 w-3" />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={safeCursor === items.length - 1}
            onClick={() => setCursor((c) => Math.min(items.length - 1, c + 1))}
          >
            <ChevronRight className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {kind === 'recipe' ? (
        <RecipeReviewCard
          key={(current as RecipeReviewSlice).id}
          slice={current as RecipeReviewSlice}
          locale={locale}
          onReviewed={advance}
        />
      ) : (
        <IngredientNameReviewCard
          key={(current as IngredientNameReviewSlice).id}
          slice={current as IngredientNameReviewSlice}
          locale={locale}
          onReviewed={advance}
        />
      )}
    </div>
  );
}

function RecipeReviewCard({
  slice,
  locale,
  onReviewed,
}: {
  slice: RecipeReviewSlice;
  locale: Locale;
  onReviewed: () => void;
}) {
  const t = useTranslations('review');
  const [title, setTitle] = useState(slice.title);
  const [description, setDescription] = useState(slice.description);
  const [steps, setSteps] = useState<string[]>(slice.steps);
  const [saving, setSaving] = useState(false);
  const [acting, setActing] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const dirty =
    title !== slice.title ||
    description !== slice.description ||
    steps.length !== slice.steps.length ||
    steps.some((s, i) => s !== slice.steps[i]);

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await reviewApi.patchRecipeSlice(locale, slice.id, {
        title: title !== slice.title ? title : undefined,
        description: description !== slice.description ? description : undefined,
        steps: stepsChanged(steps, slice.steps) ? steps : undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const approve = async (): Promise<void> => {
    setActing('approve');
    setError(null);
    try {
      if (dirty) await save();
      await reviewApi.approveRecipe(locale, slice.id);
      onReviewed();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('approveFailed'));
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
      setError(err instanceof Error ? err.message : t('rejectFailed'));
    } finally {
      setActing(null);
    }
  };

  return (
    <Card>
      <CardContent className="space-y-6 py-6">
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="space-y-3">
            <SectionHeader label={t('targetLabel', { locale })} />
            <LabeledInput
              label={t('fieldTitle')}
              value={title}
              onChange={setTitle}
            />
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
          <Stat label={t('statCalories')} value={`${Math.round(slice.caloriesPerServing)} kcal`} />
          <Stat label={t('statProtein')} value={`${slice.proteinPerServing.toFixed(1)} g`} />
          <Stat label={t('statFat')} value={`${slice.fatPerServing.toFixed(1)} g`} />
          <Stat label={t('statCarbs')} value={`${slice.carbsPerServing.toFixed(1)} g`} />
          <Stat
            label={t('statPrepCook')}
            value={`${slice.prepMinutes}+${slice.cookMinutes} min`}
          />
          <Stat label={t('statServings')} value={String(slice.servings)} />
        </section>

        {slice.allergens.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            {t('allergens')}: {slice.allergens.join(', ')}
          </p>
        ) : null}

        <textarea
          placeholder={t('rejectReasonPlaceholder')}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          className="w-full rounded-md border bg-background px-2 py-1 text-sm"
          maxLength={500}
        />

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void save()}
            disabled={!dirty || saving}
          >
            {saving ? t('saving') : t('save')}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void approve()}
            disabled={acting !== null}
          >
            <Check className="mr-1 h-3 w-3" />
            {acting === 'approve' ? t('working') : t('approve')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            onClick={() => void reject()}
            disabled={acting !== null}
          >
            <X className="mr-1 h-3 w-3" />
            {acting === 'reject' ? t('working') : t('reject')}
          </Button>
          {slice.alreadyReviewed ? (
            <span className="ml-auto text-xs text-muted-foreground">
              {t('alreadyReviewed', { action: slice.alreadyReviewedAction ?? '' })}
            </span>
          ) : null}
        </div>

        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </CardContent>
    </Card>
  );
}

function IngredientNameReviewCard({
  slice,
  locale,
  onReviewed,
}: {
  slice: IngredientNameReviewSlice;
  locale: Locale;
  onReviewed: () => void;
}) {
  const t = useTranslations('review');
  const [name, setName] = useState(slice.name);
  const [storageHint, setStorageHint] = useState(slice.storageHint ?? '');
  const [saving, setSaving] = useState(false);
  const [acting, setActing] = useState<'approve' | 'reject' | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const dirty = name !== slice.name || storageHint !== (slice.storageHint ?? '');

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await reviewApi.patchIngredientNameSlice(locale, slice.id, {
        name: name !== slice.name ? name : undefined,
        storageHint: storageHint !== (slice.storageHint ?? '') ? storageHint : undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const approve = async (): Promise<void> => {
    setActing('approve');
    setError(null);
    try {
      if (dirty) await save();
      await reviewApi.approveIngredientName(locale, slice.id);
      onReviewed();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('approveFailed'));
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
      setError(err instanceof Error ? err.message : t('rejectFailed'));
    } finally {
      setActing(null);
    }
  };

  return (
    <Card>
      <CardContent className="space-y-4 py-6">
        <p className="text-xs text-muted-foreground">
          <span className="font-medium">{t('rawDescription')}:</span> {slice.rawDescription}
        </p>

        <div className="grid gap-4 lg:grid-cols-2">
          <section className="space-y-3">
            <SectionHeader label={t('targetLabel', { locale })} />
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
            <ReadOnlyField
              label={t('fieldStorageHint')}
              value={slice.storageHintSource ?? '—'}
            />
          </section>
        </div>

        <textarea
          placeholder={t('rejectReasonPlaceholder')}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          className="w-full rounded-md border bg-background px-2 py-1 text-sm"
          maxLength={500}
        />

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void save()}
            disabled={!dirty || saving}
          >
            {saving ? t('saving') : t('save')}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void approve()}
            disabled={acting !== null}
          >
            <Check className="mr-1 h-3 w-3" />
            {acting === 'approve' ? t('working') : t('approve')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            onClick={() => void reject()}
            disabled={acting !== null}
          >
            <X className="mr-1 h-3 w-3" />
            {acting === 'reject' ? t('working') : t('reject')}
          </Button>
          {slice.alreadyReviewed ? (
            <span className="ml-auto text-xs text-muted-foreground">
              {t('alreadyReviewed', { action: slice.alreadyReviewedAction ?? '' })}
            </span>
          ) : null}
        </div>

        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </CardContent>
    </Card>
  );
}

function SectionHeader({ label }: { label: string }) {
  return <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>;
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
      <p className="text-[10px] uppercase tracking-wide">{label}</p>
      <p className="text-sm text-foreground">{value}</p>
    </div>
  );
}

function stepsChanged(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return true;
  return a.some((s, i) => s !== b[i]);
}
