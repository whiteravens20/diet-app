// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import {
  fitsDiet,
  type AddCustomMealRequest,
  type AiMealSwapPreview,
  type MealPlan,
  type MealPlanSummary,
  type MealSwapPreview,
  type PantryUse,
  type PlannedIngredient,
  type PlanRelaxation,
  type SwapIngredientResponse,
} from '@diet-app/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ApplyFavoriteSetButton } from '@/components/apply-favorite-set-button';
import { IngredientSubstituteModal } from '@/components/ingredient-substitute-modal';
import { RecipeModal } from '@/components/recipe-modal';
import { AiMark, partInMeal } from '@/components/ai-mark';
import { CustomMealModal } from './custom-meal-modal';
import { RerollDialog, type RerollAsked, type RerollStart } from './reroll-dialog';
import { useFormat } from '@/lib/use-format';

interface FavoriteOption {
  recipe: { id: string; title: string; mealTypes: string[]; dietTags: string[] };
}

type PlannedMealView = MealPlan['days'][number]['meals'][number];
/** A catalogue meal, narrowed so its recipe is guaranteed present. */
type CatalogueMeal = PlannedMealView & { recipe: NonNullable<PlannedMealView['recipe']> };

/** What was asked for in the place of a meal: a strategy of the engine's, or a model's pick. */
export interface SwapAsk {
  planId: string;
  plannedMealId: string;
  strategy: 'random' | 'favorite' | 'favorite_ingredients' | 'ai';
  favoriteRecipeId?: string;
  allowOffDiet?: boolean;
}

/** What comes back when a recipe is asked for in the place of a meal. A model that was asked leaves `aiMeta`, and the note of its pick when the pick is its own. */
export type Offered = MealSwapPreview & Partial<Pick<AiMealSwapPreview, 'aiMeta' | 'pick'>>;

/** A recipe that was offered for a meal, with what the swap would do, and the recipes this sitting has offered for it. */
export interface SwapOffer {
  asked: SwapAsk;
  preview: Offered;
  seen: string[];
}

const PANTRY_LINE: Partial<Record<PantryUse, 'pantryCounted' | 'pantryLeftOut' | 'pantryUnused'>> = {
  counted: 'pantryCounted',
  left_out: 'pantryLeftOut',
  unused: 'pantryUnused',
};

/** One plan: its summary, and when open its days with every change a meal can be given. */
export function PlanCard({
  summary,
  plan,
  open,
  busy,
  dietLabel,
  favorites,
  tMeal,
  onToggle,
  onReroll,
  limitNames,
  onDelete,
  onSwapMeal,
  onSwapByFavorites,
  onSwapToFavorite,
  onAiSwapMeal,
  aiOffNote,
  offer,
  onTakeOffer,
  onAnotherOffer,
  onCancelOffer,
  onToggleEaten,
  onIngredientSwapped,
  onAddCustomMeal,
}: {
  /** The plan as the list holds it: what the head of the card says. */
  summary: MealPlanSummary;
  /** The whole plan, once the open card has read it. */
  plan: MealPlan | undefined;
  open: boolean;
  busy: boolean;
  dietLabel: string;
  favorites: FavoriteOption[];
  tMeal: ReturnType<typeof useTranslations<'enums.mealType'>>;
  onToggle: () => void;
  /** Make the plan again, or the part of it that was chosen in the window for it. */
  onReroll: (asked: RerollAsked) => void;
  limitNames: (kinds: readonly PlanRelaxation[]) => string;
  onDelete: () => void;
  onSwapMeal: (plannedMealId: string) => void;
  onSwapByFavorites: (plannedMealId: string) => void;
  onSwapToFavorite: (plannedMealId: string, recipeId: string, allowOffDiet: boolean) => void;
  /** Undefined on an account that has no model to ask: the button stays in its place, disabled. */
  onAiSwapMeal?: (plannedMealId: string) => void;
  /** The line of the page that says why what asks a model is off, for the buttons that are. */
  aiOffNote?: string;
  /** The recipe that is on offer for one of this plan's meals, if any. */
  offer: SwapOffer | null;
  onTakeOffer: () => void;
  onAnotherOffer: () => void;
  onCancelOffer: () => void;
  onToggleEaten: (mealId: string, eaten: boolean) => void;
  onIngredientSwapped: (result: SwapIngredientResponse) => void;
  onAddCustomMeal: (date: string, body: AddCustomMealRequest) => void;
}) {
  const t = useTranslations('mealPlans');
  const tCommon = useTranslations('common');
  const fmt = useFormat();
  // Which meal's "swap to favorite" picker is open, if any.
  const [openFav, setOpenFav] = useState<string | null>(null);
  // Show every favourite (drop the diet filter) in the open picker.
  const [showAllFav, setShowAllFav] = useState(false);
  // Which day's "add custom meal" modal is open, if any.
  const [customDay, setCustomDay] = useState<string | null>(null);
  // Which meal's ingredient-substitution modal is open, if any. Only catalogue
  // meals (recipe present) can be substituted.
  const [openSub, setOpenSub] = useState<CatalogueMeal | null>(null);
  // Which recipe is open in a window over the page, if any, with the
  // ingredient lines of the meal it was opened from, so the window shows what
  // that meal takes rather than the recipe's own servings.
  const [openRecipe, setOpenRecipe] = useState<{ id: string; amounts: PlannedIngredient[]; picked: PlannedMealView['modelPick'] } | null>(null);
  // What the window a plan is made again in opens on, while it is open.
  const [reroll, setReroll] = useState<RerollStart | null>(null);
  // What the pantry had to do with the plan is said where it says something: not of an empty pantry, nor of one left aside on request.
  const pantryLine = plan?.report ? PANTRY_LINE[plan.report.pantry] : undefined;
  return (
    <Card className="relative w-full max-w-screen-2xl">
      {/* On a narrow screen what can be done with the plan goes under what the plan is, and what opens from it under both. */}
      <div className="relative flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-4">
        <button type="button" onClick={onToggle} aria-expanded={open} className="min-w-0 flex-1 basis-56 text-left">
          <p className="font-medium">
            {t('planSummary', { days: summary.durationDays, dietType: dietLabel })}
            {summary.generationMode === 'ai_assisted' && <AiMark part={{ kind: 'plan' }} className="ml-2 align-middle" />}
          </p>
          <p className="text-sm text-muted-foreground">
            {t('planMeta', {
              date: fmt.date(summary.startDate),
              kcal: summary.averageDailyNutrition.calories,
              pct: Math.round(summary.ingredientReuseScore * 100),
            })}
          </p>
        </button>
        <div className="flex flex-wrap items-center gap-2">
          <ApplyFavoriteSetButton plan={summary} profileId={summary.profileId} disabled={busy} />
          <Button type="button" variant="outline" size="sm" onClick={() => setReroll({ scope: 'whole' })} disabled={busy}>
            {t('recalculate')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-destructive"
            onClick={onDelete}
            disabled={busy}
          >
            {tCommon('delete')}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onToggle} aria-expanded={open} aria-label={t(open ? 'hidePlan' : 'showPlan')}>
            <span aria-hidden>{open ? '▲' : '▼'}</span>
          </Button>
        </div>
      </div>
      {open && !plan && (
        <CardContent className="border-t border-border pt-4">
          <Skeleton className="h-40" />
        </CardContent>
      )}
      {open && plan && (
        <CardContent className="space-y-4 border-t border-border pt-4">
          <div className="space-y-1 text-xs text-muted-foreground">
            <p>
              {t('planMacros', {
                protein: plan.averageDailyNutrition.protein,
                proteinTarget: plan.targetMacros.protein,
                fat: plan.averageDailyNutrition.fat,
                fatTarget: plan.targetMacros.fat,
                carbs: plan.averageDailyNutrition.carbs,
                carbsTarget: plan.targetMacros.carbs,
              })}
            </p>
          </div>
          {(plan.options.allowRelaxations.length > 0 || pantryLine) && (
            <div className="space-y-1 text-xs text-muted-foreground">
              {plan.options.allowRelaxations.length > 0 && (
                <p className="flex flex-wrap items-center gap-2">
                  {t('planMayGiveWay', { limits: limitNames(plan.options.allowRelaxations) })}
                  <Button type="button" variant="ghost" size="sm" onClick={() => setReroll({ scope: 'whole', holdLimits: true })} disabled={busy}>
                    {t('holdLimits')}
                  </Button>
                </p>
              )}
              {pantryLine && <p>{t(pantryLine)}</p>}
            </div>
          )}
          {plan.days.map((day) => (
            <div key={day.id}>
              <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                <span className="text-sm font-medium">{fmt.day(day.date)}</span>
                {day.skipped ? (
                  // A day the user skips is no shortfall, and there is nothing in it to change.
                  <span className="text-sm text-muted-foreground">{t('daySkipped')}</span>
                ) : (
                  <div className="flex flex-wrap items-center gap-x-3">
                    <span
                      className={
                        Math.abs(day.calorieDelta) <= 50
                          ? 'text-sm text-muted-foreground'
                          : 'text-sm text-destructive'
                      }
                    >
                      {t('calorieLine', {
                        kcal: day.dayNutrition.calories,
                        target: day.calorieTarget,
                        delta: fmt.signed(day.calorieDelta),
                      })}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setReroll({ scope: 'day', day: day.date })}
                      disabled={busy}
                    >
                      {t('changeDay')}
                    </Button>
                  </div>
                )}
              </div>
              {!day.skipped && (
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  {/* Said for as long as it is so: a notice that goes away is easy to miss. */}
                  {day.offTarget && (
                    <span
                      title={t(day.offTarget === 'over' ? 'dayOverHint' : 'dayUnderHint')}
                      className="whitespace-nowrap rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning"
                    >
                      {t(day.offTarget === 'over' ? 'dayOver' : 'dayUnder')}
                      <span className="sr-only">: {t(day.offTarget === 'over' ? 'dayOverHint' : 'dayUnderHint')}</span>
                    </span>
                  )}
                  <span>
                    {t('dayMacros', {
                      protein: day.dayNutrition.protein,
                      proteinTarget: day.targetMacros.protein,
                      fat: day.dayNutrition.fat,
                      fatTarget: day.targetMacros.fat,
                      carbs: day.dayNutrition.carbs,
                      carbsTarget: day.targetMacros.carbs,
                    })}
                  </span>
                </p>
              )}
              {day.belowSafetyFloor && <p className="text-xs text-warning">{t('dayBelowFloor')}</p>}
              <ul className="mt-1 space-y-1 text-sm">
                {day.meals.map((m) => {
                  const eaten = m.eatenAt !== null;
                  const isCustom = m.source === 'USER_CUSTOM' || m.recipe === null;
                  const title = isCustom ? m.customName ?? t('customMeal') : m.recipe!.title;
                  const favOpen = openFav === m.id;
                  const mealLabel = tMeal.has(m.mealType) ? tMeal(m.mealType) : m.mealType.replace('_', ' ');
                  // What the generation said of this meal: the report speaks of the recipes it placed.
                  const said = <T extends { date: string; slot: string }>(entries: T[] | undefined): T | undefined =>
                    isCustom ? undefined : entries?.find((entry) => entry.date === day.date && entry.slot === m.mealType);
                  const outside = said(plan.report?.relaxations);
                  const onlyRecipe = said(plan.report?.singleCandidate);
                  const byModel = partInMeal(m);
                  // The picker shows diet-matching, slot-matching favourites
                  // by default; "show all my favourites" drops BOTH the diet and the
                  // meal-time filter (allergens stay enforced server-side), so a
                  // dinner favourite can be dropped onto breakfast.
                  const slotFavorites = favorites.filter(
                    (f) =>
                      showAllFav ||
                      (f.recipe.mealTypes.includes(m.mealType) &&
                        fitsDiet(f.recipe.dietTags, plan.dietType)),
                  );
                  return (
                    <li key={m.id} className="space-y-1">
                      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1">
                        <span className="min-w-0 flex-1 basis-64">
                          <input
                            type="checkbox"
                            className="mr-2 h-4 w-4 align-middle"
                            checked={eaten}
                            disabled={busy}
                            aria-label={t('markEaten')}
                            title={t('markEaten')}
                            onChange={() => onToggleEaten(m.id, !m.eatenAt)}
                          />
                          <span className="text-muted-foreground">{mealLabel}</span> ·{' '}
                          {isCustom ? (
                            <span className="font-medium">{title}</span>
                          ) : (
                            <button
                              type="button"
                              onClick={() =>
                                setOpenRecipe({ id: m.recipe!.id, amounts: m.ingredients, picked: m.modelPick })
                              }
                              className="font-medium text-primary hover:underline"
                            >
                              {title}
                            </button>
                          )}
                          {isCustom && (
                            <span className="ml-2 whitespace-nowrap rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                              {t('customChip')}
                            </span>
                          )}
                          {byModel && <AiMark part={byModel} className="ml-2 align-middle" />}
                          {m.dietOverride && (
                            <span className="ml-2 whitespace-nowrap rounded bg-warning/15 px-1.5 py-0.5 text-[10px] text-warning">
                              {t('dietOverrideChip')}
                            </span>
                          )}
                          {/* What the profile has ruled out since this meal was planned: the plan is not rewritten, it says so. */}
                          {m.restrictionConflicts.map((conflict) => (
                            <span
                              key={conflict}
                              title={t(`conflictHint.${conflict}`)}
                              className="ml-2 whitespace-nowrap rounded bg-destructive/15 px-1.5 py-0.5 text-[10px] font-medium text-destructive"
                            >
                              {t(`conflictChip.${conflict}`)}
                            </span>
                          ))}
                          {outside && (
                            <span
                              title={t('outsideLimitHint', { limits: limitNames(outside.gaveWay) })}
                              className="ml-2 whitespace-nowrap rounded bg-warning/15 px-1.5 py-0.5 text-[10px] text-warning"
                            >
                              {t('outsideLimitChip')}
                            </span>
                          )}
                          {onlyRecipe && (
                            <span title={t('onlyRecipeHint')} className="ml-2 whitespace-nowrap rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                              {t('onlyRecipeChip')}
                            </span>
                          )}
                          {m.quantityScale !== 1 && (
                            <span className="ml-2 whitespace-nowrap rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-foreground">
                              {t('autoBalancedChip', { scale: fmt.fixed(m.quantityScale, 2) })}
                            </span>
                          )}
                        </span>
                        <span className="flex flex-wrap items-center gap-x-4">
                          {eaten ? (
                            <span className="text-xs font-medium text-muted-foreground">
                              {t('eatenBadge')}
                            </span>
                          ) : isCustom ? null : (
                            <>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => onSwapMeal(m.id)}
                                disabled={busy}
                              >
                                {t('swap')}
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                title={t('tooltipSwapToFav')}
                                onClick={() => {
                                  setShowAllFav(false);
                                  setOpenFav(favOpen ? null : m.id);
                                }}
                                disabled={busy}
                              >
                                {t('swapToFav')} ★ {favOpen ? '▲' : '▾'}
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                title={onAiSwapMeal ? t('tooltipAiSwap') : undefined}
                                onClick={() => onAiSwapMeal?.(m.id)}
                                disabled={busy || !onAiSwapMeal}
                                aria-describedby={onAiSwapMeal ? undefined : aiOffNote}
                                className="text-primary"
                              >
                                <Sparkles size={14} aria-hidden />
                                <span className="ml-1">{t('aiSwap')}</span>
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                title={t('tooltipSwapByFav')}
                                onClick={() => onSwapByFavorites(m.id)}
                                disabled={busy}
                              >
                                {t('swapFavIngr')}
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                title={t('tooltipSubstitute')}
                                onClick={() => {
                                  if (m.recipe) setOpenSub({ ...m, recipe: m.recipe });
                                }}
                                disabled={busy}
                              >
                                {t('substituteIngr')} ⇄
                              </Button>
                            </>
                          )}
                        </span>
                      </div>
                      {offer?.asked.plannedMealId === m.id && (
                        <div className="ml-4 space-y-1 rounded-md border border-primary/30 bg-primary/5 p-2 text-xs" role="group" aria-label={t('offerTitle')}>
                          {/* A model's own pick says so, with its reason, before it is taken. */}
                          {offer.preview.pick && <AiMark part={{ kind: 'picked', reason: offer.preview.aiMeta?.reason ?? null }} spelledOut />}
                          <p>
                            {t.rich('offerLine', {
                              title: offer.preview.recipe.title,
                              servings: offer.preview.servings,
                              after: offer.preview.after.calories,
                              before: offer.preview.before.calories,
                              strong: (chunks) => <span className="font-medium">{chunks}</span>,
                            })}
                          </p>
                          <p className="text-muted-foreground">
                            {t('offerMacros', { protein: offer.preview.after.protein, fat: offer.preview.after.fat, carbs: offer.preview.after.carbs })}
                          </p>
                          <p className="text-muted-foreground">{t('offerDay', { kcal: offer.preview.dayAfter.calories, target: offer.preview.calorieTarget })}</p>
                          <div className="flex flex-wrap gap-2 pt-1">
                            <Button type="button" size="sm" onClick={onTakeOffer} disabled={busy}>
                              {t('offerTake')}
                            </Button>
                            {/* A favourite picked by hand is the one the user asked for: there is no other to offer. */}
                            {offer.asked.strategy !== 'favorite' && (
                              <Button type="button" size="sm" variant="outline" onClick={onAnotherOffer} disabled={busy}>
                                {t('offerAnother')}
                              </Button>
                            )}
                            <Button type="button" size="sm" variant="ghost" onClick={onCancelOffer}>
                              {tCommon('cancel')}
                            </Button>
                          </div>
                        </div>
                      )}
                      {/* Per-meal macros sit below the title as plain text — the
                          modal opened from the recipe title carries the full
                          ingredient list scaled for this meal. */}
                      <MacrosLine nutrition={m.nutrition} />
                      {isCustom && (
                        <p className="ml-6 text-xs italic text-muted-foreground">
                          {t('customMacrosNote')}
                        </p>
                      )}
                      {favOpen && !isCustom && (
                        <div className="ml-4 rounded-md border border-border bg-muted/40 p-2">
                          <label className="mb-2 flex items-center gap-1 text-xs">
                            <input
                              type="checkbox"
                              className="h-3.5 w-3.5"
                              checked={showAllFav}
                              onChange={(e) => setShowAllFav(e.target.checked)}
                            />
                            {t('showAllFavorites')}
                          </label>
                          {slotFavorites.length === 0 ? (
                            <p className="text-xs text-muted-foreground">
                              {showAllFav
                                ? t('noFavorites')
                                : t('noFavoritesForSlot', { mealType: mealLabel })}
                            </p>
                          ) : (
                            <ul className="space-y-1">
                              {slotFavorites.map((f) => {
                                const off = !fitsDiet(f.recipe.dietTags, plan.dietType);
                                const crossSlot = !f.recipe.mealTypes.includes(m.mealType);
                                return (
                                  <li key={f.recipe.id}>
                                    <button
                                      type="button"
                                      className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted disabled:opacity-50"
                                      disabled={busy}
                                      onClick={() => {
                                        setOpenFav(null);
                                        onSwapToFavorite(m.id, f.recipe.id, showAllFav);
                                      }}
                                    >
                                      <span>{f.recipe.title}</span>
                                      <span className="flex shrink-0 items-center gap-1">
                                        {crossSlot && (
                                          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                            {f.recipe.mealTypes
                                              .map((mt) => (tMeal.has(mt) ? tMeal(mt) : mt))
                                              .join(' · ')}
                                          </span>
                                        )}
                                        {off && (
                                          <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] text-warning">
                                            {t('offDietTag')}
                                          </span>
                                        )}
                                      </span>
                                    </button>
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-1"
                onClick={() => setCustomDay(day.date)}
                disabled={busy}
              >
                {t('addCustomMeal')}
              </Button>
            </div>
          ))}
        </CardContent>
      )}
      {reroll && (
        <RerollDialog
          planId={summary.id}
          title={t('planSummary', { days: summary.durationDays, dietType: dietLabel })}
          start={reroll}
          limitNames={limitNames}
          onClose={() => setReroll(null)}
          onSubmit={onReroll}
        />
      )}
      {customDay && (
        <CustomMealModal
          date={customDay}
          onClose={() => setCustomDay(null)}
          onSubmit={(body) => {
            onAddCustomMeal(customDay, body);
            setCustomDay(null);
          }}
        />
      )}
      {openSub && (
        <IngredientSubstituteModal
          meal={openSub}
          planId={summary.id}
          onClose={() => setOpenSub(null)}
          onApplied={onIngredientSwapped}
        />
      )}
      <RecipeModal
        recipeId={openRecipe?.id ?? null}
        amounts={openRecipe?.amounts}
        picked={openRecipe?.picked ?? null}
        onClose={() => setOpenRecipe(null)}
      />
    </Card>
  );
}

/** Per-meal macros as plain inline text, sitting below the recipe title. Full
 *  macro nouns (Protein / Białko) so it reads as a sentence, not a sticker
 *  strip. Mirrors the layout the ingredient list used to occupy. */
function MacrosLine({
  nutrition,
}: {
  nutrition: { calories: number; protein: number; fat: number; carbs: number };
}) {
  const t = useTranslations('macrosLine');
  const fmt = useFormat();
  return (
    <p className="ml-4 text-xs text-muted-foreground">
      {t('protein')} {fmt.unit(nutrition.protein, 'gram')} · {t('fat')} {fmt.unit(nutrition.fat, 'gram')} · {t('carbs')} {fmt.unit(nutrition.carbs, 'gram')} ·{' '}
      {fmt.number(nutrition.calories)} {t('kcal')}
    </p>
  );
}
