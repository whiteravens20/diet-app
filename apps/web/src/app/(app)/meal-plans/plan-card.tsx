// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

'use client';

import { useLocale, useTranslations } from 'next-intl';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, Sparkles } from 'lucide-react';
import {
  fitsDiet,
  type AddCustomMealRequest,
  type DiaryEntry,
  type DietType,
  type EatenInOtherPlan,
  type AiMealSwapPreview,
  type MealPlan,
  type MealPlanDay,
  type MealPlanSummary,
  type MealSwapPreview,
  type PantryUse,
  type PlanFrozenRest,
  type PlannedIngredient,
  type PlanRelaxation,
  type RebalanceResult,
  type SwapIngredientResponse,
} from '@diet-app/shared';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ReadsFailed, type Read } from '@/components/load-failed';
import { Tabs } from '@/components/ui/tabs';
import { ApplyFavoriteSetButton } from '@/components/apply-favorite-set-button';
import { IngredientSubstituteModal } from '@/components/ingredient-substitute-modal';
import { LabelLegend, LabelLine, LabelNotes } from '@/components/label-figures';
import { AiMark, partInMeal } from '@/components/ai-mark';
import {
  CookingNote,
  mealsOfCooking,
  platesOf,
  portionOf,
  toCook,
  toCookTogether,
  useCookingWords,
  type MealPortion,
  type PotPortions,
} from './cooking';
import { DayVariationsDialog } from './day-variations-dialog';
import type { CookedMeal } from './split-dialog';
import { RerollDialog, type RerollAsked, type RerollStart } from './reroll-dialog';
import type { OffTargetWays } from './day-off-target-dialog';
import type { SharedPortion } from '@/components/recipe-modal';
import { useAmount, useShownAmount } from '@/lib/ingredient-format';
import { frozenOfDay, thawsByDay, type ThawLine } from './freezer';
import { CSV_DIALECTS, csvOf } from '@/lib/csv';
import { localDate } from '@/lib/http';
import { saveText } from '@/lib/save-file';
import { useFormat } from '@/lib/use-format';
import { cn } from '@/lib/utils';
import { useEntryAmount } from '@/components/diary-entry-amount';
import { MEAL_SLOTS_BY_COUNT } from '@diet-app/shared/constants';
import { lastDayOf, planTable, type PlanWords } from './plan-export';
import { PlanPacksLine } from './plan-packs';
import { ListNote } from './list-note';
import { UseUp } from './use-up';
import type { PlanChange } from './rebalance-toast';
import { TargetMovedLine } from './target-moved-line';
import { WeekLine } from './week-line';
import { DOT, held } from '@/lib/figure-line';
import { bandValues, carbsStandingOf } from '@/lib/carbs-band';

/** Fetched when a plan is printed: the sheet is drawn for the printer alone. */
const PlanPrintSheet = dynamic(() => import('./plan-print').then((sheet) => sheet.PlanPrintSheet), {
  ssr: false,
});

/** Fetched when a dish cooked ahead is split: no first visit of the page waits for the window. */
const SplitDialog = dynamic(() => import('./split-dialog').then((dialog) => dialog.SplitDialog), {
  ssr: false,
});

/** Fetched when a recipe is opened from a meal: no first visit of the page waits for the window. */
const RecipeModal = dynamic(
  () => import('@/components/recipe-modal').then((modal) => modal.RecipeModal),
  { ssr: false },
);

/** Fetched when the settings of a day are opened: no first visit of the page waits for the window. */
const DaySettingsDialog = dynamic(
  () => import('./day-settings-dialog').then((dialog) => dialog.DaySettingsDialog),
  { ssr: false },
);

/** Fetched when a day whose macros are off is shown: what makes it so. */
const MacrosOffWhy = dynamic(() => import('./macros-off-why').then((why) => why.MacrosOffWhy), {
  ssr: false,
  loading: () => null,
});

/** Fetched when a day off its target is asked what to do. */
const DayOffTargetDialog = dynamic(
  () => import('./day-off-target-dialog').then((dialog) => dialog.DayOffTargetDialog),
  { ssr: false },
);

/** Fetched when a day freezes a rest: how big to split it, and the rules of freezing. */
const FreezingTips = dynamic(
  () => import('@/components/freezing-tips').then((tips) => tips.FreezingTips),
  { ssr: false, loading: () => null },
);

/** Fetched when the way to change a day is asked for. */
const DayChangeHelp = dynamic(
  () => import('./day-change-help').then((help) => help.DayChangeHelp),
  { ssr: false },
);

/** Fetched when what is left of a meal is carried to the next day, or carried back. */
const LeftoverDialog = dynamic(
  () => import('./leftover-dialog').then((dialog) => dialog.LeftoverDialog),
  { ssr: false },
);
const LeftoverUndoDialog = dynamic(
  () => import('./leftover-dialog').then((dialog) => dialog.LeftoverUndoDialog),
  { ssr: false },
);

/** Fetched when a meal of one's own is added to a day: no first visit of the page waits for the window. */
const CustomMealModal = dynamic(
  () => import('./custom-meal-modal').then((modal) => modal.CustomMealModal),
  { ssr: false },
);

/** Why the next day cannot take what is left of a meal, as the button's note says it. */
const LEFTOVER_OFF = { no_day: 'offNoDay', skipped: 'offSkipped', no_meal: 'offNoMeal' } as const;

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
  /** Of a shared meal: the dish for both people, held to what both may be given. */
  forAll?: boolean;
}

/** What comes back when a recipe is asked for in the place of a meal. A model that was asked leaves `aiMeta`, and the note of its pick when the pick is its own. */
export type Offered = MealSwapPreview &
  Partial<Pick<AiMealSwapPreview, 'aiMeta' | 'pick' | 'topping'>>;

/** A recipe that was offered for a meal, with what the swap would do, and the recipes this sitting has offered for it. */
export interface SwapOffer {
  asked: SwapAsk;
  preview: Offered;
  seen: string[];
}

const PANTRY_LINE: Partial<Record<PantryUse, 'pantryCounted' | 'pantryLeftOut' | 'pantryUnused'>> =
  {
    counted: 'pantryCounted',
    left_out: 'pantryLeftOut',
    unused: 'pantryUnused',
  };

/** The name a day of a plan has on the page, for whatever leads to it. */
export const dayAnchor = (planId: string, date: string): string => `plan-${planId}-${date}`;

/** Another day of the plan, from today on and not skipped, can take a part of a day's gap. */
const spreadsFrom = (plan: MealPlan, day: MealPlanDay, today: string): boolean =>
  plan.days.some((other) => other.id !== day.id && other.date >= today && !other.skipped);

/** The name a meal of a plan has on the page. */
const mealAnchor = (mealId: string): string => `meal-${mealId}`;

/** From how far off its plan's portion a meal's portion is worth a mark of its own on the card: a tenth. */
const PORTION_CHIP_FROM = 0.1;

/** How near its target a day stays as it is, as a share of the target: the API does not fit it then. */
const DAY_ON_TARGET = 0.02;

/** A plan longer than this is shown a week at a time. */
const DAYS_A_WEEK = 7;

/** One plan: its summary, and when open its days with every change a meal can be given. */
export function PlanCard({
  summary,
  plan,
  unanswered,
  open,
  sought,
  onFound,
  edited,
  busy,
  dietLabel,
  profileDiet,
  profileRepeats,
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
  onOfferFor,
  onSetApart,
  onKeepFrozen,
  onKeepLeft,
  profileName,
  onSpread,
  onResizeDay,
  onHistory,
  onSwapped,
  onChanged,
  onLeftover,
}: {
  /** The plan as the list holds it: what the head of the card says. */
  summary: MealPlanSummary;
  /** The whole plan, once the open card has read it. */
  plan: MealPlan | undefined;
  /** The read of the whole plan, when it failed with nothing to show: the card says why instead of waiting. */
  unanswered?: Read;
  open: boolean;
  /** The day of this plan that a link or the calendar leads to, until the card has gone there. */
  sought: { date: string; meal?: string; back?: boolean } | null;
  onFound: () => void;
  /** The plan as the last change left it, once it has been read again. */
  edited: MealPlan | null;
  busy: boolean;
  dietLabel: string;
  /** The diet of the plan's profile as it is now: a whole plan made again follows it where the plan names none. */
  profileDiet: DietType;
  /** The profile's own limits on repeats, for the whole plan made again to waste nothing. */
  profileRepeats: { daysInARow: number; timesAWeek: number };
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
  /** Take the recipe on offer, on this meal alone or with the others of its cooking. */
  onTakeOffer: (together: boolean) => void;
  onAnotherOffer: () => void;
  onCancelOffer: () => void;
  /** Mark a meal eaten or not; `forAll`, of a shared meal, the other person's as well: "we ate". */
  onToggleEaten: (mealId: string, eaten: boolean, forAll?: boolean) => void;
  onIngredientSwapped: (result: SwapIngredientResponse, plannedMealId: string) => void;
  onAddCustomMeal: (date: string, body: AddCustomMealRequest) => void;
  /** Take a meal off its day; `forAll`, of a shared meal, off the other person's day as well. */
  onRemoveMeal: (mealId: string, forAll?: boolean) => void;
  /** Ask the offer for a shared meal again, for both people or for this one alone. */
  onOfferFor: (forAll: boolean) => void;
  /** Say how a shared meal is cooked: each portion apart, or in one pot. */
  onSetApart: (sharedMealId: string, apart: boolean) => void;
  /** "Dodaj do spiżarni": give the pantry what is left of a rest the plan freezes, once. */
  onKeepFrozen: (ingredientId: string, date: string) => void;
  /** "Dodaj do spiżarni" of what packs of one food leave, each pack not given yet. */
  onKeepLeft: (packs: readonly { ingredientId: string; date: string }[]) => void;
  /** The name of the profile whose plan this is: what a portion of a shared pot is called beside the other's. */
  profileName: string;
  /** Spread what the days from `date` are off their targets by over the remaining days of the plan. */
  onSpread: (date: string) => void;
  /** Bring the day of `date` back to its target with its own meals, the diary's entries counted as eaten. */
  onResizeDay: (date: string) => void;
  /** Open the history of a day ("Historia dnia"): what holds it and its changes. */
  onHistory: (day: MealPlanDay) => void;
  /** Told what a swap that the card made itself came to: one that uses up what the plan opens. */
  onSwapped: (result: RebalanceResult, plannedMealId: string) => void;
  /**
   * Told when the plan is no longer what the card shows: a day was filled another way, its settings or its week
   * changed, the profile's target was taken, a set was put on days (`change`, what the change answered), or the plan
   * had changed under an offer (nothing).
   */
  onChanged: (change?: PlanChange) => void;
  /** Told what carrying what is left of a meal to the next day, or undoing it, came to, and where it went. */
  onLeftover: (
    result: RebalanceResult,
    notice: string | null,
    to: { planId: string; date: string } | null,
  ) => void;
}) {
  const t = useTranslations('mealPlans');
  const tHelp = useTranslations('mealPlans.dayHelp');
  const tCommon = useTranslations('common');
  const fmt = useFormat();
  // Which meal's "swap to favorite" picker is open, if any.
  const [openFav, setOpenFav] = useState<string | null>(null);
  // Show every favourite (drop the diet filter) in the open picker.
  const [showAllFav, setShowAllFav] = useState(false);
  // Which meal's ways to be changed are unfolded: they fold behind one button.
  const [openActions, setOpenActions] = useState<string | null>(null);
  // Which day's "add custom meal" modal is open, if any.
  const [customDay, setCustomDay] = useState<string | null>(null);
  // Which meal's ingredient-substitution modal is open, if any. Only catalogue
  // meals (recipe present) can be substituted.
  const [openSub, setOpenSub] = useState<CatalogueMeal | null>(null);
  // Which recipe is open in a window over the page, if any, with the
  // ingredient lines of the meal it was opened from, so the window shows what
  // that meal takes rather than the recipe's own servings.
  const [openRecipe, setOpenRecipe] = useState<{
    id: string;
    amounts: PlannedIngredient[];
    picked: PlannedMealView['modelPick'];
    portion: MealPortion;
    label: PlannedMealView['label'];
    /** How far the planner sized the meal off its plan's portion. */
    scale: number;
    /** Of a meal two people share: the other person's portion and what each plate holds otherwise than the recipe. */
    shared?: SharedPortion;
    pot?: PotPortions;
    topping: { name: string; amount: string; kcal: number } | null;
    /** Opened for the diary: closing the window goes back to it. */
    back?: boolean;
  } | null>(null);
  // Whether the recipe on offer is to go on the meal it was asked for alone, by the meal it was ticked for.
  const [onlyFor, setOnlyFor] = useState<string | null>(null);
  const cookWords = useCookingWords();
  const shownAmount = useShownAmount();
  /** The window of a meal of a recipe, as its name opens it: the recipe in the plan's amounts, its pot, plates and topping. */
  const windowOf = (plan: MealPlan, m: PlannedMealView) => ({
    id: m.recipe!.id,
    picked: m.modelPick,
    label: m.label,
    scale: m.quantityScale,
    shared: m.shared
      ? {
          name: m.shared.with.profileName,
          servings: Math.round(m.shared.with.servings * 10) / 10,
          kcal: Math.round(m.shared.with.calories),
          eaten: m.shared.with.eaten,
          apart: m.shared.apart,
          plates: platesOf(m),
        }
      : undefined,
    ...toCook(plan, m),
    // A dish both cook in one pot is opened with what the pot takes.
    ...toCookTogether(plan, m),
    topping: m.topping && {
      name: m.topping.ingredient.name,
      amount: shownAmount(m.topping.ingredient.display),
      kcal: m.topping.nutrition.calories,
    },
  });
  const amount = useAmount();
  const tFreezer = useTranslations('mealPlans.freezer');
  const tSplit = useTranslations('split');
  // The dish being split, as the meals it is eaten at, while its window is open.
  const [splitting, setSplitting] = useState<CookedMeal[] | null>(null);
  // What the window a plan is made again in opens on, while it is open.
  const [reroll, setReroll] = useState<RerollStart | null>(null);
  // The day whose other ways are on offer in a window, while it is open.
  const [waysFor, setWaysFor] = useState<{ id: string; date: string } | null>(null);
  // The day whose settings are open in a window, while it is open.
  const [settingsFor, setSettingsFor] = useState<MealPlanDay | null>(null);
  // The day off its target whose question is open, with the ways it has.
  const [offTargetFor, setOffTargetFor] = useState<OffTargetWays | null>(null);
  // The day whose way to change it is explained in a window, while it is open.
  const [helpFor, setHelpFor] = useState<{ id: string; date: string } | null>(null);
  // The meal whose removal from its day is to be confirmed, with what it does said beside it.
  const [removing, setRemoving] = useState<string | null>(null);
  // The meal whose rest is being carried to the next day, or the leftover being carried back, while its window is open.
  // The meal whose leftover is being carried: what is left of it, or of the pot cooked already it is eaten from.
  const [carrying, setCarrying] = useState<{
    meal: PlannedMealView;
    date: string;
    fromPot?: boolean;
  } | null>(null);
  const [undoing, setUndoing] = useState<PlannedMealView | null>(null);
  // The days folded or unfolded by hand, by date: any other day follows `firstOpen` below.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  // The week of a long plan that was chosen, if any: the one that holds `firstOpen` until then.
  const [chosenWeek, setChosenWeek] = useState<number | null>(null);
  // The day last gone to: a new one for every time, as a press may ask for the same day again.
  const [goingTo, setGoingTo] = useState<{ date: string } | null>(null);
  // What was last led to from outside: each is gone to once, as soon as the plan is there.
  const [ledTo, setLedTo] = useState<{ date: string } | null>(null);
  // What the change under way was asked of: when the plan has come back from it, that stays in view.
  const changing = useRef<string | null>(null);
  // Today by the reader's clock: a day before it is history.
  const today = localDate();
  const days = plan?.days ?? [];
  // The day that is open by itself: today, or the first of a plan that does not hold today.
  const firstOpen = days.some((day) => day.date === today) ? today : days[0]?.date;
  const weekOf = (date: string | undefined): number =>
    Math.max(0, Math.floor(days.findIndex((day) => day.date === date) / DAYS_A_WEEK));
  const goToDay = (date: string): void => {
    setGoingTo({ date });
    setChosenWeek(weekOf(date));
    setToggled((all) => ({ ...all, [date]: true }));
  };
  if (sought && plan && sought !== ledTo) {
    setLedTo(sought);
    if (days.some((day) => day.date === sought.date)) goToDay(sought.date);
    // A meal the link names opens in its window: one of a recipe, as its name would open it.
    const meal = days
      .find((day) => day.date === sought.date)
      ?.meals.find((one) => one.id === sought.meal);
    if (meal?.recipe) setOpenRecipe({ ...windowOf(plan, meal), back: sought.back });
  }
  useEffect(() => {
    if (sought && sought === ledTo) onFound();
  });
  // Drawn by now: the week and the day open in the same turn as this.
  useEffect(() => {
    const day = goingTo && document.getElementById(dayAnchor(summary.id, goingTo.date));
    day?.scrollIntoView({ block: 'start' });
    day?.focus({ preventScroll: true });
  }, [goingTo, summary.id]);
  useEffect(() => {
    if (!plan || plan !== edited || !changing.current) return;
    const part = document.getElementById(changing.current);
    changing.current = null;
    if (!part) return;
    const { top, bottom } = part.getBoundingClientRect();
    if (bottom <= 0 || top >= window.innerHeight) part.scrollIntoView({ block: 'center' });
    // What was pressed may be gone by now, and the focus with it: the reader goes on from here.
    if (document.activeElement === document.body) part.focus({ preventScroll: true });
  }, [plan, edited]);
  // An account has a model to ask where the page was given the way to ask one.
  const aiEnabled = onAiSwapMeal !== undefined;
  const mealName = (type: string): string =>
    tMeal.has(type) ? tMeal(type) : type.replace('_', ' ');
  // The plan taken out of the application: as a table for a spreadsheet, or as a sheet for the printer.
  const tExport = useTranslations('mealPlans.export');
  const locale = useLocale();
  const [printing, setPrinting] = useState(false);
  const printed = useCallback(() => setPrinting(false), []);
  const words: PlanWords = {
    head: [
      tExport('date'),
      tExport('meal'),
      tExport('dish'),
      tExport('servings'),
      tExport('energy'),
      tExport('protein'),
      tExport('fat'),
      tExport('carbs'),
      tExport('eaten'),
    ],
    meal: (type) => (tMeal.has(type) ? tMeal(type) : type),
    ownMeal: t('customMeal'),
    yes: tCommon('yes'),
    no: tCommon('no'),
    skipped: t('daySkipped'),
  };
  // The meals that hold something the profile has ruled out since the plan was made.
  const conflicts =
    plan?.days.reduce(
      (count, day) =>
        count + day.meals.filter((meal) => meal.restrictionConflicts.length > 0).length,
      0,
    ) ?? 0;
  // What the pantry had to do with the plan is said where it says something: not of an empty pantry, nor of one left aside on request.
  const pantryLine = plan?.report ? PANTRY_LINE[plan.report.pantry] : undefined;
  // What each day says to take out of the freezer, and the words for it.
  const thaws = plan ? thawsByDay(plan, today) : new Map<string, never>();
  const thawItems = (lines: readonly ThawLine[]): string =>
    lines
      .map((line) =>
        line.mealType
          ? tFreezer('thawItemMeal', {
              name: fmt.text(line.name),
              amount: amount(line.amount, line.unit),
              meal: mealName(line.mealType).toLocaleLowerCase(locale),
            })
          : tFreezer('thawItem', {
              name: fmt.text(line.name),
              amount: amount(line.amount, line.unit),
            }),
      )
      .join('; ');
  /**
   * A rest of meat or fish the plan freezes, said where it goes in: in the portions the plan takes later, each with its
   * day, and the one for later, frozen apart; with "Dodaj do spiżarni" for that one. Under it, the size to split the
   * one for later into where it is bigger than two days of the plan eat, and the rules of freezing.
   */
  const frozenLine = (rest: PlanFrozenRest, indented: boolean) => {
    const name = fmt.text(rest.name);
    const portions = [
      ...rest.thawed.map((taken) =>
        tFreezer('portionOn', {
          amount: amount(taken.amount, rest.unit),
          day: fmt.weekday(taken.date, 'short'),
        }),
      ),
      ...(rest.left > 0
        ? [tFreezer('portionLater', { amount: amount(rest.left, rest.unit) })]
        : []),
    ];
    return (
      <div key={`${rest.ingredientId} ${rest.date}`} className={cn(indented && 'ml-6')}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span>
            {/* The rest of a pack, or of what was bought by weight. */}
            {portions.length === 1
              ? tFreezer(rest.loose ? 'freezeLoose' : 'freeze', { name, portion: portions[0]! })
              : tFreezer(rest.loose ? 'freezeLoosePortions' : 'freezePortions', {
                  name,
                  portions: fmt.list(portions),
                })}
          </span>
          {/* Given from the day the rest is frozen: before it, the pantry would hold what was not even bought. */}
          {rest.left > 0 &&
            (rest.inPantry ? (
              <span className="text-muted-foreground">{tFreezer('inPantry')}</span>
            ) : (
              rest.date <= today && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="-my-1"
                  disabled={busy}
                  aria-label={tFreezer('keepFor', { name, amount: amount(rest.left, rest.unit) })}
                  onClick={() => onKeepFrozen(rest.ingredientId, rest.date)}
                >
                  {tFreezer('keep')}
                </Button>
              )
            ))}
        </div>
        <FreezingTips
          portion={rest.portion !== null && rest.left > rest.portion ? rest.portion : null}
          unit={rest.unit}
          of="plan"
        />
      </div>
    );
  };
  // One day of the open plan: what it is and what it comes to stand in its head, which unfolds the rest.
  const dayCard = (plan: MealPlan, day: MealPlanDay) => {
    const dayOpen = toggled[day.date] ?? day.date === firstOpen;
    const thawsHere = thaws.get(day.date);
    const thawing = (thawsHere?.forTomorrow.length ?? 0) + (thawsHere?.forToday.length ?? 0) > 0;
    const frozenHere = frozenOfDay(plan, day);
    // What the diary holds, and what the profile's other plans had eaten, for a meal the day has none of stands where
    // that meal would in the day: before the first meal that comes after it, or after the last one.
    const notOfTheDay = <L extends { mealType: string }>(lines: readonly L[]): L[] =>
      lines
        .filter((line) => !day.meals.some((meal) => meal.mealType === line.mealType))
        .sort((a, b) => DAY_ORDER.indexOf(a.mealType) - DAY_ORDER.indexOf(b.mealType));
    const withoutMeal = notOfTheDay(day.diary?.items ?? []);
    const othersWithoutMeal = notOfTheDay(day.diary?.otherPlans ?? []);
    const placeOf = (line: { mealType: string }): number =>
      day.meals.findIndex(
        (meal) => DAY_ORDER.indexOf(meal.mealType) > DAY_ORDER.indexOf(line.mealType),
      );
    return (
      // A day can be gone to from the calendar: it is named, and can take the focus.
      <div
        key={day.id}
        id={dayAnchor(plan.id, day.date)}
        tabIndex={-1}
        aria-current={day.date === today ? 'date' : undefined}
        className="scroll-mt-20 rounded-lg border border-border bg-background focus:outline-none"
      >
        <button
          type="button"
          aria-expanded={dayOpen}
          onClick={() => setToggled((all) => ({ ...all, [day.date]: !dayOpen }))}
          className="flex w-full items-start gap-2 rounded-lg p-3 text-left"
        >
          <ChevronRight
            size={16}
            aria-hidden
            className={cn('mt-0.5 shrink-0 text-muted-foreground', dayOpen && 'rotate-90')}
          />
          <span className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <span className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-medium">
              {fmt.day(day.date)}
              {day.date === today && (
                <span className="whitespace-nowrap rounded bg-primary px-1.5 py-0.5 text-2xs font-medium text-primary-foreground">
                  {t('today')}
                </span>
              )}
              {(day.overrides?.dayType === 'training' || day.overrides?.dayType === 'rest') && (
                <span className="whitespace-nowrap rounded bg-primary/10 px-1.5 py-0.5 text-2xs font-normal text-foreground">
                  {t(`dayKindChip.${day.overrides.dayType}`)}
                </span>
              )}
              {day.macrosOff && !day.skipped && (
                <span className="whitespace-nowrap rounded bg-warning/15 px-1.5 py-0.5 text-2xs font-medium text-warning">
                  {t('macrosOffChip')}
                </span>
              )}
              {/* What has to come out of the freezer that day is not to stay behind a fold either. */}
              {thawing && (
                <span className="whitespace-nowrap rounded bg-primary/10 px-1.5 py-0.5 text-2xs font-medium text-foreground">
                  {tFreezer('thawChip')}
                </span>
              )}
              {/* What the profile has ruled out is not to stay behind a fold. */}
              {day.meals.some((meal) => meal.restrictionConflicts.length > 0) && (
                <span className="whitespace-nowrap rounded bg-destructive/15 px-1.5 py-0.5 text-2xs font-medium text-destructive">
                  {t('dayToCheck')}
                </span>
              )}
            </span>
            {day.skipped ? (
              // A day the user skips is no shortfall, and there is nothing in it to fill.
              <span className="text-sm text-muted-foreground">{t('daySkipped')}</span>
            ) : (
              <span
                className={
                  day.offTarget === null
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
            )}
          </span>
        </button>
        {dayOpen && (
          <div className="space-y-2 border-t border-border p-3">
            {/* The ways to change a day fold behind one button, as a meal's do. A day before today is history: its
                dishes and its settings stay as they were. */}
            {day.date >= today && (
              <div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={t('actionFor', { action: t('dayChanges'), title: fmt.day(day.date) })}
                  aria-expanded={openActions === day.id}
                  aria-controls={`${day.id}-actions`}
                  onClick={() => setOpenActions(openActions === day.id ? null : day.id)}
                >
                  {t('dayChanges')} <span aria-hidden>{openActions === day.id ? '▲' : '▾'}</span>
                </Button>
                <div
                  id={`${day.id}-actions`}
                  role="group"
                  aria-label={t('dayActions', { day: fmt.day(day.date) })}
                  hidden={openActions !== day.id}
                  className="ml-3 flex flex-wrap items-center gap-x-3"
                >
                  {!day.skipped && (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setWaysFor({ id: day.id, date: day.date })}
                        disabled={busy}
                      >
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
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setSettingsFor(day)}
                    disabled={busy}
                  >
                    {t('daySettingsButton')}
                  </Button>
                  {!day.skipped && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setHelpFor({ id: day.id, date: day.date })}
                    >
                      {tHelp('link')}
                    </Button>
                  )}
                </div>
              </div>
            )}
            <DaySettingsLine day={day} />
            {day.date < today && <p className="text-xs text-muted-foreground">{t('dayIsOver')}</p>}
            {thawsHere && thawsHere.forToday.length > 0 && (
              <p className="text-xs">
                {tFreezer('thawToday', { items: thawItems(thawsHere.forToday) })}
              </p>
            )}
            {thawsHere && thawsHere.forTomorrow.length > 0 && (
              <p className="text-xs">
                {tFreezer('thawTomorrow', { items: thawItems(thawsHere.forTomorrow) })}
              </p>
            )}
            {frozenHere.ofDay.map((rest) => frozenLine(rest, false))}
            {/* What the diary adds to the day is counted in its figures above; the diary of a day that has come is a link away,
                and the day's history beside it, on every day. */}
            <p className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
              {day.diary && (
                <span>
                  {day.diary.otherPlans.length > 0
                    ? t('otherPlansLine', {
                        from: day.diary.entries > 0 ? 'both' : 'plans',
                        kcal: day.diary.nutrition.calories,
                      })
                    : t('diaryLine', {
                        kcal: day.diary.nutrition.calories,
                        count: day.diary.entries,
                      })}
                </span>
              )}
              {day.date <= today && (
                <Link
                  href={`/diary?profile=${plan.profileId}&date=${day.date}`}
                  className="inline-flex min-h-6 items-center underline underline-offset-2 hover:text-foreground"
                >
                  {t('openDiary')}
                </Link>
              )}
              <button
                type="button"
                aria-haspopup="dialog"
                className="inline-flex min-h-6 items-center underline underline-offset-2 hover:text-foreground"
                onClick={() => onHistory(day)}
              >
                {t('toastHistory')}
              </button>
            </p>
            {/* A day off its target says so for as long as it is: a notice that goes away is easy to miss. Where the plan has
                a way to close the gap, the mark opens the question of what to do, with each way said before it is pressed;
                where it has none, the mark says why in a line of its own. */}
            {!day.skipped &&
              day.offTarget &&
              (day.resizes || spreadsFrom(plan, day, today) ? (
                <p className="text-xs">
                  <button
                    type="button"
                    aria-haspopup="dialog"
                    onClick={() =>
                      setOffTargetFor({
                        day,
                        spreads: spreadsFrom(plan, day, today),
                        listed: plan.days.some(
                          (other) =>
                            other.listed &&
                            !other.skipped &&
                            other.date >= (day.date < today ? day.date : today),
                        ),
                      })
                    }
                    className="inline-flex min-h-6 items-center gap-0.5 whitespace-nowrap rounded bg-warning/15 px-1.5 py-0.5 text-2xs font-medium text-warning hover:bg-warning/25"
                  >
                    {t(day.offTarget === 'over' ? 'dayOver' : 'dayUnder')}
                    <ChevronRight size={12} aria-hidden />
                  </button>
                </p>
              ) : (
                <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-warning">
                  <span className="whitespace-nowrap rounded bg-warning/15 px-1.5 py-0.5 text-2xs font-medium">
                    {t(day.offTarget === 'over' ? 'dayOver' : 'dayUnder')}
                  </span>
                  <span>
                    {t(
                      day.diary
                        ? day.offTarget === 'over'
                          ? 'dayOverDiaryHint'
                          : 'dayUnderDiaryHint'
                        : day.offTarget === 'over'
                          ? 'dayOverHint'
                          : 'dayUnderHint',
                    )}
                  </span>
                </p>
              ))}
            {!day.skipped && (
              <p className="text-xs text-muted-foreground">
                {t('dayMacros', {
                  protein: day.dayNutrition.protein,
                  proteinTarget: day.targetMacros.protein,
                  fat: day.dayNutrition.fat,
                  fatTarget: day.targetMacros.fat,
                  carbs: day.dayNutrition.carbs,
                  carbsTarget: day.targetMacros.carbs,
                  ...bandValues(day.targetMacros),
                  standing: carbsStandingOf(day.dayNutrition.carbs, day.targetMacros),
                })}
              </p>
            )}
            {!day.skipped &&
              day.macrosOff &&
              (day.macrosOffWhy ? (
                <MacrosOffWhy
                  why={day.macrosOffWhy}
                  mealName={(slot) => (tMeal.has(slot) ? tMeal(slot) : slot)}
                />
              ) : (
                <p className="text-xs text-warning">{t('macrosOffHint')}</p>
              ))}
            {/* Far less protein than the day aims at, which its split does not show. */}
            {!day.skipped && day.proteinShort && (
              <p className="text-xs text-warning">
                {t('proteinShort', {
                  protein: day.dayNutrition.protein,
                  target: day.targetMacros.protein,
                })}
              </p>
            )}
            {/* Under the day's figures, and after what keeps them off where they are: how the day is changed. A day
                before today is history and has no way to change it. */}
            {!day.skipped && day.date >= today && (
              <p className="text-xs">
                <button
                  type="button"
                  className="inline-flex min-h-6 items-center text-primary underline-offset-2 hover:underline"
                  onClick={() => setHelpFor({ id: day.id, date: day.date })}
                >
                  {tHelp('link')}
                </button>
              </p>
            )}
            {!day.skipped && (
              <>
                {/* What the label adds stands behind a tap: the figures above are what a day is planned by. */}
                <details className="text-xs text-muted-foreground">
                  <summary className="w-fit cursor-pointer py-1">{t('dayLabel')}</summary>
                  <div className="mt-1 space-y-1">
                    <LabelLine totals={day.dayLabel} />
                    <LabelLegend totals={day.dayLabel} className="mt-0" />
                  </div>
                </details>
                <LabelNotes notes={day.labelNotes} />
              </>
            )}
            {day.belowSafetyFloor && <p className="text-xs text-warning">{t('dayBelowFloor')}</p>}
            <ul className="divide-y divide-border text-sm">
              {day.meals.map((m, index) => {
                const eaten = m.eatenAt !== null;
                const isCustom = m.source === 'USER_CUSTOM' || m.recipe === null;
                const title = fmt.text(
                  isCustom ? (m.customName ?? t('customMeal')) : m.recipe!.title,
                );
                // A control of this meal by a name of its own: among the buttons of a plan, "Swap" alone is every meal's.
                const named = (action: string): string => t('actionFor', { action, title });
                const favOpen = openFav === m.id;
                const actionsOpen = openActions === m.id;
                // A meal of a day that is over, or that is skipped, keeps its dish.
                const changeable = !day.skipped && day.date >= today;
                // A leftover is cooked already: no other dish is drawn for it.
                const swappable = !eaten && !isCustom && changeable && m.leftover === null;
                // What else a meal can be given: its rest carried to the next day, or a leftover carried back.
                const carries = m.leftoverOffer !== null;
                const undoable = m.leftover?.undoable === true;
                const carryOff =
                  m.leftoverOffer && m.leftoverOffer !== 'ok'
                    ? LEFTOVER_OFF[m.leftoverOffer]
                    : null;
                // A shared meal is marked eaten for both, and cooked apart or in one pot, from its group.
                const eatenByBoth =
                  !!m.shared && !eaten && !m.shared.with.eaten && day.date <= today;
                const cooksApart = !!m.shared && !m.leftover;
                const folded = swappable || carries || undoable || eatenByBoth || cooksApart;
                // What follows for the other meal of its cooking when this one leaves it.
                const apart = cookWords.apart(m, day.date, today);
                // The dish of the day before, for a meal that was parted from it: a press brings the two together again.
                const dayBefore = plan.days[plan.days.indexOf(day) - 1];
                const parted =
                  plan.options.mealPrepFriendly &&
                  !m.cookAhead &&
                  dayBefore &&
                  dayBefore.date >= today &&
                  !dayBefore.skipped
                    ? dayBefore.meals.find(
                        (one) =>
                          one.mealType === m.mealType &&
                          one.recipe !== null &&
                          one.recipe.id !== m.recipe?.id &&
                          !one.cookAhead &&
                          one.leftover === null &&
                          one.eatenAt === null &&
                          one.source !== 'USER_CUSTOM',
                      )
                    : undefined;
                const mealLabel = tMeal.has(m.mealType)
                  ? tMeal(m.mealType)
                  : m.mealType.replace('_', ' ');
                // What the generation said of this meal: the report speaks of the recipes it placed.
                const said = <T extends { date: string; slot: string }>(
                  entries: T[] | undefined,
                ): T | undefined =>
                  isCustom
                    ? undefined
                    : entries?.find(
                        (entry) => entry.date === day.date && entry.slot === m.mealType,
                      );
                const outside = said(plan.report?.relaxations);
                const onlyRecipe = said(plan.report?.singleCandidate);
                // Made again with its day, it got the recipe it held: said where the diet did not leave it one alone.
                const sameAgain = !onlyRecipe && said(plan.report?.sameAgain);
                const byModel = partInMeal(m);
                // What the meal holds that the profile would rather not eat, by name.
                const disliked = m.ingredients
                  .filter((line) => m.dislikedIngredientIds.includes(line.ingredientId))
                  .map((line) => line.name);
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
                // What the diary and the other plans hold for this meal of the day follows its last meal of that kind.
                const last = day.meals.findLast((one) => one.mealType === m.mealType) === m;
                const written = last
                  ? (day.diary?.items ?? []).filter((entry) => entry.mealType === m.mealType)
                  : [];
                const eatenElsewhere = last
                  ? (day.diary?.otherPlans ?? []).filter((meal) => meal.mealType === m.mealType)
                  : [];
                return (
                  <Fragment key={m.id}>
                    <DiaryLines
                      entries={withoutMeal.filter((entry) => placeOf(entry) === index)}
                      others={othersWithoutMeal.filter((meal) => placeOf(meal) === index)}
                      profileId={plan.profileId}
                      date={day.date}
                    />
                    <li
                      id={mealAnchor(m.id)}
                      tabIndex={-1}
                      className="space-y-1 py-2 focus:outline-none"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1">
                        <span className="flex min-w-0 flex-1 basis-64 items-start gap-2 break-words">
                          {/* The box takes a finger beyond its edge, without moving what stands beside it. */}
                          <label className="-m-2.5 flex shrink-0 p-2.5">
                            <input
                              type="checkbox"
                              className="mt-0.5 h-4 w-4 shrink-0"

                              checked={eaten}
                              disabled={busy || (!eaten && day.date > today)}
                              aria-label={named(t('markEaten'))}
                              title={!eaten && day.date > today ? t('eatenAhead') : t('markEaten')}
                              onChange={() => {
                                changing.current = mealAnchor(m.id);
                                onToggleEaten(m.id, !m.eatenAt);
                              }}
                            />
                          </label>
                          <span className="min-w-0">
                            <span className="text-muted-foreground">{mealLabel}</span>
                            <span aria-hidden className="hidden sm:inline">
                              {'\u00a0·'}
                            </span>{' '}
                            {isCustom ? (
                              <span className="font-medium">{title}</span>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setOpenRecipe(windowOf(plan, m))}
                                className="text-left font-medium text-primary wrap-anywhere hover:underline"
                              >
                                {title}
                              </button>
                            )}
                            {isCustom && (
                              <span className="ml-2 whitespace-nowrap rounded bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
                                {t('customChip')}
                              </span>
                            )}
                            {m.estimated && (
                              <span className="ml-2 whitespace-nowrap rounded bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
                                {t('estimatedChip')}
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
                              <span
                                key={conflict}
                                className="ml-2 whitespace-nowrap rounded bg-destructive/15 px-1.5 py-0.5 text-2xs font-medium text-destructive"
                              >
                                {t(`conflictChip.${conflict}`)}
                              </span>
                            ))}
                            {disliked.length > 0 && (
                              <span className="ml-2 whitespace-nowrap rounded bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
                                {t('dislikedChip')}
                              </span>
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
                            {/* The portion in words once it is a tenth off the plan's: a smaller difference is the sizing of an ordinary day and says nothing to the reader; the factor itself is in the meal's window. A leftover and the meal it was left of are parts of a portion, not resized; the rest of a pot is none of the meal's portion, which keeps its mark. */}
                            {Math.abs(m.quantityScale - 1) >= PORTION_CHIP_FROM &&
                              !m.leftover &&
                              (!m.carriedTo || m.carriedTo.fromPot) && (
                                <span className="ml-2 whitespace-nowrap rounded bg-primary/10 px-1.5 py-0.5 text-2xs text-foreground">
                                  {t('portionChip', { servings: portionOf(m) })}
                                </span>
                              )}
                            {m.cookAhead && (
                              <span className="ml-2 whitespace-nowrap rounded bg-primary/10 px-1.5 py-0.5 text-2xs text-foreground">
                                {cookWords.chip(m, day.date)}
                              </span>
                            )}
                            {m.leftover && (
                              <span className="ml-2 whitespace-nowrap rounded bg-primary/10 px-1.5 py-0.5 text-2xs text-foreground">
                                {cookWords.leftoverChip(m)}
                              </span>
                            )}
                            {/* In a plan made together, whether both eat the dish, and how it is cooked; or that it is one person's alone. */}
                            {(m.shared || plan.joint) && (
                              <span className="ml-2 whitespace-nowrap rounded bg-primary/10 px-1.5 py-0.5 text-2xs text-foreground">
                                {m.shared
                                  ? t(m.shared.apart ? 'sharedApartChip' : 'sharedChip')
                                  : t('onlyChip', { name: fmt.text(profileName) })}
                              </span>
                            )}
                          </span>
                        </span>

                        <span className="ml-3 flex flex-wrap items-center gap-x-4 sm:ml-0">
                          {/* Both eat it: one press marks it eaten for both, as the box marks it for this plan alone. */}
                          {eaten && (
                            <span className="text-xs font-medium text-muted-foreground">
                              {t('eatenBadge')}
                            </span>
                          )}
                          {!folded && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              aria-label={named(t('remove'))}
                              aria-expanded={removing === m.id}
                              onClick={() => setRemoving(removing === m.id ? null : m.id)}
                              disabled={busy}
                            >
                              {t('remove')}
                            </Button>
                          )}
                          {/* The ways to change a meal fold behind one button: a day is its meals, not five buttons a meal. */}
                          {!folded ? null : (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              aria-label={named(t('changeMeal'))}
                              aria-expanded={actionsOpen}
                              aria-controls={`${m.id}-actions`}
                              onClick={() => setOpenActions(actionsOpen ? null : m.id)}
                            >
                              {t('changeMeal')} <span aria-hidden>{actionsOpen ? '▲' : '▾'}</span>
                            </Button>
                          )}
                        </span>
                      </div>
                      {folded && (
                        <div
                          id={`${m.id}-actions`}
                          role="group"
                          aria-label={t('mealActions', { title })}
                          hidden={!actionsOpen}
                          className="ml-3 flex flex-wrap items-center gap-x-1"
                        >
                          {eatenByBoth && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              aria-label={named(t('eatenTogether'))}
                              onClick={() => {
                                changing.current = mealAnchor(m.id);
                                onToggleEaten(m.id, true, true);
                              }}
                              disabled={busy}
                            >
                              {t('eatenTogether')}
                            </Button>
                          )}
                          {/* Cooked apart, each portion is its own; in one pot the pot is split by weight, as near as a split comes. A leftover is cooked already. */}
                          {cooksApart && (
                            <label className="inline-flex min-h-8 items-center gap-1.5 px-3 text-sm">
                              <input
                                type="checkbox"
                                className="h-4 w-4"
                                checked={m.shared!.apart}
                                disabled={busy}
                                onChange={() => onSetApart(m.shared!.id, !m.shared!.apart)}
                              />
                              {t('cookApart')}
                            </label>
                          )}
                          {swappable && parted && dayBefore && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => onSwapToFavorite(m.id, parted.recipe!.id, false)}
                              disabled={busy}
                            >
                              {t('cooking.same', { day: fmt.weekday(dayBefore.date) })}
                            </Button>
                          )}
                          {swappable && (
                            <>
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
                            </>
                          )}
                          {carries && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              aria-label={named(t('leftover.action'))}
                              aria-describedby={carryOff ? `${m.id}-carry-off` : undefined}
                              onClick={() => setCarrying({ meal: m, date: day.date })}
                              disabled={busy || carryOff !== null}
                            >
                              {t('leftover.action')}
                            </Button>
                          )}
                          {undoable && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              aria-label={named(t('leftover.undo'))}
                              onClick={() => setUndoing(m)}
                              disabled={busy}
                            >
                              {t('leftover.undo')}
                            </Button>
                          )}
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            aria-label={named(t('remove'))}
                            aria-expanded={removing === m.id}
                            onClick={() => setRemoving(removing === m.id ? null : m.id)}
                            disabled={busy}
                          >
                            {t('remove')}
                          </Button>
                          {carryOff && (
                            <p
                              id={`${m.id}-carry-off`}
                              className="basis-full px-3 text-xs text-muted-foreground"
                            >
                              {t(`leftover.${carryOff}`)}
                            </p>
                          )}
                        </div>
                      )}
                      {removing === m.id && (
                        <div
                          className="ml-6 space-y-1 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs"
                          role="group"
                          aria-label={t('removeTitle', { title })}
                        >
                          <p>{t(eaten ? 'removeNoteEaten' : 'removeNote')}</p>
                          {apart && <p>{apart}</p>}
                          {m.shared && !m.shared.with.eaten && (
                            <p>
                              {t('removeShared', { name: fmt.text(m.shared.with.profileName) })}
                            </p>
                          )}
                          <ListNote listed={day.listed} />
                          <div className="flex flex-wrap gap-2 pt-1">
                            {m.shared && !m.shared.with.eaten && (
                              <Button
                                type="button"
                                size="sm"
                                variant="destructive"
                                onClick={() => {
                                  setRemoving(null);
                                  changing.current = dayAnchor(plan.id, day.date);
                                  onRemoveMeal(m.id, true);
                                }}
                                disabled={busy}
                              >
                                {t('removeForAll')}
                              </Button>
                            )}
                            <Button
                              type="button"
                              size="sm"
                              variant={m.shared && !m.shared.with.eaten ? 'outline' : 'destructive'}
                              onClick={() => {
                                setRemoving(null);
                                changing.current = dayAnchor(plan.id, day.date);
                                onRemoveMeal(m.id);
                              }}
                              disabled={busy}
                            >
                              {t(
                                m.shared && !m.shared.with.eaten ? 'removeForMe' : 'removeConfirm',
                              )}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => setRemoving(null)}
                            >
                              {tCommon('cancel')}
                            </Button>
                          </div>
                        </div>
                      )}
                      {offer?.asked.plannedMealId === m.id && (
                        <div
                          className="ml-6 space-y-1 rounded-md border border-primary/30 bg-primary/5 p-2 text-xs"
                          role="group"
                          aria-label={t('offerTitle')}
                        >
                          {/* A dish for both is held to what both may be given; for oneself alone the meal stops being shared that day. */}
                          {m.shared && (
                            <fieldset className="flex flex-wrap gap-x-4 gap-y-1">
                              <legend className="sr-only">{t('offerForWhom')}</legend>
                              {[true, false].map((forAll) => (
                                <label
                                  key={String(forAll)}
                                  className="inline-flex items-center gap-1.5"
                                >
                                  <input
                                    type="radio"
                                    name={`${m.id}-for`}
                                    className="h-4 w-4"
                                    checked={(offer.asked.forAll ?? false) === forAll}
                                    disabled={busy}
                                    onChange={() => onOfferFor(forAll)}
                                  />
                                  {forAll
                                    ? t('offerForAll', {
                                        name: fmt.text(m.shared!.with.profileName),
                                      })
                                    : t('offerForMe')}
                                </label>
                              ))}
                            </fieldset>
                          )}
                          {/* A model's own pick says so, with its reason, before it is taken. */}
                          {offer.preview.pick && (
                            <AiMark
                              part={{
                                kind: 'picked',
                                reason: offer.preview.aiMeta?.reason ?? null,
                              }}
                              spelledOut
                            />
                          )}
                          {/* A topping the model named for this plate, put on in the amount the day needs. */}
                          {offer.preview.topping && (
                            <p className="text-xs">
                              {t('offerTopping', { name: fmt.text(offer.preview.topping.name) })}
                            </p>
                          )}
                          <p>
                            {t.rich('offerLine', {
                              title: fmt.text(offer.preview.recipe.title),
                              servings: offer.preview.servings,
                              after: offer.preview.after.calories,
                              before: offer.preview.before.calories,
                              strong: (chunks) => <span className="font-medium">{chunks}</span>,
                            })}
                          </p>
                          <p className="text-muted-foreground">
                            {t('offerMacros', {
                              protein: offer.preview.after.protein,
                              fat: offer.preview.after.fat,
                              carbs: offer.preview.after.carbs,
                            })}
                          </p>
                          <p className="text-muted-foreground">
                            {/* The other meals are fitted to the day only where it comes out away from its target. */}
                            {t(
                              Math.abs(
                                offer.preview.dayAfter.calories - offer.preview.calorieTarget,
                              ) >
                                offer.preview.calorieTarget * DAY_ON_TARGET
                                ? 'offerDay'
                                : 'offerDayAfter',
                              {
                                kcal: offer.preview.dayAfter.calories,
                                target: offer.preview.calorieTarget,
                              },
                            )}{' '}
                            {t('dayMacros', {
                              protein: offer.preview.dayAfter.protein,
                              proteinTarget: offer.preview.targetMacros.protein,
                              fat: offer.preview.dayAfter.fat,
                              fatTarget: offer.preview.targetMacros.fat,
                              carbs: offer.preview.dayAfter.carbs,
                              carbsTarget: offer.preview.targetMacros.carbs,
                              ...bandValues(offer.preview.targetMacros),
                              standing: carbsStandingOf(
                                offer.preview.dayAfter.carbs,
                                offer.preview.targetMacros,
                              ),
                            })}
                          </p>
                          <CookingNote
                            change={offer.preview.cooking}
                            only={onlyFor === m.id}
                            onOnly={(only) => setOnlyFor(only ? m.id : null)}
                            label="only"
                            mealName={mealName}
                          />
                          {offer.preview.outsideLimits.length > 0 && (
                            <p className="text-warning">
                              {t('offerOutside', {
                                limits: limitNames(offer.preview.outsideLimits),
                              })}
                            </p>
                          )}
                          <ListNote
                            days={
                              onlyFor === m.id || !offer.preview.cooking?.changes.length
                                ? 'one'
                                : 'several'
                            }
                            listed={
                              day.listed ||
                              (onlyFor !== m.id &&
                                (offer.preview.cooking?.changes ?? []).some(
                                  (change) =>
                                    plan.days.find((other) => other.date === change.date)?.listed,
                                ))
                            }
                          />
                          <div className="flex flex-wrap gap-2 pt-1">
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => {
                                setOpenActions(null);
                                changing.current = mealAnchor(m.id);
                                onTakeOffer(
                                  onlyFor !== m.id &&
                                    (offer.preview.cooking?.changes.length ?? 0) > 0,
                                );
                                setOnlyFor(null);
                              }}
                              disabled={busy}
                            >
                              {t('offerTake')}
                            </Button>
                            {/* A favourite picked by hand is the one the user asked for: there is no other to offer. */}
                            {offer.asked.strategy !== 'favorite' && (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={onAnotherOffer}
                                disabled={busy}
                              >
                                {t('offerAnother')}
                              </Button>
                            )}
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setOnlyFor(null);
                                onCancelOffer();
                              }}
                            >
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
                        <p key={conflict} className="ml-6 text-xs text-destructive">
                          {t(`conflictHint.${conflict}`)}
                        </p>
                      ))}
                      {m.dietOverride && (
                        <p className="ml-6 text-xs text-warning">
                          {t('dietOverrideHint', { diet: dietLabel })}
                        </p>
                      )}
                      {disliked.length > 0 && (
                        <p className="ml-6 text-xs text-muted-foreground">
                          {t('dislikedHint', { foods: fmt.list(disliked) })}
                        </p>
                      )}
                      {outside && (
                        <p className="ml-6 text-xs text-muted-foreground">
                          {t('outsideLimitHint', { limits: limitNames(outside.gaveWay) })}
                        </p>
                      )}
                      {onlyRecipe && (
                        <p className="ml-6 text-xs text-muted-foreground">{t('onlyRecipeHint')}</p>
                      )}
                      {sameAgain && (
                        <p className="ml-6 text-xs text-muted-foreground">{t('sameAgainHint')}</p>
                      )}
                      {m.cookAhead && (
                        <p className="ml-6 text-xs text-muted-foreground">
                          {cookWords.hint(m, day.date)}
                        </p>
                      )}
                      {/* What the pot will have left beside the portion, or that the pot holds the portion where its day would have given it more; nothing where the meal takes what was cooked for it, nor once its rest went to the day after, which the leftover's line says. */}
                      {m.pot && (m.pot.rest > 0 || (m.pot.held && !m.carriedTo)) && (
                        <div className="ml-6 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                          <span>
                            {m.pot.rest > 0
                              ? t('potRest', {
                                  servings: Math.round(m.pot.rest * 10) / 10,
                                  kcal: Math.round(
                                    (m.nutrition.calories / (m.servings * m.quantityScale)) *
                                      m.pot.rest,
                                  ),
                                })
                              : t('potHeld', { servings: Math.round(m.pot.cooked * 10) / 10 })}
                          </span>
                          {m.pot.offer !== null && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              aria-label={named(t('potAction'))}
                              aria-describedby={
                                m.pot.offer !== 'ok' ? `${m.id}-pot-off` : undefined
                              }
                              onClick={() =>
                                setCarrying({ meal: m, date: day.date, fromPot: true })
                              }
                              disabled={busy || m.pot.offer !== 'ok'}
                            >
                              {t('potAction')}
                            </Button>
                          )}
                          {m.pot.offer !== null && m.pot.offer !== 'ok' && (
                            <span id={`${m.id}-pot-off`}>
                              {t(`leftover.${LEFTOVER_OFF[m.pot.offer]}`)}
                            </span>
                          )}
                        </div>
                      )}
                      {(m.leftover || m.carriedTo) && (
                        <p className="ml-6 text-xs text-muted-foreground">
                          {cookWords.leftoverHint(m)}
                        </p>
                      )}
                      {(frozenHere.byMeal.get(m.id) ?? []).map((rest) => frozenLine(rest, true))}
                      {m.topping && (
                        <p className="ml-6 text-xs">
                          {t('toppingLine', {
                            name: fmt.text(m.topping.ingredient.name),
                            amount: shownAmount(m.topping.ingredient.display),
                            kcal: m.topping.nutrition.calories,
                          })}
                        </p>
                      )}
                      {((m.cookAhead === 'cook' && m.cooking) ||
                        (m.shared && !m.shared.apart && !m.leftover)) && (
                        <div className="ml-6">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="-ml-3"
                            onClick={() =>
                              setSplitting(
                                m.cookAhead === 'cook' && m.cooking
                                  ? mealsOfCooking(plan, m)
                                  : [{ meal: m, date: day.date }],
                              )
                            }
                          >
                            {tSplit('open')}
                          </Button>
                        </div>
                      )}
                      {cookWords.notCooked(m, day.date, today) && (
                        <p className="ml-6 text-xs text-warning">
                          {cookWords.notCooked(m, day.date, today)}
                        </p>
                      )}
                      {isCustom && (
                        <p className="ml-6 text-xs italic text-muted-foreground">
                          {t(m.estimated ? 'customEstimatedNote' : 'customMacrosNote')}
                        </p>
                      )}
                      {favOpen && !isCustom && (
                        <div className="ml-6 rounded-md border border-border bg-muted/40 p-2">
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
                                      <span>{fmt.text(f.recipe.title)}</span>
                                      <span className="flex shrink-0 items-center gap-1">
                                        {crossSlot && (
                                          <span className="rounded bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
                                            {f.recipe.mealTypes
                                              .map((mt) => (tMeal.has(mt) ? tMeal(mt) : mt))
                                              .join(DOT)}
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
                    <DiaryLines
                      entries={written}
                      others={eatenElsewhere}
                      profileId={plan.profileId}
                      date={day.date}
                    />
                  </Fragment>
                );
              })}
              <DiaryLines
                entries={withoutMeal.filter((entry) => placeOf(entry) === -1)}
                others={othersWithoutMeal.filter((meal) => placeOf(meal) === -1)}
                profileId={plan.profileId}
                date={day.date}
              />
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
        )}
      </div>
    );
  };

  return (
    <Card className="relative w-full">
      {/* What the plan is opens it: one control, with the triangle of a list that unfolds beside what it names. On a narrow screen what can be done with the plan goes under it. */}
      <div className="relative flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-4">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 basis-56 items-start gap-2 text-left"
        >
          {/* Drawn, not typed: a typed triangle comes out as a coloured picture where the font has one. */}
          <ChevronRight
            size={16}
            aria-hidden
            className={cn('mt-1 shrink-0 text-muted-foreground', open && 'rotate-90')}
          />
          <span className="min-w-0">
            <span className="sr-only">{t(open ? 'hidePlan' : 'showPlan')}: </span>
            <span className="block font-medium">
              {t('planSummary', { days: summary.durationDays, dietType: dietLabel })}
              {summary.generationMode === 'ai_assisted' && (
                <AiMark part={{ kind: 'plan' }} className="ml-2 align-middle" />
              )}
            </span>
            <span className="block text-sm text-muted-foreground">
              {t('planMeta', {
                date: fmt.date(summary.startDate),
                kcal: summary.averageDailyNutrition.calories,
                pct: Math.round(summary.ingredientReuseScore * 100),
              })}
            </span>
            {summary.joint && (
              <span className="block text-sm text-muted-foreground">
                {t('jointWith', { name: fmt.text(summary.joint.profileName) })}
              </span>
            )}
          </span>
        </button>
        <div className="flex flex-wrap items-center gap-2">
          <ApplyFavoriteSetButton
            plan={summary}
            profileId={summary.profileId}
            disabled={busy}
            listedDates={plan?.days.filter((day) => day.listed).map((day) => day.date)}
            onApplied={(changed, dates) =>
              onChanged({ plan: changed, cause: 'favorite-set', date: dates[0] ?? null })
            }
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setReroll({ scope: 'whole' })}
            disabled={busy}
          >
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
          {unanswered ? (
            <ReadsFailed reads={[unanswered]} unanswered />
          ) : (
            <Skeleton className="h-40" />
          )}
        </CardContent>
      )}
      {open && plan && (
        <CardContent className="space-y-4 border-t border-border p-3 pt-4 sm:p-5 sm:pt-4">
          <div className="flex flex-wrap items-center gap-2">
            {/* A long plan is a long way down to the day it is now: one press takes the reader there. */}
            {plan.days.some((day) => day.date === today) && (
              <Button type="button" variant="outline" size="sm" onClick={() => goToDay(today)}>
                {t('goToToday')}
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                saveText(
                  csvOf(planTable(plan, words), CSV_DIALECTS[locale] ?? CSV_DIALECTS.en!),
                  `meal-plan-${plan.startDate}_${lastDayOf(plan)}.csv`,
                  'text/csv',
                )
              }
            >
              {tExport('csv')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setPrinting(true)}
              disabled={printing}
            >
              {tExport('print')}
            </Button>
            {/* A plan made together is bought as one: the pot of its shared dishes by a household list of both plans. */}
            {plan.joint && (
              <Link
                href={`/shopping-lists?profile=${plan.profileId}&plan=${plan.id}&together=1`}
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
              >
                {t('jointList')}
              </Link>
            )}
          </div>
          {printing && (
            <PlanPrintSheet plan={plan} dietLabel={dietLabel} words={words} onDone={printed} />
          )}
          <div className="space-y-1 text-xs text-muted-foreground">
            <p>
              {t('planMacros', {
                protein: plan.averageDailyNutrition.protein,
                proteinTarget: plan.targetMacros.protein,
                fat: plan.averageDailyNutrition.fat,
                fatTarget: plan.targetMacros.fat,
                carbs: plan.averageDailyNutrition.carbs,
                carbsTarget: plan.targetMacros.carbs,
                ...bandValues(plan.targetMacros),
                standing: carbsStandingOf(plan.averageDailyNutrition.carbs, plan.targetMacros),
              })}
            </p>
            {plan.averageOff.calories && (
              <p className="text-warning">
                {t(plan.averageOff.calories === 'over' ? 'planAverageOver' : 'planAverageUnder')}
              </p>
            )}
            {plan.averageOff.macros && <p className="text-warning">{t('planAverageMacros')}</p>}
            {plan.packs.bought > 0 && (
              <PlanPacksLine
                packs={plan.packs}
                together={plan.joint ? fmt.text(plan.joint.profileName) : undefined}
                busy={busy}
                onKeepLeft={onKeepLeft}
              >
                {plan.packs.open.some((pack) => pack.wasted) && (
                  <UseUp
                    planId={plan.id}
                    listedDates={plan.days.filter((day) => day.listed).map((day) => day.date)}
                    aiEnabled={aiEnabled}
                    aiOffNote={aiOffNote}
                    mealName={mealName}
                    busy={busy}
                    onSwapped={(result, plannedMealId) => {
                      changing.current = null;
                      onSwapped(result, plannedMealId);
                    }}
                    onStale={() => {
                      changing.current = null;
                      onChanged();
                    }}
                  />
                )}
              </PlanPacksLine>
            )}
          </div>
          {(plan.options.allowRelaxations.length > 0 ||
            pantryLine ||
            plan.options.lessWaste ||
            (plan.report?.apart.length ?? 0) > 0) && (
            <div className="space-y-1 text-xs text-muted-foreground">
              {(plan.report?.apart.length ?? 0) > 0 && (
                <p>
                  {t('jointApart', {
                    meals: fmt.list(
                      plan.report!.apart.map((slot) => mealName(slot).toLocaleLowerCase(locale)),
                    ),
                  })}
                </p>
              )}
              {plan.options.allowRelaxations.length > 0 && (
                <p className="flex flex-wrap items-center gap-2">
                  {t('planMayGiveWay', { limits: limitNames(plan.options.allowRelaxations) })}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setReroll({ scope: 'whole', holdLimits: true })}
                    disabled={busy}
                  >
                    {t('holdLimits')}
                  </Button>
                </p>
              )}
              {pantryLine && <p>{t(pantryLine)}</p>}
              {plan.options.noWaste ? (
                <p>{t('planNoWaste')}</p>
              ) : (
                plan.options.lessWaste && <p>{t('planLessWaste')}</p>
              )}
            </div>
          )}
          {conflicts > 0 && (
            <p
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {t('conflictsNotice', { count: conflicts })}
            </p>
          )}
          <TargetMovedLine
            plan={plan}
            onTaken={(changed) =>
              onChanged(changed && { plan: changed, cause: 'retarget', date: null })
            }
          />
          {plan.days.length > DAYS_A_WEEK ? (
            <Tabs
              label={t('planWeeks')}
              tabs={Array.from(
                { length: Math.ceil(plan.days.length / DAYS_A_WEEK) },
                (_, index) => ({
                  id: String(index),
                  title: t('planWeek', { week: index + 1 }),
                  content: () => (
                    <div className="space-y-3">
                      <WeekLine
                        planId={plan.id}
                        revision={plan.revision}
                        week={plan.weeks[index]}
                        onEvened={(changed) =>
                          onChanged(changed && { plan: changed, cause: 'week-evened', date: null })
                        }
                      />
                      {plan.days
                        .slice(index * DAYS_A_WEEK, (index + 1) * DAYS_A_WEEK)
                        .map((day) => dayCard(plan, day))}
                    </div>
                  ),
                }),
              )}
              active={String(chosenWeek ?? weekOf(firstOpen))}
              onSelect={(week) => setChosenWeek(Number(week))}
            />
          ) : (
            <div className="space-y-3">
              <WeekLine
                planId={plan.id}
                revision={plan.revision}
                week={plan.weeks[0]}
                onEvened={(changed) =>
                  onChanged(changed && { plan: changed, cause: 'week-evened', date: null })
                }
              />
              {plan.days.map((day) => dayCard(plan, day))}
            </div>
          )}
        </CardContent>
      )}
      {helpFor && (
        <DayChangeHelp
          date={helpFor.date}
          joint={Boolean(plan?.joint)}
          busy={busy}
          onVariants={() => {
            setWaysFor(helpFor);
            setHelpFor(null);
          }}
          onReroll={() => {
            setReroll({ scope: 'day', day: helpFor.date });
            setHelpFor(null);
          }}
          onClose={() => setHelpFor(null)}
        />
      )}
      {waysFor && (
        <DayVariationsDialog
          planId={summary.id}
          day={waysFor}
          aiEnabled={aiEnabled}
          aiOffNote={aiOffNote}
          mealName={mealName}
          onClose={() => setWaysFor(null)}
          onChanged={(changed) => {
            changing.current = dayAnchor(summary.id, waysFor.date);
            onChanged(changed && { plan: changed, cause: 'day-variant', date: waysFor.date });
          }}
        />
      )}
      {splitting && (
        <SplitDialog
          cooked={splitting}
          ownName={profileName}
          words={{
            label: (part) => {
              const weekday = fmt.weekday(part.date, 'long');
              const when = tSplit('portionOf', {
                day: weekday.charAt(0).toLocaleUpperCase(locale) + weekday.slice(1),
                meal: mealName(part.mealType).toLocaleLowerCase(locale),
              });
              return part.who === null
                ? when
                : tSplit('portionOfWho', { who: fmt.text(part.who), when });
            },
            list: fmt.list,
          }}
          onClose={() => setSplitting(null)}
        />
      )}
      {carrying && plan && (
        <LeftoverDialog
          plan={plan}
          meal={carrying.meal}
          date={carrying.date}
          fromPot={carrying.fromPot === true}
          onClose={() => setCarrying(null)}
          onDone={(result, notice, to) => onLeftover(result, notice, to)}
        />
      )}
      {undoing && (
        <LeftoverUndoDialog
          planId={summary.id}
          meal={undoing}
          onClose={() => setUndoing(null)}
          onDone={(result) => {
            changing.current = mealAnchor(undoing.id);
            onLeftover(result, null, null);
          }}
        />
      )}
      {offTargetFor && (
        <DayOffTargetDialog
          ways={offTargetFor}
          busy={busy}
          onResize={() => {
            changing.current = dayAnchor(summary.id, offTargetFor.day.date);
            onResizeDay(offTargetFor.day.date);
            setOffTargetFor(null);
          }}
          onSpread={() => {
            changing.current = dayAnchor(summary.id, offTargetFor.day.date);
            // The remaining days of the plan take it: from today, or from the day itself where it is over already.
            onSpread(offTargetFor.day.date < today ? offTargetFor.day.date : today);
            setOffTargetFor(null);
          }}
          onClose={() => setOffTargetFor(null)}
        />
      )}
      {settingsFor && (
        <DaySettingsDialog
          planId={summary.id}
          profileId={summary.profileId}
          day={settingsFor}
          week={plan?.weeks.find(
            (week) => week.from <= settingsFor.date && settingsFor.date <= week.to,
          )}
          mealName={mealName}
          limitNames={limitNames}
          onClose={() => setSettingsFor(null)}
          onSaved={(changed, cause) => {
            changing.current = dayAnchor(summary.id, settingsFor.date);
            onChanged(
              changed && cause ? { plan: changed, cause, date: settingsFor.date } : undefined,
            );
          }}
        />
      )}
      {reroll && (
        <RerollDialog
          planId={summary.id}
          title={t('planSummary', { days: summary.durationDays, dietType: dietLabel })}
          start={reroll}
          profileDiet={profileDiet}
          profileRepeats={profileRepeats}
          limitNames={limitNames}
          mealName={mealName}
          onClose={() => setReroll(null)}
          onSubmit={(asked) => {
            changing.current = reroll.day ? dayAnchor(summary.id, reroll.day) : null;
            onReroll(asked);
          }}
        />
      )}
      {customDay && (
        <CustomMealModal
          date={customDay}
          meals={(plan?.days.find((day) => day.date === customDay)?.meals ?? []).map((meal) => ({
            id: meal.id,
            mealType: meal.mealType,
            title: fmt.text(meal.recipe?.title ?? meal.customName ?? t('customMeal')),
            apart: cookWords.apart(meal, customDay, today),
          }))}
          listed={plan?.days.find((day) => day.date === customDay)?.listed ?? false}
          onClose={() => setCustomDay(null)}
          onSubmit={(body) => {
            changing.current = dayAnchor(summary.id, customDay);
            onAddCustomMeal(customDay, body);
            setCustomDay(null);
          }}
        />
      )}
      {openSub && (
        <IngredientSubstituteModal
          meal={openSub}
          planId={summary.id}
          listed={
            plan?.days.find((day) => day.meals.some((meal) => meal.id === openSub.id))?.listed ??
            false
          }
          onClose={() => setOpenSub(null)}
          mealName={mealName}
          onApplied={(result) => {
            setOpenActions(null);
            changing.current = mealAnchor(openSub.id);
            onIngredientSwapped(result, openSub.id);
          }}
        />
      )}
      {openRecipe && (
        <RecipeModal
          recipeId={openRecipe.id}
          amounts={openRecipe.amounts}
          picked={openRecipe.picked ?? null}
          portion={openRecipe.portion}
          pot={openRecipe.pot}
          label={openRecipe.label}
          scale={openRecipe.scale}
          shared={openRecipe.shared}
          topping={openRecipe.topping}
          onClose={() => {
            setOpenRecipe(null);
            // Opened for the diary: back to it.
            if (openRecipe.back) window.history.back();
          }}
        />
      )}
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
    own.cookTimeBudgetMinutes !== undefined
      ? t('lineCookTime', { minutes: own.cookTimeBudgetMinutes })
      : null,
    own.useUpBy ? t('lineUseUp') : null,
  ].filter((line): line is string => line !== null);
  return said.length > 0 ? <p className="text-xs text-muted-foreground">{said.join(' ')}</p> : null;
}

/** The meals of a day in the order they are eaten. */
const DAY_ORDER: readonly string[] = MEAL_SLOTS_BY_COUNT[5]!;

/**
 * Entries of the day's diary in a plan, each under the meal it was written
 * for: what it is, how much, its figures and that it is the diary's, which
 * changes and removes it. A press on one opens the diary of that day.
 */
function DiaryLines({
  entries,
  others,
  profileId,
  date,
}: {
  entries: readonly DiaryEntry[];
  /** What the profile's other plans that hold the day had eaten at this time of day, before the entries. */
  others: readonly EatenInOtherPlan[];
  profileId: string;
  date: string;
}) {
  const t = useTranslations('mealPlans');
  const tMeal = useTranslations('enums.mealType');
  const amountOf = useEntryAmount();
  const fmt = useFormat();
  const named = (mealType: string) =>
    tMeal.has(mealType) ? tMeal(mealType) : mealType.replace('_', ' ');
  return [
    ...others.map((meal) => (
      <li key={meal.id} className="space-y-1 py-2">
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 break-words pl-6">
          <span className="text-muted-foreground">{named(meal.mealType)}</span>
          <span aria-hidden className="hidden sm:inline">
            ·
          </span>
          <Link
            href={`/meal-plans?profile=${profileId}&plan=${meal.planId}&day=${date}&meal=${meal.id}`}
            aria-label={t('openOtherPlan', { name: meal.name })}
            className="font-medium text-primary wrap-anywhere hover:underline"
          >
            {fmt.text(meal.name)}
          </Link>
          <span className="whitespace-nowrap rounded bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
            {t('fromOtherPlanChip')}
          </span>
        </p>
        <MacrosLine nutrition={meal.nutrition} />
      </li>
    )),
    ...entries.map((entry) => (
      <li key={entry.id} className="space-y-1 py-2">
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 break-words pl-6">
          <span className="text-muted-foreground">
            {tMeal.has(entry.mealType) ? tMeal(entry.mealType) : entry.mealType.replace('_', ' ')}
          </span>
          <span aria-hidden className="hidden sm:inline">
            ·
          </span>
          <Link
            href={`/diary?profile=${profileId}&date=${date}`}
            aria-label={t('openInDiary', { name: entry.name })}
            className="font-medium text-primary wrap-anywhere hover:underline"
          >
            {fmt.text(entry.name)}
          </Link>
          <span className="whitespace-nowrap rounded bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
            {t('fromDiaryChip')}
          </span>
          {entry.estimated && (
            <span className="whitespace-nowrap rounded bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
              {t('estimatedChip')}
            </span>
          )}
        </p>
        <p className="ml-6 text-xs text-muted-foreground">{amountOf(entry)}</p>
        <MacrosLine nutrition={entry.nutrition} />
      </li>
    )),
  ];
}

/** Per-meal macros as plain inline text, sitting below the recipe title. Full
 *  macro nouns (Protein / Białko) so it reads as a sentence, not a sticker
 *  strip. Each name keeps its figure on its line; the line breaks only after a dot. */
function MacrosLine({
  nutrition,
}: {
  nutrition: { calories: number; protein: number; fat: number; carbs: number };
}) {
  const t = useTranslations('macrosLine');
  const fmt = useFormat();
  return (
    <p className="ml-6 text-xs text-muted-foreground">
      {[
        `${t('protein')} ${fmt.unit(nutrition.protein, 'gram')}`,
        `${t('fat')} ${fmt.unit(nutrition.fat, 'gram')}`,
        `${t('carbs')} ${fmt.unit(nutrition.carbs, 'gram')}`,
        `${fmt.number(nutrition.calories)}\u00a0${t('kcal')}`,
      ]
        .map(held)
        .join(DOT)}
    </p>
  );
}
