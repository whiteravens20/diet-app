// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Closing the packs a plan opens: a step after the planner, for a plan that
 * wastes less.
 *
 * The planner fills one meal after another and never goes back, so what is
 * left of a pack a meal opens is left to whatever the days after it happen to
 * take. This goes over the plan as the planner left it and gives a meal
 * another recipe of the same meal wherever that leaves less in the packs that
 * do not keep, counted as a kitchen counts them (`packs.ts`): the pack a meal
 * opens is finished by another, or a meal that opened a pack for a little
 * takes from one that is open already.
 *
 * A swap is held to what the plan was made with. The recipe is one the plan
 * may be given for that meal, on its diet; it holds nothing the profile would
 * rather not eat and is not one the day is to do without. It is sized to the
 * energy the meal held, to the calorie, at a serving that comes within a tenth
 * of it, so that the day keeps its target. The day comes no further from its
 * split than a little past where the planner left it, every limit of the plan
 * holds, and the plans take no less of what the pantry holds. What stays in the plan, a meal locked to its place and a
 * favourite stay as they are; a dish cooked ahead is swapped at every meal it
 * feeds, and cooking ahead stays as it was.
 *
 * Plans can share a kitchen: the plans of two profiles planned together.
 * Their packs are counted together, and a meal that is one dish for both is
 * swapped in both, each in their portion.
 */
import {
  fitsDiet,
  MEAL_SLOTS_BY_COUNT,
  type DietType,
  type Macros,
  type MealType,
  type ProteinKind,
} from '@diet-app/shared';
import { cookAhead } from './cook-ahead.js';
import { distanceOnDiet, energyShares } from './nutrition.js';
import {
  fitServings,
  kindMealsAround,
  limitsBroken,
  SERVING_MAX,
  SERVING_MIN,
  type OptimizerDay,
  type OptimizerRecipe,
} from './optimizer.js';
import { packsLeftOver, SPOONFUL, type DailyNeeds, type Pack } from './packs.js';
import { aimOfPlanned, type SizedAssignment } from './rebalance.js';

/** A recipe in a meal's place comes, at the serving nearest the meal's energy, within this share of it. */
const ENERGY_WINDOW = 0.1;
/** How much further from its split than the planner left it a day may come: the share of its energy that would have to move. */
export const SPLIT_SLACK = 0.02;
/** The most times the plan is gone over: a swap can make room for another, and the passes stop when one changes nothing. */
const PASSES = 6;

/** The limits on how often a recipe and a kind of protein come, as the planner held the plan to them. */
interface ClosingLimits {
  consecutive: number;
  perWeek: number;
  perPlan?: number;
  perKind?: ReadonlyMap<ProteinKind, { perDay?: number; perWeek?: number }>;
  /** Whether one recipe may fill two meals of a day. Omitted: in a plan made for cooking ahead. */
  twiceADay?: boolean;
}

/** A plan as the planner made it, with what it was made with. */
export interface ClosingPlan {
  /** What the plan may be given: the recipes the planner chose from, for the meals each is for. */
  recipes: readonly OptimizerRecipe[];
  /** The days as the planner had them: the meals that stay, the locks, what a day is to do without, the time to cook. */
  days: readonly OptimizerDay[];
  /** What the planner placed, sized for its days. */
  assignments: readonly SizedAssignment[];
  /** The split the plan aims at, where a day has no aim of its own. */
  split: Macros;
  dietType: DietType;
  mealPrepFriendly: boolean;
  limits: ClosingLimits;
  /** What the profile would rather not eat. */
  dislikedIngredientIds?: ReadonlySet<string>;
}

export interface ClosingInput {
  /** The plans of one kitchen, on the same days: one, or the two of a joint plan. */
  plans: readonly ClosingPlan[];
  /**
   * Of the two plans of a joint plan, the meals that are one dish for both: the
   * first plan's meal and the second's at the same day and time of day. A lock
   * of the second plan's at such a meal is the sharing itself.
   */
  shared?: readonly { dayIndex: number; slot: MealType }[];
  /** What stays in the plans takes of the packs on each day, beside the meals placed: the kitchen's count of the rest. */
  fixed?: DailyNeeds;
  /** The pack of each ingredient whose opened pack does not keep. */
  packs: ReadonlyMap<string, Pack>;
  /** What the kitchen's pantry holds of each ingredient, in its own unit, where the plans count it. */
  pantry?: ReadonlyMap<string, number>;
  /** How much further from its split than the planner left it a day may come (`SPLIT_SLACK` when left out). */
  splitSlack?: number;
}

/** A meal by its plan and its place among the plan's assignments. */
interface Place {
  plan: number;
  index: number;
}

const keyOf = (place: Place): string => `${place.plan}:${place.index}`;

/**
 * Meals cooked in one pot, which change together: a dish cooked ahead and the
 * meals it feeds, a meal shared by two plans; any other meal by itself.
 */
export interface Pot {
  places: Place[];
  /** The day each place takes its ingredients on: the day its dish is cooked. */
  takenOn: number[];
}

/** What a kitchen takes of one ingredient on each day, and what its packs leave: all of it, and each pack by its last day. */
interface Lot {
  row: number[];
  /** In packs. */
  left: number;
  over: { until: number; share: number }[];
}

/** One use of a recipe, as the limits count them. */
interface Use {
  day: number;
  recipeId: string;
}

const EATEN_IN_ORDER: readonly string[] = MEAL_SLOTS_BY_COUNT[5]!;
const rankOf = (slot: string): number => {
  const rank = EATEN_IN_ORDER.indexOf(slot);
  return rank === -1 ? EATEN_IN_ORDER.length : rank;
};
const nameOf = (recipe: OptimizerRecipe): string => recipe.slug ?? recipe.id;
const NO_USES: readonly Use[] = [];
const NO_DAYS: readonly number[] = [];

/**
 * The plans with their packs closed: each plan's assignments in the order they
 * came, a meal that was swapped with its new recipe, servings and portion.
 */
export function closePacks(input: ClosingInput): SizedAssignment[][] {
  const { plans, packs } = input;
  const meals = plans.map((plan) => plan.assignments.map((meal) => ({ ...meal })));
  const recipeOf = plans.map((plan) => new Map(plan.recipes.map((recipe) => [recipe.id, recipe])));
  const recipeAt = ({ plan, index }: Place): OptimizerRecipe | undefined =>
    recipeOf[plan]!.get(meals[plan]![index]!.recipeId);

  // Meals of a plan by day, in the order they are eaten.
  const byDay = plans.map(mealsByDay);

  // The units: a dish cooked ahead with the meals it feeds, a shared meal with its other half.
  const { pots, sharing } = potsOf(plans, input.shared);
  /** A meal that stays as it is: locked to its place by the user, or a favourite. */
  const stays = (place: Place): boolean => {
    const meal = meals[place.plan]![place.index]!;
    const recipe = recipeAt(place);
    if (!recipe || recipe.isFavorite || recipe.eatenOften) return true;
    if (sharing.has(keyOf(place))) return false;
    return (plans[place.plan]!.days[meal.dayIndex]!.lockedSlots ?? []).some(
      (lock) => lock.slot === meal.slot,
    );
  };
  const units: Pot[] = pots.filter((pot) => !pot.places.some(stays));
  if (units.length === 0) return meals;

  // The kitchen: what all the plans take of each pack on each day.
  const needs = kitchenNeeds(plans, input.fixed, packs);
  // What one serving of each recipe takes of the packs, read once.
  const perishable = new Map<OptimizerRecipe, (readonly [string, number])[]>();
  /** What a meal takes of each pack: its recipe's amounts, at its servings and portion. */
  const takes = (recipe: OptimizerRecipe | undefined, servings: number, scale: number) => {
    if (!recipe) return [];
    let own = perishable.get(recipe);
    if (!own) {
      own = [...(recipe.amounts ?? [])].filter(([ingredientId]) => packs.has(ingredientId));
      perishable.set(recipe, own);
    }
    return own.map(
      ([ingredientId, perServing]) => [ingredientId, perServing * servings * scale] as const,
    );
  };
  // What each ingredient's packs leave, all of them in packs, and each by the last day it is eaten from.
  const lotOf = (ingredientId: string, row: number[]): Lot => {
    const size = packs.get(ingredientId)!.size;
    const over = packsLeftOver(row, packs.get(ingredientId)!).map((opened) => ({
      until: opened.until,
      share: opened.left / size,
    }));
    return { row, over, left: over.reduce((sum, pack) => sum + pack.share, 0) };
  };
  const lots = new Map(
    [...needs].map(([ingredientId, row]) => [ingredientId, lotOf(ingredientId, row)]),
  );
  /** What a meal that takes from the ingredient on `day` could at most save of what its packs leave: what is left in those that keep until then or later. */
  const within = (lot: Lot, day: number): number => {
    let share = 0;
    for (const pack of lot.over) if (pack.until >= day) share += pack.share;
    return share;
  };

  // The pantry: what the plans take of each ingredient it holds, of which a swap may not leave less taken from it.
  const pantry = input.pantry ?? new Map<string, number>();
  const fromPantry = new Map<string, number>();
  plans.forEach((_, p) =>
    meals[p]!.forEach((meal, index) => {
      for (const [ingredientId, perServing] of recipeAt({ plan: p, index })?.amounts ?? [])
        if (pantry.has(ingredientId))
          fromPantry.set(
            ingredientId,
            (fromPantry.get(ingredientId) ?? 0) + perServing * meal.servings * meal.quantityScale,
          );
    }),
  );
  /** How the unit's meals with `sized` in their places change what the plans take of each ingredient the pantry holds. */
  const pantryChange = (
    unit: Pot,
    sized: NonNullable<ReturnType<typeof sizedFor>>,
  ): Map<string, number> => {
    const change = new Map<string, number>();
    if (pantry.size === 0) return change;
    unit.places.forEach((place, i) => {
      const meal = meals[place.plan]![place.index]!;
      for (const [ingredientId, perServing] of recipeAt(place)?.amounts ?? [])
        if (pantry.has(ingredientId))
          change.set(
            ingredientId,
            (change.get(ingredientId) ?? 0) - perServing * meal.servings * meal.quantityScale,
          );
      const { recipe, servings, quantityScale } = sized[i]!;
      for (const [ingredientId, perServing] of recipe.amounts ?? [])
        if (pantry.has(ingredientId))
          change.set(
            ingredientId,
            (change.get(ingredientId) ?? 0) + perServing * servings * quantityScale,
          );
    });
    return change;
  };
  /** Whether the plans take no less of the pantry after `change`. */
  const keepsThePantry = (change: ReadonlyMap<string, number>): boolean => {
    let taken = 0;
    for (const [ingredientId, more] of change) {
      const held = pantry.get(ingredientId)!;
      const need = fromPantry.get(ingredientId) ?? 0;
      taken += Math.min(held, Math.max(0, need + more)) - Math.min(held, need);
    }
    return taken >= -1e-6;
  };

  // The limits: every use of a recipe and every meal of a kind of protein, in each plan, those that stay among them.
  const uses = plans.map((plan, p) => {
    const ofRecipe = new Map<string, Use[]>();
    const kindDays = new Map<ProteinKind, number[]>();
    const add = (day: number, recipe: OptimizerRecipe | undefined, recipeId: string): void => {
      const mine = ofRecipe.get(recipeId);
      if (mine) mine.push({ day, recipeId });
      else ofRecipe.set(recipeId, [{ day, recipeId }]);
      for (const kind of recipe?.proteinKinds ?? []) {
        const days = kindDays.get(kind);
        if (days) days.push(day);
        else kindDays.set(kind, [day]);
      }
    };
    plan.days.forEach((day, dayIndex) => {
      for (const kept of day.kept ?? [])
        if (kept.recipeId !== undefined)
          add(dayIndex, recipeOf[p]!.get(kept.recipeId), kept.recipeId);
    });
    meals[p]!.forEach((meal, index) =>
      add(meal.dayIndex, recipeAt({ plan: p, index }), meal.recipeId),
    );
    return { ofRecipe, kindDays };
  });
  const removeUse = (
    p: number,
    day: number,
    recipe: OptimizerRecipe | undefined,
    recipeId: string,
  ) => {
    const mine = uses[p]!.ofRecipe.get(recipeId);
    const at = mine?.findIndex((use) => use.day === day) ?? -1;
    if (at !== -1) mine!.splice(at, 1);
    for (const kind of recipe?.proteinKinds ?? []) {
      const days = uses[p]!.kindDays.get(kind);
      const i = days?.indexOf(day) ?? -1;
      if (i !== -1) days!.splice(i, 1);
    }
  };
  const addUse = (p: number, day: number, recipe: OptimizerRecipe, recipeId: string) => {
    const mine = uses[p]!.ofRecipe.get(recipeId);
    if (mine) mine.push({ day, recipeId });
    else uses[p]!.ofRecipe.set(recipeId, [{ day, recipeId }]);
    for (const kind of recipe.proteinKinds ?? []) {
      const days = uses[p]!.kindDays.get(kind);
      if (days) days.push(day);
      else uses[p]!.kindDays.set(kind, [day]);
    }
  };

  // The days: what each aims at, and how far the planner left it from that, plus what a swap may add.
  const heldOn = (
    p: number,
    day: number,
    swapped?: ReadonlyMap<number, { recipe: OptimizerRecipe; amount: number }>,
  ): Macros => {
    const held: Macros = { protein: 0, fat: 0, carbs: 0 };
    for (const kept of plans[p]!.days[day]?.kept ?? []) {
      if (!kept.macros) continue;
      held.protein += kept.macros.protein;
      held.fat += kept.macros.fat;
      held.carbs += kept.macros.carbs;
    }
    for (const index of byDay[p]![day] ?? []) {
      const other = swapped?.get(index);
      const meal = meals[p]![index]!;
      const recipe = other?.recipe ?? recipeAt({ plan: p, index });
      if (!recipe) continue;
      const amount = other?.amount ?? meal.servings * meal.quantityScale;
      held.protein += recipe.proteinPerServing * amount;
      held.fat += recipe.fatPerServing * amount;
      held.carbs += recipe.carbsPerServing * amount;
    }
    return held;
  };
  const aims = plans.map((plan) =>
    plan.days.map((day) => energyShares(aimOfPlanned(day, plan.split)) ?? plan.split),
  );
  const distanceOn = (p: number, day: number, held: Macros): number => {
    const shares = energyShares(held);
    return shares ? distanceOnDiet(shares, aims[p]![day]!, plans[p]!.dietType) : 0;
  };
  const bounds = plans.map((plan, p) =>
    plan.days.map(
      (_, day) => distanceOn(p, day, heldOn(p, day)) + (input.splitSlack ?? SPLIT_SLACK),
    ),
  );

  // What each plan may be given for each meal, in an order that is the same on every instance.
  const disliked = plans.map((plan) => {
    const ids = plan.dislikedIngredientIds;
    return (recipe: OptimizerRecipe): boolean =>
      ids !== undefined && ids.size > 0 && recipe.ingredientIds.some((id) => ids.has(id));
  });
  const offered = plans.map((plan) => {
    const bySlot = new Map<MealType, OptimizerRecipe[]>();
    return (slot: MealType): OptimizerRecipe[] => {
      let found = bySlot.get(slot);
      if (!found) {
        found = plan.recipes
          .filter(
            (recipe) => recipe.mealTypes.includes(slot) && fitsDiet(recipe.dietTags, plan.dietType),
          )
          .sort((a, b) => (nameOf(a) < nameOf(b) ? -1 : nameOf(a) > nameOf(b) ? 1 : 0));
        bySlot.set(slot, found);
      }
      return found;
    };
  });

  /** The recipe in the place of every meal of a unit, sized to what each held; null where it cannot be. */
  const sizedFor = (unit: Pot, candidate: string) => {
    const out: { recipe: OptimizerRecipe; servings: number; quantityScale: number }[] = [];
    for (const place of unit.places) {
      const meal = meals[place.plan]![place.index]!;
      const recipe = recipeOf[place.plan]!.get(candidate);
      const before = recipeAt(place);
      if (!recipe || !before) return null;
      if (
        !recipe.mealTypes.includes(meal.slot) ||
        !fitsDiet(recipe.dietTags, plans[place.plan]!.dietType)
      )
        return null;
      if (disliked[place.plan]!(recipe)) return null;
      if (plans[place.plan]!.days[meal.dayIndex]!.avoid?.has(recipe.id)) return null;
      const held = before.caloriesPerServing * meal.servings * meal.quantityScale;
      if (held <= 0 || recipe.caloriesPerServing <= 0) return null;
      const servings = fitServings(recipe.caloriesPerServing, held);
      const atServings = recipe.caloriesPerServing * servings;
      if (Math.abs(atServings - held) > ENERGY_WINDOW * held) return null;
      const quantityScale = Math.round((held / atServings) * 100) / 100;
      const portion = servings * quantityScale;
      if (portion < SERVING_MIN - 1e-9 || portion > SERVING_MAX + 1e-9) return null;
      out.push({ recipe, servings, quantityScale });
    }
    return out;
  };

  /** Whether every limit of each plan holds with the recipe at every meal of the unit, the unit's own recipe gone from them. */
  const withinLimits = (unit: Pot, recipe: string, before: string): boolean => {
    for (let p = 0; p < plans.length; p++) {
      const mine = unit.places.filter((place) => place.plan === p);
      if (mine.length === 0) continue;
      const plan = plans[p]!;
      const candidate = recipeOf[p]!.get(recipe)!;
      const leaving = recipeOf[p]!.get(before);
      const leavingDays = mine.map((place) => meals[p]![place.index]!.dayIndex);
      const placed: Use[] = [];
      const ownUses = uses[p]!.ofRecipe.get(recipe) ?? NO_USES;
      for (const place of mine) {
        const day = meals[p]![place.index]!.dayIndex;
        const broken = limitsBroken(candidate, {
          day,
          usesOf: (recipeId) => (recipeId === recipe ? [...ownUses, ...placed] : NO_USES),
          useCount: new Map([[recipe, ownUses.length + placed.length]]),
          mealsOfKind: (kind) => {
            const days = [...(uses[p]!.kindDays.get(kind) ?? NO_DAYS)];
            if (leaving?.proteinKinds?.includes(kind))
              for (const gone of leavingDays) {
                const i = days.indexOf(gone);
                if (i !== -1) days.splice(i, 1);
              }
            for (const use of placed) days.push(use.day);
            return kindMealsAround(days, day);
          },
          limits: {
            consecutive: plan.limits.consecutive,
            perWeek: plan.limits.perWeek,
            perPlan: plan.limits.perPlan,
            twiceADay: plan.limits.twiceADay ?? plan.mealPrepFriendly,
            perKind: plan.limits.perKind,
          },
          cookTimeBudget: plan.days[day]!.cookTimeBudgetMinutes,
        });
        if (broken.length > 0) return false;
        placed.push({ day, recipeId: recipe });
      }
      // Cooking ahead stays as it was: the recipe is on no other meal of the days the unit takes and the days beside them.
      if (plan.mealPrepFriendly) {
        const first = Math.min(...leavingDays) - 1;
        const last = Math.max(...leavingDays) + 1;
        const own = new Set(mine.map((place) => place.index));
        for (let day = Math.max(0, first); day <= last && day < plan.days.length; day++)
          for (const index of byDay[p]![day]!)
            if (!own.has(index) && meals[p]![index]!.recipeId === recipe) return false;
      }
    }
    return true;
  };

  /** Whether each day the unit is on stays near enough its split with the recipes in its places. */
  const nearTheSplit = (unit: Pot, sized: NonNullable<ReturnType<typeof sizedFor>>): boolean => {
    const days = new Map<
      string,
      { p: number; day: number; swapped: Map<number, { recipe: OptimizerRecipe; amount: number }> }
    >();
    unit.places.forEach((place, i) => {
      const day = meals[place.plan]![place.index]!.dayIndex;
      const key = `${place.plan}:${day}`;
      let entry = days.get(key);
      if (!entry) {
        entry = { p: place.plan, day, swapped: new Map() };
        days.set(key, entry);
      }
      entry.swapped.set(place.index, {
        recipe: sized[i]!.recipe,
        amount: sized[i]!.servings * sized[i]!.quantityScale,
      });
    });
    for (const { p, day, swapped } of days.values())
      if (distanceOn(p, day, heldOn(p, day, swapped)) > bounds[p]![day]! + 1e-9) return false;
    return true;
  };

  /** What the unit's meals take of each pack on each day, as they are or with `sized` in their places. */
  const takenBy = (
    unit: Pot,
    sized?: ReturnType<typeof sizedFor>,
  ): Map<string, Map<number, number>> => {
    const out = new Map<string, Map<number, number>>();
    unit.places.forEach((place, i) => {
      const meal = meals[place.plan]![place.index]!;
      const recipe = sized ? sized[i]!.recipe : recipeAt(place);
      const servings = sized ? sized[i]!.servings : meal.servings;
      const scale = sized ? sized[i]!.quantityScale : meal.quantityScale;
      for (const [ingredientId, amount] of takes(recipe, servings, scale)) {
        let days = out.get(ingredientId);
        if (!days) {
          days = new Map();
          out.set(ingredientId, days);
        }
        days.set(unit.takenOn[i]!, (days.get(unit.takenOn[i]!) ?? 0) + amount);
      }
    });
    return out;
  };

  for (let pass = 0; pass < PASSES; pass++) {
    let changed = false;
    for (const unit of units) {
      const first = unit.places[0]!;
      const before = meals[first.plan]![first.index]!.recipeId;
      const earliest = Math.min(...unit.takenOn);
      // The kitchen without the unit's meals: what the packs they take from would leave then, and how much less that is.
      const without = new Map<string, Lot>();
      let freed = 0;
      for (const [ingredientId, days] of takenBy(unit)) {
        const now = lots.get(ingredientId)!;
        const row = [...now.row];
        for (const [day, amount] of days) row[day] = Math.max(0, row[day]! - amount);
        const lot = lotOf(ingredientId, row);
        without.set(ingredientId, lot);
        freed += now.left - lot.left;
      }
      const baseOf = (ingredientId: string): Lot =>
        without.get(ingredientId) ?? lots.get(ingredientId)!;
      let best: {
        sized: NonNullable<ReturnType<typeof sizedFor>>;
        gain: number;
        lots: Map<string, Lot>;
        pantry: Map<string, number>;
      } | null = null;
      for (const candidate of offered[first.plan]!(meals[first.plan]![first.index]!.slot)) {
        if (candidate.id === before) continue;
        // The most a recipe can save: what the meal's leaving frees, and what is left of the packs it takes from
        // that keep until its day. Less than a spoonful, or no more than one found already, is not worth counting.
        let most = freed;
        for (const [ingredientId] of takes(candidate, 1, 1))
          most += within(baseOf(ingredientId), earliest);
        if (most < SPOONFUL - 1e-9 || (best !== null && most <= best.gain + 1e-9)) continue;
        const sized = sizedFor(unit, candidate.id);
        if (!sized) continue;
        let gain = freed;
        const changedLots = new Map<string, Lot>();
        for (const [ingredientId, days] of takenBy(unit, sized)) {
          const base = baseOf(ingredientId);
          const row = [...base.row];
          for (const [day, amount] of days) row[day]! += amount;
          const lot = lotOf(ingredientId, row);
          gain += base.left - lot.left;
          changedLots.set(ingredientId, lot);
        }
        if (gain < SPOONFUL - 1e-9 || (best !== null && gain <= best.gain + 1e-9)) continue;
        if (!withinLimits(unit, candidate.id, before) || !nearTheSplit(unit, sized)) continue;
        const fromIt = pantryChange(unit, sized);
        if (!keepsThePantry(fromIt)) continue;
        for (const [ingredientId, lot] of without)
          if (!changedLots.has(ingredientId)) changedLots.set(ingredientId, lot);
        best = { sized, gain, lots: changedLots, pantry: fromIt };
      }
      if (best === null) continue;
      unit.places.forEach((place, i) => {
        const meal = meals[place.plan]![place.index]!;
        removeUse(place.plan, meal.dayIndex, recipeAt(place), meal.recipeId);
        const { recipe, servings, quantityScale } = best!.sized[i]!;
        meals[place.plan]![place.index] = { ...meal, recipeId: recipe.id, servings, quantityScale };
        addUse(place.plan, meal.dayIndex, recipe, recipe.id);
      });
      for (const [ingredientId, lot] of best.lots) lots.set(ingredientId, lot);
      for (const [ingredientId, more] of best.pantry)
        fromPantry.set(ingredientId, (fromPantry.get(ingredientId) ?? 0) + more);
      changed = true;
    }
    if (!changed) break;
  }
  return meals;
}

/** A plan's meals by day, each day's in the order they are eaten, as places among its assignments. */
function mealsByDay(plan: Pick<ClosingPlan, 'days' | 'assignments'>): number[][] {
  const days: number[][] = Array.from({ length: plan.days.length }, () => []);
  plan.assignments.forEach((meal, index) => days[meal.dayIndex]?.push(index));
  for (const day of days)
    day.sort((a, b) => rankOf(plan.assignments[a]!.slot) - rankOf(plan.assignments[b]!.slot));
  return days;
}

/**
 * In a plan made for cooking ahead, the meals each dish cooked ahead feeds
 * (`cookAhead`), as places among its assignments, the meal it is cooked at
 * first. None in a plan that does not cook ahead.
 */
function cookingsOfPlan(
  plan: Pick<ClosingPlan, 'days' | 'assignments' | 'mealPrepFriendly'>,
): number[][] {
  if (!plan.mealPrepFriendly) return [];
  const days = mealsByDay(plan);
  return cookAhead(
    days.map((day) => day.map((index) => plan.assignments[index]!.recipeId)),
  ).cookings.map((cooking) => cooking.map(({ day, meal }) => days[day]![meal]!));
}

/**
 * The pots of the plans of a kitchen (`Pot`), in the order their dishes are
 * cooked: by day, then by the meal they are eaten at. `sharing` names the
 * places of the second plan at a meal both eat, whose lock is the sharing
 * itself, not the user's.
 */
export function potsOf(
  plans: readonly Pick<ClosingPlan, 'days' | 'assignments' | 'mealPrepFriendly'>[],
  shared: readonly { dayIndex: number; slot: MealType }[] = [],
): { pots: Pot[]; sharing: ReadonlySet<string> } {
  const meals = plans.map((plan) => plan.assignments);
  const byDay = plans.map(mealsByDay);
  const parent = new Map<string, string>();
  const find = (key: string): string => {
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(key, root);
    return root;
  };
  const join = (a: Place, b: Place): void => {
    const ra = find(keyOf(a));
    const rb = find(keyOf(b));
    if (ra !== rb) parent.set(rb, ra);
  };
  plans.forEach((_, p) =>
    meals[p]!.forEach((__, index) =>
      parent.set(keyOf({ plan: p, index }), keyOf({ plan: p, index })),
    ),
  );
  const takenOn = new Map<string, number>();
  plans.forEach((plan, p) => {
    for (const cooking of cookingsOfPlan(plan))
      for (const index of cooking) {
        join({ plan: p, index: cooking[0]! }, { plan: p, index });
        takenOn.set(keyOf({ plan: p, index }), plan.assignments[cooking[0]!]!.dayIndex);
      }
  });
  const sharing = new Set<string>();
  if (plans.length > 1)
    for (const { dayIndex, slot } of shared) {
      const here = byDay[0]![dayIndex]?.find((index) => meals[0]![index]!.slot === slot);
      const there = byDay[1]![dayIndex]?.find((index) => meals[1]![index]!.slot === slot);
      if (here === undefined || there === undefined) continue;
      if (meals[0]![here]!.recipeId !== meals[1]![there]!.recipeId) continue;
      join({ plan: 0, index: here }, { plan: 1, index: there });
      sharing.add(keyOf({ plan: 1, index: there }));
    }
  const grouped = new Map<string, Place[]>();
  plans.forEach((_, p) =>
    meals[p]!.forEach((__, index) => {
      const root = find(keyOf({ plan: p, index }));
      const group = grouped.get(root);
      if (group) group.push({ plan: p, index });
      else grouped.set(root, [{ plan: p, index }]);
    }),
  );
  const pots = [...grouped.values()]
    .map((places) => {
      const ordered = [...places].sort(
        (a, b) =>
          meals[a.plan]![a.index]!.dayIndex - meals[b.plan]![b.index]!.dayIndex ||
          rankOf(meals[a.plan]![a.index]!.slot) - rankOf(meals[b.plan]![b.index]!.slot) ||
          a.plan - b.plan,
      );
      return {
        places: ordered,
        takenOn: ordered.map(
          (place) => takenOn.get(keyOf(place)) ?? meals[place.plan]![place.index]!.dayIndex,
        ),
      };
    })
    .sort(
      (a, b) =>
        a.takenOn[0]! - b.takenOn[0]! ||
        rankOf(meals[a.places[0]!.plan]![a.places[0]!.index]!.slot) -
          rankOf(meals[b.places[0]!.plan]![b.places[0]!.index]!.slot),
    );
  return { pots, sharing };
}

/**
 * What the plans of a kitchen take of each pack on each day, with what stays in
 * them (`fixed`): a meal on its day, one eaten from a dish cooked ahead on the
 * day the dish is cooked. A row for every pack of `packs`.
 */
export function kitchenNeeds(
  plans: readonly Pick<ClosingPlan, 'recipes' | 'days' | 'assignments' | 'mealPrepFriendly'>[],
  fixed: DailyNeeds | undefined,
  packs: ReadonlyMap<string, Pack>,
): Map<string, number[]> {
  const length = Math.max(0, ...plans.map((plan) => plan.days.length));
  const needs = new Map<string, number[]>();
  for (const ingredientId of packs.keys())
    needs.set(
      ingredientId,
      Array.from({ length }, () => 0),
    );
  for (const [ingredientId, row] of fixed ?? []) {
    const ours = needs.get(ingredientId);
    if (ours)
      row.forEach((amount, day) => {
        if (day < length) ours[day]! += amount;
      });
  }
  for (const plan of plans) {
    const recipeOf = new Map(plan.recipes.map((recipe) => [recipe.id, recipe]));
    const takenOn = plan.assignments.map((meal) => meal.dayIndex);
    for (const cooking of cookingsOfPlan(plan))
      for (const index of cooking) takenOn[index] = plan.assignments[cooking[0]!]!.dayIndex;
    plan.assignments.forEach((meal, index) => {
      for (const [ingredientId, perServing] of recipeOf.get(meal.recipeId)?.amounts ?? []) {
        const row = needs.get(ingredientId);
        if (row && takenOn[index]! < length)
          row[takenOn[index]!]! += perServing * meal.servings * meal.quantityScale;
      }
    });
  }
  return needs;
}

/** A kitchen's packs as the toppings of its plans are given. */
export interface PackKitchen {
  /**
   * How much more the kitchen's packs of an ingredient leave, in packs, with
   * `amount` more of it on `day`: less than nothing where they leave less.
   */
  leavesMore(ingredientId: string, pack: Pack, day: number, amount: number): number;
  /** The kitchen takes `amount` of an ingredient on `day`. */
  take(ingredientId: string, day: number, amount: number): void;
}

/** The kitchen whose plans take `needs` (`kitchenNeeds`) over `length` days. */
export function packKitchen(needs: Map<string, number[]>, length: number): PackKitchen {
  const rowOf = (ingredientId: string): number[] => {
    let row = needs.get(ingredientId);
    if (!row) {
      row = Array.from({ length }, () => 0);
      needs.set(ingredientId, row);
    }
    return row;
  };
  const leftOf = (row: readonly number[], pack: Pack): number =>
    packsLeftOver(row, pack).reduce((sum, opened) => sum + opened.left, 0) / pack.size;
  return {
    leavesMore(ingredientId, pack, day, amount) {
      if (day < 0 || day >= length || amount <= 0 || pack.size <= 0) return 0;
      const row = rowOf(ingredientId);
      const more = [...row];
      more[day]! += amount;
      return leftOf(more, pack) - leftOf(row, pack);
    },
    take(ingredientId, day, amount) {
      if (day >= 0 && day < length) rowOf(ingredientId)[day]! += amount;
    },
  };
}
