// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { PlannedMeal, Recipe } from '@diet-app/shared';
import { cn } from '@/lib/utils';

/**
 * What a model had to do with what the mark stands on: it chose the recipe of
 * a meal (and may have said why), it wrote a recipe, it had a part in a
 * recipe of the user's, or parts of a plan were chosen with its help.
 */
export type ModelPart = { kind: 'picked'; reason: string | null } | { kind: 'written' } | { kind: 'changed' } | { kind: 'plan' };

/** A model's part in a recipe, as the recipe says it, or null. */
export const partInRecipe = (recipe: Pick<Recipe, 'byModel'> | null | undefined): ModelPart | null => (recipe?.byModel ? { kind: recipe.byModel } : null);

/**
 * A model's part in a planned meal, or null: that it chose the meal's recipe
 * comes first, since that is about this meal; what it had to do with the
 * recipe itself is said where the recipe is shown.
 */
export const partInMeal = (meal: Pick<PlannedMeal, 'modelPick'> & { recipe: Pick<Recipe, 'byModel'> | null }): ModelPart | null =>
  meal.modelPick ? { kind: 'picked', reason: meal.modelPick.reason } : partInRecipe(meal.recipe);

/** The sentence that says what a model did. */
export function useModelPartText(): (part: ModelPart) => string {
  const t = useTranslations('aiMark');
  return (part) => (part.kind === 'picked' ? (part.reason ? t('pickedWhy', { reason: part.reason }) : t('picked')) : t(part.kind));
}

/**
 * The mark that a model had a part in something: on a meal of a plan, a
 * recipe, a plan. The chip says "AI-assisted"; what the model did is read out
 * with it and shown on hover, and with `spelledOut` stands beside it as a
 * sentence, where there is room for one (a recipe's own page and window).
 */
export function AiMark({ part, spelledOut = false, className }: { part: ModelPart; spelledOut?: boolean; className?: string }) {
  const t = useTranslations('aiMark');
  const said = useModelPartText()(part);
  const chip = (
    <span
      title={spelledOut ? undefined : said}
      className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-foreground', !spelledOut && className)}
    >
      <Sparkles size={10} className="text-primary" aria-hidden />
      {t('label')}
      {!spelledOut && <span className="sr-only">: {said}</span>}
    </span>
  );
  if (!spelledOut) return chip;
  return (
    <p className={cn('flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground', className)}>
      {chip}
      <span>{said}</span>
    </p>
  );
}
