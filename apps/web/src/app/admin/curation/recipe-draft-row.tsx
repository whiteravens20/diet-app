// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

/** One recipe draft: what it is, as it is read and as it is edited, with its reviews. */
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { Cuisine } from '@diet-app/shared';
import { CUISINES } from '@diet-app/shared/constants';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  adminApi,
  type RecipeDraft,
  type RecipeDraftIngredientLine,
  type RecipeDraftPatch,
} from '@/lib/admin-api';
import { useDraftErrorText, useSkipReasonText } from '@/lib/use-draft-error';
import { useFormat } from '@/lib/use-format';
import { LocaleReviewMatrix } from './locale-review-matrix';

export function RecipeDraftRow({
  draft,
  onChanged,
}: {
  draft: RecipeDraft;
  onChanged: () => void;
}) {
  const t = useTranslations('admin.curation');
  const tCuisine = useTranslations('enums.cuisine');
  const errorText = useDraftErrorText();
  const tErrors = useTranslations('errors');
  const skipReason = useSkipReasonText();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<{
    titles: Record<string, string>;
    descriptions: Record<string, string>;
    steps: Record<string, string[]>;
    servings: number;
    prepMinutes: number;
    cookMinutes: number;
    ingredients: RecipeDraftIngredientLine[];
  }>({
    titles: draft.titles,
    descriptions: draft.descriptions,
    steps: draft.steps,
    servings: draft.servings,
    prepMinutes: draft.prepMinutes,
    cookMinutes: draft.cookMinutes,
    ingredients: draft.ingredients,
  });
  const [preview, setPreview] = useState<{
    caloriesPerServing: number;
    proteinPerServing: number;
    fatPerServing: number;
    carbsPerServing: number;
    allergens: string[];
    complexity: string;
  } | null>(null);

  // What the API refused, in the reader's language: each rule the edit broke,
  // else the text of the refusal's code.
  const messageFor = (err: unknown): string => errorText(err, String(err));

  /** Run a change to the draft; true when it went through. */
  const handle = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setWorking(true);
    setError(null);
    try {
      await fn();
      onChanged();
      return true;
    } catch (err) {
      setError(messageFor(err));
      return false;
    } finally {
      setWorking(false);
    }
  };

  // For AI_USER drafts the structural fields are read-only — sending them
  // would trip the backend's `DRAFT_STRUCTURAL_EDIT_FORBIDDEN` guard even
  // when the values haven't changed, so we strip them from the patch payload.
  // Admin-batch drafts (`AI` / `EXTERNAL` / `MANUAL`) still send everything.
  const buildPatch = (): RecipeDraftPatch =>
    lockStructural
      ? {
          titles: edit.titles,
          descriptions: edit.descriptions,
          steps: edit.steps,
        }
      : {
          titles: edit.titles,
          descriptions: edit.descriptions,
          steps: edit.steps,
          servings: edit.servings,
          prepMinutes: edit.prepMinutes,
          cookMinutes: edit.cookMinutes,
          ingredients: edit.ingredients,
        };

  const runDryRun = async () => {
    setError(null);
    try {
      const next = await adminApi.patchRecipeDraft(draft.id, buildPatch(), true);
      setPreview({
        caloriesPerServing: next.caloriesPerServing,
        proteinPerServing: next.proteinPerServing,
        fatPerServing: next.fatPerServing,
        carbsPerServing: next.carbsPerServing,
        allergens: next.allergens,
        complexity: next.complexity,
      });
    } catch (err) {
      setError(messageFor(err));
    }
  };

  const onSave = () => {
    // A refused edit stays in the form: what was typed is not thrown away.
    void handle(() => adminApi.patchRecipeDraft(draft.id, buildPatch(), false)).then((saved) => {
      if (!saved) return;
      setEditing(false);
      setPreview(null);
    });
  };

  const onCancelEdit = () => {
    setEdit({
      titles: draft.titles,
      descriptions: draft.descriptions,
      steps: draft.steps,
      servings: draft.servings,
      prepMinutes: draft.prepMinutes,
      cookMinutes: draft.cookMinutes,
      ingredients: draft.ingredients,
    });
    setPreview(null);
    setEditing(false);
  };

  // What each language was last decided: taking the same decision again would only ask for a name and say it twice.
  const decided = new Map(draft.localeReviews.map((review) => [review.locale, review.action]));
  const onApprove = (locale: string) => {
    const label = window.prompt(t('reviewLabelPrompt'));
    if (!label) return;
    void handle(() => adminApi.approveRecipeDraft(draft.id, locale, label));
  };
  const onReject = (locale: string) => {
    const label = window.prompt(t('reviewLabelPrompt'));
    if (!label) return;
    const reason = window.prompt(t('rejectReasonPrompt')) ?? undefined;
    void handle(() => adminApi.rejectRecipeDraft(draft.id, locale, label, reason));
  };
  const onDelete = () => {
    if (!window.confirm(t('deleteConfirm'))) return;
    void handle(() => adminApi.deleteRecipeDraft(draft.id));
  };
  const onPromote = () => {
    if (!window.confirm(t('promoteConfirm'))) return;
    void handle(() => adminApi.promoteRecipeDraft(draft.id));
  };
  // The slug alone: the reviews stand, since no reviewer approved a slug.
  const onChangeSlug = () => {
    const slug = window.prompt(t('slugPrompt'), draft.slug)?.trim();
    if (!slug || slug === draft.slug) return;
    void handle(() => adminApi.patchRecipeDraft(draft.id, { slug }, false));
  };

  // The cuisine alone: like the slug it is no part of what the reviewers approved.
  const onChangeCuisine = (cuisine: Cuisine | null) => {
    void handle(() => adminApi.patchRecipeDraft(draft.id, { cuisine }, false));
  };

  // AI_USER drafts mirror personal Recipe rows owned by the user. Editing
  // structural fields would invalidate the fingerprint + the linked Recipe's
  // nutrition recompute, so the editor locks ingredients / servings / times
  // and the only way to restructure is to promote-then-edit-curated.
  const isUserDraft = draft.source === 'AI_USER';
  const lockStructural = isUserDraft;
  const canPromote = isUserDraft && draft.status === 'APPROVED';

  const nutr = preview ?? draft;

  return (
    <li className="rounded-md border border-border p-3 text-sm">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full flex-wrap items-start justify-between gap-2 text-left"
      >
        <div className="min-w-0 flex-1">
          <p className="font-medium">{draft.titles.en}</p>
          <p className="text-xs text-muted-foreground">{draft.descriptions.en}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isUserDraft && (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-foreground">
              {t('sourceUserBadge')}
            </span>
          )}
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs">
            {t(`complexity_${draft.complexity}`)}
          </span>
          <LocaleReviewMatrix
            expectedLocales={draft.locales}
            localeReviews={draft.localeReviews}
            status={draft.status}
            compact
          />
        </div>
      </button>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          {t('nutritionStrip', {
            kcal: nutr.caloriesPerServing,
            protein: nutr.proteinPerServing,
            fat: nutr.fatPerServing,
            carbs: nutr.carbsPerServing,
          })}
        </span>
        <span>{t('servings', { count: draft.servings })}</span>
        <span>{t('timeStrip', { prep: draft.prepMinutes, cook: draft.cookMinutes })}</span>
        {draft.allergens.length > 0 && (
          <span>{t('allergensLabel', { list: draft.allergens.join(', ') })}</span>
        )}
        <span className="font-mono">{t('slugStrip', { slug: draft.slug })}</span>
      </div>

      {expanded && (
        <div className="mt-3 space-y-3 border-t border-border pt-3">
          {editing ? (
            <RecipeEditor
              edit={edit}
              locales={draft.locales}
              onChange={setEdit}
              onDryRun={runDryRun}
              lockStructural={lockStructural}
            />
          ) : (
            <RecipePreview draft={draft} />
          )}
          {isUserDraft && (
            <p className="text-xs text-muted-foreground italic">{t('userDraftHint')}</p>
          )}
          {/* Said before the press, which would only be refused. */}
          {canPromote && draft.libraryBlock && (
            <div className="space-y-1 rounded-md border border-warning/40 bg-warning/5 px-2 py-1 text-xs">
              <p>{`${tErrors('DRAFT_NOT_SHIPPABLE')} ${skipReason(draft.libraryBlock)}`}</p>
              {draft.libraryBlock.startsWith('unknown-slug-at-ship') && (
                <p className="text-muted-foreground">{t('promoteBlockedHint')}</p>
              )}
            </div>
          )}

          {error && (
            <p className="rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1 text-xs">
              {error}
            </p>
          )}

          <LocaleReviewMatrix
            expectedLocales={draft.locales}
            localeReviews={draft.localeReviews}
            pastReviews={draft.pastReviews}
            status={draft.status}
          />

          <div className="flex flex-wrap items-center gap-2">
            {editing ? (
              <>
                <Button size="sm" disabled={working} onClick={onSave}>
                  {t('save')}
                </Button>
                <Button size="sm" variant="outline" disabled={working} onClick={onCancelEdit}>
                  {t('cancel')}
                </Button>
              </>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={working || draft.status === 'SHIPPED'}
                  onClick={() => setEditing(true)}
                >
                  {t('edit')}
                </Button>
                {draft.status !== 'SHIPPED' &&
                  draft.locales.map((locale) => (
                    <span key={locale} className="flex items-center gap-1">
                      <Button
                        size="sm"
                        disabled={working || decided.get(locale) === 'APPROVE'}
                        onClick={() => onApprove(locale)}
                      >
                        {t('approve')} · {locale}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={working || decided.get(locale) === 'REJECT'}
                        onClick={() => onReject(locale)}
                      >
                        {t('reject')} · {locale}
                      </Button>
                    </span>
                  ))}
                {canPromote && (
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={working || Boolean(draft.libraryBlock)}
                    onClick={onPromote}
                  >
                    {t('promoteButton')}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={working || draft.status === 'SHIPPED'}
                  onClick={onChangeSlug}
                >
                  {t('changeSlug')}
                </Button>
                {/* The cuisine the recipe ships with: profiles that like it get the recipe a little more often. */}
                <select
                  aria-label={t('cuisine')}
                  className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                  value={draft.cuisine ?? ''}
                  disabled={working || draft.status === 'SHIPPED'}
                  onChange={(e) =>
                    onChangeCuisine(e.target.value ? (e.target.value as Cuisine) : null)
                  }
                >
                  <option value="">{t('cuisineNone')}</option>
                  {CUISINES.map((cuisine) => (
                    <option key={cuisine} value={cuisine}>
                      {t('cuisineOf', { cuisine: tCuisine(cuisine) })}
                    </option>
                  ))}
                </select>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={working || draft.status === 'SHIPPED'}
                  onClick={onDelete}
                >
                  {t('deleteAction')}
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

function RecipePreview({ draft }: { draft: RecipeDraft }) {
  const t = useTranslations('admin.curation');
  const fmt = useFormat();
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {draft.locales.map((locale) => (
        <div key={locale} className="space-y-1">
          <p className="text-xs text-muted-foreground">{locale}</p>
          <p className="font-medium">{draft.titles[locale] ?? '—'}</p>
          <p className="text-xs">{draft.descriptions[locale] ?? '—'}</p>
          <ol className="ml-4 list-decimal text-xs">
            {(draft.steps[locale] ?? []).map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </div>
      ))}
      <div className="md:col-span-2">
        <p className="text-xs text-muted-foreground">{t('ingredientsLabel')}</p>
        <ul className="ml-4 list-disc text-xs">
          {draft.ingredients.map((ing, i) => (
            <li key={`${ing.slug}-${i}`}>
              <code>{ing.slug}</code> — {fmt.number(ing.quantity, 2)} {ing.unit}
              {ing.note ? ` (${ing.note})` : ''}
            </li>
          ))}
        </ul>
      </div>
      {/* A draft that was taken in from elsewhere: where from, and the licence it ships with. Written as text: an address is no link until a person has looked at it. */}
      {draft.provenanceLicense && (
        <p className="break-all text-xs text-muted-foreground md:col-span-2">
          {draft.provenanceUrl
            ? t('importedFrom', { source: draft.provenanceUrl, licence: draft.provenanceLicense })
            : t('importedLicence', { licence: draft.provenanceLicense })}
        </p>
      )}
    </div>
  );
}

function RecipeEditor({
  edit,
  locales,
  onChange,
  onDryRun,
  lockStructural = false,
}: {
  edit: {
    titles: Record<string, string>;
    descriptions: Record<string, string>;
    steps: Record<string, string[]>;
    servings: number;
    prepMinutes: number;
    cookMinutes: number;
    ingredients: RecipeDraftIngredientLine[];
  };
  locales: string[];
  onChange: (next: typeof edit) => void;
  onDryRun: () => void;
  /** AI_USER drafts allow translation edits only; structural fields lock. */
  lockStructural?: boolean;
}) {
  const t = useTranslations('admin.curation');

  const updateTitle = (locale: string, v: string) =>
    onChange({ ...edit, titles: { ...edit.titles, [locale]: v } });
  const updateDescription = (locale: string, v: string) =>
    onChange({ ...edit, descriptions: { ...edit.descriptions, [locale]: v } });
  const updateStep = (locale: string, idx: number, v: string) => {
    const next = [...(edit.steps[locale] ?? [])];
    next[idx] = v;
    onChange({ ...edit, steps: { ...edit.steps, [locale]: next } });
  };
  const updateIngredient = (idx: number, patch: Partial<RecipeDraftIngredientLine>) => {
    const next = edit.ingredients.map((line, i) => (i === idx ? { ...line, ...patch } : line));
    onChange({ ...edit, ingredients: next });
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        {locales.map((locale) => (
          <div key={locale} className="space-y-1">
            <label className="text-xs text-muted-foreground">
              {t('title')} · {locale}
            </label>
            <Input
              value={edit.titles[locale] ?? ''}
              onChange={(e) => updateTitle(locale, e.target.value)}
            />
            <label className="text-xs text-muted-foreground">
              {t('descriptionLabel')} · {locale}
            </label>
            <Input
              value={edit.descriptions[locale] ?? ''}
              onChange={(e) => updateDescription(locale, e.target.value)}
            />
            <label className="text-xs text-muted-foreground">
              {t('stepsLabel')} · {locale}
            </label>
            {(edit.steps[locale] ?? []).map((step, i) => (
              <Input key={i} value={step} onChange={(e) => updateStep(locale, i, e.target.value)} />
            ))}
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-2 text-xs">
        <span className="text-muted-foreground">{t('servings', { count: edit.servings })}</span>
        <Input
          type="number"
          min={1}
          value={edit.servings}
          onChange={(e) => onChange({ ...edit, servings: Number(e.target.value) || 1 })}
          className="w-16"
          disabled={lockStructural}
        />
        <span className="text-muted-foreground">{t('prepMinutesLabel')}</span>
        <Input
          type="number"
          min={0}
          value={edit.prepMinutes}
          onChange={(e) => onChange({ ...edit, prepMinutes: Number(e.target.value) || 0 })}
          className="w-16"
          disabled={lockStructural}
        />
        <span className="text-muted-foreground">{t('cookMinutesLabel')}</span>
        <Input
          type="number"
          min={0}
          value={edit.cookMinutes}
          onChange={(e) => onChange({ ...edit, cookMinutes: Number(e.target.value) || 0 })}
          className="w-16"
          disabled={lockStructural}
        />
      </div>

      <div>
        <p className="text-xs text-muted-foreground">{t('ingredientsLabel')}</p>
        <ul className="space-y-1">
          {edit.ingredients.map((line, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2 text-xs">
              <code className="flex-1">{line.slug}</code>
              <Input
                type="number"
                min={0}
                step="any"
                value={line.quantity}
                onChange={(e) => updateIngredient(i, { quantity: Number(e.target.value) || 0 })}
                className="w-20"
                disabled={lockStructural}
              />
              <span className="text-muted-foreground">{line.unit}</span>
            </li>
          ))}
        </ul>
      </div>

      <Button size="sm" variant="outline" onClick={onDryRun} disabled={lockStructural}>
        {t('recompute')}
      </Button>
    </div>
  );
}
