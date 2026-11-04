// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import type { Recipe, RecipeTextRequest } from '@diet-app/shared';
import { RECIPE_LIMITS } from '@diet-app/shared/constants';
import { api } from '@/lib/api';
import { useErrorText } from '@/lib/use-error-text';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { StepsField } from '@/components/steps-field';

/** The fields of the window, filled once the recipe is read. */
function TextForm({
  recipe,
  onClose,
  onSaved,
}: {
  recipe: Recipe;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations('mealPlans');
  const tRecipe = useTranslations('ownRecipe');
  const tDetail = useTranslations('recipeDetail');
  const tCommon = useTranslations('common');
  const errorText = useErrorText();
  const qc = useQueryClient();
  const [title, setTitle] = useState(recipe.title);
  const [description, setDescription] = useState(recipe.description);
  const [steps, setSteps] = useState<string[]>(recipe.steps);
  const save = useMutation({
    mutationFn: (body: RecipeTextRequest) => api.put<Recipe>(`/recipes/${recipe.id}/text`, body),
    onSuccess: (saved) => {
      qc.setQueryData(['recipe', recipe.id], saved);
      onSaved();
    },
  });
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    save.mutate({ title, description, steps: steps.filter((step) => step.trim() !== '') });
  };
  return (
    <form className="space-y-4 p-4" onSubmit={submit}>
      <p className="text-xs text-muted-foreground">{t('rewordIntro')}</p>
      <Field label={tRecipe('fieldTitle')}>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={RECIPE_LIMITS.title}
          required
        />
      </Field>
      <Field label={tRecipe('fieldDescription')}>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={RECIPE_LIMITS.description}
          required
          rows={3}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
      </Field>
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">{tDetail('steps')}</legend>
        <StepsField steps={steps} onChange={setSteps} />
      </fieldset>
      {save.isError && (
        <p role="alert" className="text-xs text-destructive">
          {errorText(save.error)}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {tCommon('cancel')}
        </Button>
        <Button type="submit" size="sm" disabled={save.isPending}>
          {tCommon('save')}
        </Button>
      </div>
    </form>
  );
}

/**
 * The window the words of a recipe made by swapping an ingredient are
 * corrected in, in the reader's language: its title, description and steps.
 * They are written in that recipe, so the plans that hold it read them at
 * once; its ingredients and nutrition stay as they are.
 */
export function RecipeTextDialog({
  recipeId,
  onClose,
  onSaved,
}: {
  recipeId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations('mealPlans');
  const tCommon = useTranslations('common');
  const errorText = useErrorText();
  const recipe = useQuery({
    queryKey: ['recipe', recipeId],
    queryFn: () => api.get<Recipe>(`/recipes/${recipeId}`),
  });
  return (
    <Dialog open onClose={onClose} label={t('rewordTitle')} className="max-w-lg">
      <div className="flex items-center justify-between border-b border-border p-4">
        <h2 className="font-semibold">{t('rewordTitle')}</h2>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {tCommon('close')}
        </Button>
      </div>
      {recipe.data ? (
        <TextForm recipe={recipe.data} onClose={onClose} onSaved={onSaved} />
      ) : recipe.isError ? (
        <p role="alert" className="p-4 text-sm text-destructive">
          {errorText(recipe.error)}
        </p>
      ) : (
        <Skeleton className="m-4 h-64" />
      )}
    </Dialog>
  );
}
