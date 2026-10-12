// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/** The public configuration a component under test finds already loaded. */
import { DietType, type CatalogueDepth, type PublicConfig } from '@diet-app/shared';

/** A catalogue with `recipes` to choose from for every diet at every number of meals a day. */
export function aDepth(recipes: number): CatalogueDepth {
  return Object.fromEntries(
    DietType.options.map((diet) => [diet, { 2: recipes, 3: recipes, 4: recipes, 5: recipes }]),
  ) as CatalogueDepth;
}

/** Nothing switched on, nothing published by the operator, plenty of recipes; a test overrides what it is about. */
export function aPublicConfig(overrides: Partial<PublicConfig> = {}): PublicConfig {
  return {
    turnstile: { enabled: false, siteKey: null },
    email: { enabled: false },
    ai: { ollamaUserPolicy: 'off' },
    instance: { supportUrl: null, operatorContact: null, version: '0.0.0' },
    catalogue: { depth: aDepth(9) },
    accounts: { maxProfiles: 2 },
    plans: { maxRepeatsPerRecipe: null },
    ...overrides,
  };
}
