// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useLocale, useTranslations } from 'next-intl';
import dynamic from 'next/dynamic';
import { useCallback, useState } from 'react';
import { ChevronRight, Sparkles } from 'lucide-react';
import {
  fitsDiet,
  type AddCustomMealRequest,
  type AiMealSwapPreview,
  type MealPlan,
  type MealPlanDay,
  type MealPlanSummary,
  type MealSwapPreview,
  type PantryUse,
  type PlannedIngredient,
  type PlanRelaxation,
  type RebalanceResult,
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
import { DayVariationsDialog } from './day-variations-dialog';
import { RerollDialog, type RerollAsked, type RerollStart } from './reroll-dialog';
import { CSV_DIALECTS, csvOf } from '@/lib/csv';
import { localDate } from '@/lib/http';
import { saveText } from '@/lib/save-file';
import { useFormat } from '@/lib/use-format';
import { cn } from '@/lib/utils';
import { lastDayOf, planTable, type PlanWords } from './plan-export';
import { PlanPacksLine } from './plan-packs';
import { UseUp } from './use-up';

/** Fetched when a plan is printed: the sheet is drawn for the printer alone. */
const PlanPrintSheet = dynamic(() => import('./plan-print').then((sheet) => sheet.PlanPrintSheet), { ssr: false });

/** Fetched when the settings of a day are opened: no first visit of the page waits for the window. */
const DaySettingsDialog = dynamic(() => import('./day-settings-dialog').then((dialog) => dialog.DaySettingsDialog), { ssr: false });

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

/** The name a day of a plan has on the page, for whatever leads to it. */
export const dayAnchor = (planId: string, date: string): string => `plan-${planId}-${date}`;

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
  onRemoveMeal,
  onSpread,
  onSwapped,
  onChanged,
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
  /** Take a meal off its day. */
  onRemoveMeal: (mealId: string) => void;
  /** Spread what the days from `date` are off their targets by over the remaining days of the plan. */
  onSpread: (date: string) => void;
  /** Told what a swap that the card made itself came to: one that uses up what the plan opens. */
  onSwapped: (result: RebalanceResult) => void;
  /** Told when the plan is no longer what the card shows: a day was filled another way, or the plan had changed under an offer. */
  onChanged: () => void;
}) {
  const t = useTranslations('mealPlans');
  const tCommon = useTranslations('common');
  const fmt = useFormat();
  // Which meal's "swap to favorite" picker is open, if any.
  const [openFav, setOpenFav] = useState<string | null>(null);
  // Show every favourite (drop the diet filter) in the open picker.
  const [showAllFav, setShowAllFav] = useState(false);
  // Which meal's ways to be changed are unfolded on a narrow screen, where they fold behind one button.
  const [openActions, setOpenActions] = useState<string | null>(null);
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
  // The day whose other ways are on offer in a window, while it is open.
  const [waysFor, setWaysFor] = useState<{ id: string; date: string } | null>(null);
  // The day whose settings are open in a window, while it is open.
  const [settingsFor, setSettingsFor] = useState<MealPlanDay | null>(null);
  // The meal whose removal from its day is to be confirmed, with what it does said beside it.
  const [removing, setRemoving] = useState<string | null>(null);
  // Today by the reader's clock: a day before it is history.
  const today = localDate();
  // An account has a model to ask where the page was given the way to ask one.
  const aiEnabled = onAiSwapMeal !== undefined;
  const mealName = (type: string): string => (tMeal.has(type) ? tMeal(type) : type.replace('_', ' '));
  // The plan taken out of the application: as a table for a spreadsheet, or as a sheet for the printer.
  const tExport = useTranslations('mealPlans.export');
  const locale = useLocale();
  const [printing, setPrinting] = useState(false);
  const printed = useCallback(() => setPrinting(false), []);
  const words: PlanWords = {
    head: [tExport('date'), tExport('meal'), tExport('dish'), tExport('servings'), tExport('energy'), tExport('protein'), tExport('fat'), tExport('carbs'), tExport('eaten')],
    meal: (type) => (tMeal.has(type) ? tMeal(type) : type),
    ownMeal: t('customMeal'),
    yes: tCommon('yes'),
    no: tCommon('no'),
    skipped: t('daySkipped'),
  };
  // The meals that hold something the profile has ruled out since the plan was made.
  const conflicts = plan?.days.reduce((count, day) => count + day.meals.filter((meal) => meal.restrictionConflicts.length > 0).length, 0) ?? 0;
  // What the pantry had to do with the plan is said where it says something: not of an empty pantry, nor of one left aside on request.
  const pantryLine = plan?.report ? PANTRY_LINE[plan.report.pantry] : undefined;
  return (
    <Card className="relative w-full max-w-screen-2xl">
      {/* What the plan is opens it: one control, with the triangle of a list that unfolds beside what it names. On a narrow screen what can be done with the plan goes under it. */}
      <div className="relative flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-4">
        <button type="button" onClick={onToggle} aria-expanded={open} className="flex min-w-0 flex-1 basis-56 items-start gap-2 text-left">
          {/* Drawn, not typed: a typed triangle comes out as a coloured picture where the font has one. */}
          <ChevronRight size={16} aria-hidden className={cn('mt-1 shrink-0 text-muted-foreground', open && 'rotate-90')} />
          <span className="min-w-0">
            <span className="sr-only">{t(open ? 'hidePlan' : 'showPlan')}: </span>
            <span className="block font-medium">
              {t('planSummary', { days: summary.durationDays, dietType: dietLabel })}
              {summary.generationMode === 'ai_assisted' && <AiMark part={{ kind: 'plan' }} className="ml-2 align-middle" />}
            </span>
            <span className="block text-sm text-muted-foreground">
              {t('planMeta', {
                date: fmt.date(summary.startDate),
                kcal: summary.averageDailyNutrition.calories,
                pct: Math.round(summary.ingredientReuseScore * 100),
              })}
            </span>
          </span>
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
        </div>
      </div>
      {open && !plan && (
        <CardContent className="border-t border-border pt-4">
          <Skeleton className="h-40" />
        </CardContent>
      )}
      {open && plan && (
        <CardContent className="space-y-4 border-t border-border pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => saveText(csvOf(planTable(plan, words), CSV_DIALECTS[locale] ?? CSV_DIALECTS.en!), `meal-plan-${plan.startDate}_${lastDayOf(plan)}.csv`, 'text/csv')}
            >
              {tExport('csv')}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setPrinting(true)} disabled={printing}>
              {tExport('print')}
            </Button>
          </div>
          {printing && <PlanPrintSheet plan={plan} dietLabel={dietLabel} words={words} onDone={printed} />}
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
            {plan.packs.bought > 0 && (
              <PlanPacksLine packs={plan.packs}>
                {plan.packs.open.some((pack) => pack.wasted) && (
                  <UseUp planId={plan.id} aiEnabled={aiEnabled} aiOffNote={aiOffNote} mealName={mealName} busy={busy} onSwapped={onSwapped} onStale={onChanged} />
                )}
              </PlanPacksLine>
            )}
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
          {conflicts > 0 && (
            <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {t('conflictsNotice', { count: conflicts })}
            </p>
          )}
          {plan.days.map((day) => (
            // A day can be gone to from the calendar: it is named, and can take the focus.
            <div key={day.id} id={dayAnchor(plan.id, day.date)} tabIndex={-1} className="scroll-mt-20 focus:outline-none">
              <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {fmt.day(day.date)}
                  {(day.overrides?.dayType === 'training' || day.overrides?.dayType === 'rest') && (
                    <span className="whitespace-nowrap rounded bg-primary/10 px-1.5 py-0.5 text-2xs font-normal text-foreground">{t(`dayKindChip.${day.overrides.dayType}`)}</span>
                  )}
                </span>
                <div className="flex flex-wrap items-center gap-x-3">
                  {day.skipped ? (
                    // A day the user skips is no shortfall, and there is nothing in it to fill.
                    <span className="text-sm text-muted-foreground">{t('daySkipped')}</span>
                  ) : (
                    <>
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
                      <Button type="button" variant="ghost" size="sm" onClick={() => setWaysFor({ id: day.id, date: day.date })} disabled={busy}>
                        {t('otherWays')}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setReroll({ scope: 'day', day: day.date })}
                        disabled={busy}
                      >
                        {t('changeDay')}
                      </Button>
                    </>
                  )}
                  {/* A day before today is history: its settings stay as they were. */}
                  {day.date >= today && (
                    <Button type="button" variant="ghost" size="sm" onClick={() => setSettingsFor(day)} disabled={busy}>
                      {t('daySettingsButton')}
                    </Button>
                  )}
                </div>
              </div>
              <DaySettingsLine day={day} />
              {/* Said for as long as it is so, in words anybody can read: a notice that goes away is easy to miss, and a text that shows on hover says nothing to a finger. */}
              {!day.skipped && day.offTarget && (
                <div className="space-y-1 text-xs">
                  <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-warning">
                    <span className="whitespace-nowrap rounded bg-warning/15 px-1.5 py-0.5 text-2xs font-medium">{t(day.offTarget === 'over' ? 'dayOver' : 'dayUnder')}</span>
                    <span>{t(day.offTarget === 'over' ? 'dayOverHint' : 'dayUnderHint')}</span>
                  </p>
                  {/* What spreading does is said beside the button that does it, before it is pressed; it is offered where another day from today on can take a part. */}
                  {plan.days.some((other) => other.id !== day.id && other.date >= today && !other.skipped) && (
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        // The remaining days of the plan take it: from today, or from the day itself where it is over already.
                        onClick={() => onSpread(day.date < today ? day.date : today)}
                        disabled={busy}
                        aria-describedby={`${day.id}-spread`}
                      >
                        {t('spread')}
                      </Button>
                      <span id={`${day.id}-spread`} className="text-muted-foreground">
                        {t(day.offTarget === 'over' ? 'spreadNoteOver' : 'spreadNoteUnder')}
                      </span>
                    </div>
                  )}
                </div>
              )}
              {!day.skipped && (
                <p className="text-xs text-muted-foreground">
                  {t('dayMacros', {
                    protein: day.dayNutrition.protein,
                    proteinTarget: day.targetMacros.protein,
                    fat: day.dayNutrition.fat,
                    fatTarget: day.targetMacros.fat,
                    carbs: day.dayNutrition.carbs,
                    carbsTarget: day.targetMacros.carbs,
                  })}
                </p>
              )}
              {day.belowSafetyFloor && <p className="text-xs text-warning">{t('dayBelowFloor')}</p>}
              <ul className="mt-1 space-y-1 text-sm">
                {day.meals.map((m) => {
                  const eaten = m.eatenAt !== null;
                  const isCustom = m.source === 'USER_CUSTOM' || m.recipe === null;
                  const title = isCustom ? m.customName ?? t('customMeal') : m.recipe!.title;
                  // A control of this meal by a name of its own: among the buttons of a plan, "Swap" alone is every meal's.
                  const named = (action: string): string => t('actionFor', { action, title });
                  const favOpen = openFav === m.id;
                  const actionsOpen = openActions === m.id;
                  const mealLabel = tMeal.has(m.mealType) ? tMeal(m.mealType) : m.mealType.replace('_', ' ');
                  // What the generation said of this meal: the report speaks of the recipes it placed.
                  const said = <T extends { date: string; slot: string }>(entries: T[] | undefined): T | undefined =>
                    isCustom ? undefined : entries?.find((entry) => entry.date === day.date && entry.slot === m.mealType);
                  const outside = said(plan.report?.relaxations);
                  const onlyRecipe = said(plan.report?.singleCandidate);
                  const byModel = partInMeal(m);
                  // What the meal holds that the profile would rather not eat, by name.
                  const disliked = m.ingredients.filter((line) => m.dislikedIngredientIds.includes(line.ingredientId)).map((line) => line.name);
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
                            aria-label={named(t('markEaten'))}
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
                            <span className="ml-2 whitespace-nowrap rounded bg-muted px-1.5 py-0.5 text-2xs uppercase text-muted-foreground">
                              {t('customChip')}
                            </span>
                          )}
                          {byModel && <AiMark part={byModel} className="ml-2 align-middle" />}
                          {/* A chip names what there is to say of the meal at a glance; what it means is a line under the meal. */}
                          {m.dietOverride && (
                            <span className="ml-2 whitespace-nowrap rounded bg-warning/15 px-1.5 py-0.5 text-2xs text-warning">
                              {t('dietOverrideChip')}
                            </span>
                          )}
                          {m.restrictionConflicts.map((conflict) => (
                            <span key={conflict} className="ml-2 whitespace-nowrap rounded bg-destructive/15 px-1.5 py-0.5 text-2xs font-medium text-destructive">
                              {t(`conflictChip.${conflict}`)}
                            </span>
                          ))}
                          {disliked.length > 0 && (
                            <span className="ml-2 whitespace-nowrap rounded bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">{t('dislikedChip')}</span>
                          )}
                          {outside && (
                            <span className="ml-2 whitespace-nowrap rounded bg-warning/15 px-1.5 py-0.5 text-2xs text-warning">
                              {t('outsideLimitChip')}
                            </span>
                          )}
                          {onlyRecipe && (
                            <span className="ml-2 whitespace-nowrap rounded bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
                              {t('onlyRecipeChip')}
                            </span>
                          )}
                          {m.quantityScale !== 1 && (
                            <span className="ml-2 whitespace-nowrap rounded bg-primary/10 px-1.5 py-0.5 text-2xs text-foreground">
                              {t('autoBalancedChip', { scale: fmt.fixed(m.quantityScale, 2) })}
                            </span>
                          )}
                          {m.cookAhead && (
                            <span className="ml-2 whitespace-nowrap rounded bg-primary/10 px-1.5 py-0.5 text-2xs text-foreground">{t(m.cookAhead === 'cook' ? 'cookOnceChip' : 'cookedChip')}</span>
                          )}
                        </span>
                        <span className="flex flex-wrap items-center gap-x-4">
                          {(eaten || isCustom) && (
                            <>
                              {eaten && <span className="text-xs font-medium text-muted-foreground">{t('eatenBadge')}</span>}
                              <Button type="button" variant="ghost" size="sm" aria-label={named(t('remove'))} aria-expanded={removing === m.id} onClick={() => setRemoving(removing === m.id ? null : m.id)} disabled={busy}>
                                {t('remove')}
                              </Button>
                            </>
                          )}
                          {eaten || isCustom ? null : (
                            <>
                              {/* On a narrow screen the ways to change a meal fold behind one button: a day is its meals, not five buttons a meal. */}
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="sm:hidden"
                                aria-label={named(t('changeMeal'))}
                                aria-expanded={actionsOpen}
                                aria-controls={`${m.id}-actions`}
                                onClick={() => setOpenActions(actionsOpen ? null : m.id)}
                              >
                                {t('changeMeal')} <span aria-hidden>{actionsOpen ? '▲' : '▾'}</span>
                              </Button>
                              <span
                                id={`${m.id}-actions`}
                                role="group"
                                aria-label={t('mealActions', { title })}
                                className={cn(actionsOpen ? 'flex' : 'hidden', 'basis-full flex-wrap items-center gap-x-4 sm:flex sm:basis-auto')}
                              >
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  aria-label={named(t('swap'))}
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
                                  aria-label={named(t('swapToFav'))}
                                  aria-expanded={favOpen}
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
                                  aria-label={named(t('aiSwap'))}
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
                                  aria-label={named(t('swapFavIngr'))}
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
                                  aria-label={named(t('substituteIngr'))}
                                  onClick={() => {
                                    if (m.recipe) setOpenSub({ ...m, recipe: m.recipe });
                                  }}
                                  disabled={busy}
                                >
                                  {t('substituteIngr')} ⇄
                                </Button>
                                <Button type="button" variant="ghost" size="sm" aria-label={named(t('remove'))} aria-expanded={removing === m.id} onClick={() => setRemoving(removing === m.id ? null : m.id)} disabled={busy}>
                                  {t('remove')}
                                </Button>
                              </span>
                            </>
                          )}
                        </span>
                      </div>
                      {removing === m.id && (
                        <div className="ml-4 space-y-1 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs" role="group" aria-label={t('removeTitle', { title })}>
                          <p>{t(eaten ? 'removeNoteEaten' : 'removeNote')}</p>
                          <div className="flex flex-wrap gap-2 pt-1">
                            <Button
                              type="button"
                              size="sm"
                              variant="destructive"
                              onClick={() => {
                                setRemoving(null);
                                onRemoveMeal(m.id);
                              }}
                              disabled={busy}
                            >
                              {t('removeConfirm')}
                            </Button>
                            <Button type="button" size="sm" variant="ghost" onClick={() => setRemoving(null)}>
                              {tCommon('cancel')}
                            </Button>
                          </div>
                        </div>
                      )}
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
                      {/* What the profile has ruled out since the meal was planned comes first: the plan is not rewritten, it says so. */}
                      {m.restrictionConflicts.map((conflict) => (
                        <p key={conflict} className="ml-4 text-xs text-destructive">
                          {t(`conflictHint.${conflict}`)}
                        </p>
                      ))}
                      {m.dietOverride && <p className="ml-4 text-xs text-warning">{t('dietOverrideHint', { diet: dietLabel })}</p>}
                      {disliked.length > 0 && <p className="ml-4 text-xs text-muted-foreground">{t('dislikedHint', { foods: fmt.list(disliked) })}</p>}
                      {outside && <p className="ml-4 text-xs text-muted-foreground">{t('outsideLimitHint', { limits: limitNames(outside.gaveWay) })}</p>}
                      {onlyRecipe && <p className="ml-4 text-xs text-muted-foreground">{t('onlyRecipeHint')}</p>}
                      {m.cookAhead && <p className="ml-4 text-xs text-muted-foreground">{t(m.cookAhead === 'cook' ? 'cookOnceHint' : 'cookedHint')}</p>}
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
                                          <span className="rounded bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
                                            {f.recipe.mealTypes
                                              .map((mt) => (tMeal.has(mt) ? tMeal(mt) : mt))
                                              .join(' · ')}
                                          </span>
                                        )}
                                        {off && (
                                          <span className="rounded bg-warning/15 px-1.5 py-0.5 text-2xs text-warning">
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
      {waysFor && (
        <DayVariationsDialog planId={summary.id} day={waysFor} aiEnabled={aiEnabled} aiOffNote={aiOffNote} mealName={mealName} onClose={() => setWaysFor(null)} onChanged={onChanged} />
      )}
      {settingsFor && (
        <DaySettingsDialog planId={summary.id} day={settingsFor} mealName={mealName} limitNames={limitNames} onClose={() => setSettingsFor(null)} onSaved={onChanged} />
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
          meals={(plan?.days.find((day) => day.date === customDay)?.meals ?? []).map((meal) => ({
            id: meal.id,
            mealType: meal.mealType,
            title: meal.recipe?.title ?? meal.customName ?? t('customMeal'),
          }))}
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

/** The settings a day has of its own, in words: what makes it differ from the plan's other days. */
function DaySettingsLine({ day }: { day: MealPlanDay }) {
  const t = useTranslations('mealPlans.daySettings');
  const fmt = useFormat();
  const own = day.overrides;
  if (!own || own.skip) return null;
  const said = [
    own.calorieTarget !== undefined
      ? t('lineOwnTarget', { kcal: fmt.number(own.calorieTarget) })
      : own.dayType === 'training'
        ? t('lineTraining')
        : own.dayType === 'rest'
          ? t('lineRest')
          : null,
    own.cookTimeBudgetMinutes !== undefined ? t('lineCookTime', { minutes: own.cookTimeBudgetMinutes }) : null,
    own.useUpBy ? t('lineUseUp') : null,
  ].filter((line): line is string => line !== null);
  return said.length > 0 ? <p className="text-xs text-muted-foreground">{said.join(' ')}</p> : null;
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
