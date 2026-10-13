// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { describe, expect, it } from 'vitest';
import {
  DAY_VARIATIONS,
  INGREDIENT_SWAP,
  LIST_PROPOSALS,
  MEAL_SWAP,
  SWAP_REWRITE,
  USE_UP_SWAPS,
  USER_WAIT_MS,
  ingredientNames,
  namesPerCall,
  recipeBatch,
  recipeDraft,
  recipeTranslation,
  recipesPerCall,
} from './operations.js';

describe('the limits of a user request', () => {
  const operations = [MEAL_SWAP, INGREDIENT_SWAP, SWAP_REWRITE, DAY_VARIATIONS, USE_UP_SWAPS, LIST_PROPOSALS, recipeDraft(1), recipeDraft(2)];

  it('names each kind of request by a name of its own in the usage log', () => {
    expect(new Set(operations.slice(0, 6).map((operation) => operation.name)).size).toBe(6);
  });

  it('never waits longer than the web proxy allows', () => {
    // The proxy in front of the API gives up after 90 s (apps/web/next.config.ts).
    expect(USER_WAIT_MS).toBeLessThan(90_000);
    for (const operation of operations) {
      expect(operation.timeoutMs, operation.name).toBeLessThanOrEqual(USER_WAIT_MS);
    }
  });

  it('always carries a token cap and a temperature', () => {
    for (const operation of operations) {
      expect(operation.maxTokens, operation.name).toBeGreaterThan(0);
      expect(operation.temperature, operation.name).toBeGreaterThanOrEqual(0);
      expect(operation.temperature, operation.name).toBeLessThanOrEqual(1);
    }
  });

  it('allows a draft more tokens for every language it is written in', () => {
    expect(recipeDraft(2).maxTokens).toBeGreaterThan(recipeDraft(1).maxTokens);
  });

  it('asks for an answer without thinking, which a run of the panel does not', () => {
    for (const operation of operations) {
      expect(operation.direct, operation.name).toBe(true);
    }
    for (const run of [recipeBatch(3, 2, 0.2), ingredientNames(20, 1, 0.2), recipeTranslation(6, 0.2)]) {
      expect(run.direct, run.name).toBeUndefined();
    }
  });
});

describe('the size of an admin batch', () => {
  it('asks for fewer recipes per call the more languages each is written in', () => {
    expect(recipesPerCall(1)).toBeGreaterThan(recipesPerCall(2));
    expect(recipesPerCall(2)).toBeGreaterThanOrEqual(recipesPerCall(4));
    expect(recipesPerCall(50)).toBe(1);
  });

  it('keeps the largest call of either kind under one cap', () => {
    for (const locales of [1, 2, 3, 5]) {
      const recipes = recipeBatch(recipesPerCall(locales), locales, 0.2);
      const names = ingredientNames(namesPerCall(locales), locales, 0.2);
      expect(recipes.maxTokens).toBeLessThanOrEqual(6_200);
      expect(names.maxTokens).toBeLessThanOrEqual(6_200);
    }
  });

  it('sizes the cap to what a call asks for', () => {
    expect(recipeBatch(1, 2, 0.2).maxTokens).toBeLessThan(recipeBatch(3, 2, 0.2).maxTokens);
    expect(ingredientNames(5, 1, 0.2).maxTokens).toBeLessThan(ingredientNames(20, 1, 0.2).maxTokens);
  });
});
