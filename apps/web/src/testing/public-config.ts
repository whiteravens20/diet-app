// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/** The public configuration a component under test finds already loaded. */
import {
  DietType,
  MEAL_SLOTS_BY_COUNT,
  PLAN_RELAXATIONS,
  type CatalogueSupply,
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

/** Nothing switched on, nothing published by the operator, plenty of recipes; a test overrides what it is about. */
export function aPublicConfig(overrides: Partial<PublicConfig> = {}): PublicConfig {
  return {
    turnstile: { enabled: false, siteKey: null },
    email: { enabled: false },
    ai: { ollamaUserPolicy: 'off' },
    instance: { supportUrl: null, operatorContact: null, version: '0.0.0' },
    catalogue: { supply: aSupply() },
    accounts: { maxProfiles: 2 },
    plans: {
      maxRepeatsPerRecipe: null,
      mealSlots: {
        2: MEAL_SLOTS_BY_COUNT[2]!,
        3: MEAL_SLOTS_BY_COUNT[3]!,
        4: MEAL_SLOTS_BY_COUNT[4]!,
        5: MEAL_SLOTS_BY_COUNT[5]!,
      },
      relaxations: [...PLAN_RELAXATIONS],
    },
    ...overrides,
  };
}
