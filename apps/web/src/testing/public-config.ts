// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/** The public configuration a component under test finds already loaded. */
import {
  DietType,
  MEAL_SLOTS_BY_COUNT,
  NamedDiet,
  PLAN_RELAXATIONS,
  type CatalogueSupply,
  type LessWasteEffect,
  type PublicConfig,
  type Supply,
} from '@diet-app/shared';

/** What the API says of a diet at a number of meals a day where the catalogue has plenty. */
const ENOUGH: Supply = { level: 'enough', recipes: 9, fewerMeals: null };

/** A catalogue with enough for every diet at every number of meals a day, as the API says it; a test changes the cells it is about. */
export function aSupply(): CatalogueSupply {
  return Object.fromEntries(
    DietType.options.map((diet) => [diet, { 2: ENOUGH, 3: ENOUGH, 4: ENOUGH, 5: ENOUGH }]),
  ) as CatalogueSupply;
}

/** What a plan that wastes less does on each diet, each diet's figures its own, so that a test sees whose it shows. */
export function aLessWaste(): Record<NamedDiet, LessWasteEffect> {
  return Object.fromEntries(
    NamedDiet.options.map((diet, i) => [
      diet,
      {
        pantry: { now: 30 + i, less: 60 + i },
        packs: { now: 70 + i, less: 80 + i },
        fewerRecipes: 10 + i,
      },
    ]),
  ) as Record<NamedDiet, LessWasteEffect>;
}

/** Nothing switched on, nothing published by the operator, plenty of recipes; a test overrides what it is about. */
export function aPublicConfig(overrides: Partial<PublicConfig> = {}): PublicConfig {
  return {
    turnstile: { enabled: false, siteKey: null },
    email: { enabled: false, confirmationUnlocksAi: false },
    ai: { ollamaUserPolicy: 'off' },
    instance: { supportUrl: null, operatorContact: null, version: '0.0.0' },
    catalogue: { supply: aSupply() },
    accounts: { maxProfiles: 2 },
    products: { offered: false, lookups: false },
    plans: {
      maxRepeatsPerRecipe: null,
      mealSlots: {
        2: MEAL_SLOTS_BY_COUNT[2]!,
        3: MEAL_SLOTS_BY_COUNT[3]!,
        4: MEAL_SLOTS_BY_COUNT[4]!,
        5: MEAL_SLOTS_BY_COUNT[5]!,
      },
      relaxations: [...PLAN_RELAXATIONS],
      lessWaste: aLessWaste(),
    },
    ...overrides,
  };
}
