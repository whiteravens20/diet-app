// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * The limits of every kind of model request: how many tokens the answer may
 * use, how much the model may improvise, and how long the caller waits.
 *
 * A token cap is a ceiling, not an estimate: a provider bills what the model
 * wrote. Each cap is about twice a typical answer, so an answer that reaches
 * it has gone wrong and is reported as cut off.
 */
export interface Operation {
  /** Names the request in the usage log. */
  name: string;
  maxTokens: number;
  temperature: number;
  /**
   * How long the caller waits. For a request made on behalf of a user this
   * covers the whole failover chain, not each provider in it.
   */
  timeoutMs: number;
}

/**
 * The longest a user's request waits for a model. The web front-end proxies
 * API calls with a timeout of its own (`proxyTimeout` in its Next
 * configuration), which has to stay above this.
 */
export const USER_WAIT_MS = 60_000;

/** One id and one sentence, chosen from a list the engine built. */
export const MEAL_SWAP: Operation = {
  name: 'meal-swap',
  maxTokens: 400,
  temperature: 0.2,
  timeoutMs: USER_WAIT_MS,
};

export const INGREDIENT_SWAP: Operation = {
  name: 'ingredient-swap',
  maxTokens: 400,
  temperature: 0.2,
  timeoutMs: USER_WAIT_MS,
};

/**
 * The description and steps of one recipe in one language, reworded around a
 * substituted ingredient. The wording has a template fallback, so the wait is
 * short: it is not worth holding a swap for.
 */
export const SWAP_REWRITE: Operation = {
  name: 'swap-rewrite',
  maxTokens: 3_000,
  temperature: 0.3,
  timeoutMs: 20_000,
};

/** One recipe, written in `locales` languages. */
export function recipeDraft(locales: number): Operation {
  return {
    name: 'recipe-draft',
    maxTokens: 600 + 1_200 * locales,
    temperature: 0.7,
    timeoutMs: USER_WAIT_MS,
  };
}

// ── Admin batches ───────────────────────────────────────────────────────────
// These run in the background, outside any HTTP request, so they may wait
// longer. A batch is split into calls small enough for one answer: an answer
// much longer than this is where models start to cut their JSON short.

const BATCH_WAIT_MS = 180_000;
const BATCH_ANSWER_TOKENS = 6_000;

const recipeTokens = (locales: number): number => 400 + 700 * locales;
const nameTokens = (locales: number): number => 40 + 40 * locales;

/** How many recipes one call may ask for, each written in `locales` languages. */
export function recipesPerCall(locales: number): number {
  return Math.max(1, Math.floor(BATCH_ANSWER_TOKENS / recipeTokens(locales)));
}

/** `recipes` curated-recipe drafts in one answer. */
export function recipeBatch(recipes: number, locales: number, temperature: number): Operation {
  return {
    name: 'admin-recipe-batch',
    maxTokens: 200 + recipes * recipeTokens(locales),
    temperature,
    timeoutMs: BATCH_WAIT_MS,
  };
}

/** How many ingredient names one call may ask for, each in `locales` languages. */
export function namesPerCall(locales: number): number {
  return Math.max(1, Math.floor(BATCH_ANSWER_TOKENS / nameTokens(locales)));
}

/** `names` friendly ingredient names in one answer. */
export function ingredientNames(names: number, locales: number, temperature: number): Operation {
  return {
    name: 'admin-ingredient-names',
    maxTokens: 200 + names * nameTokens(locales),
    temperature,
    timeoutMs: BATCH_WAIT_MS,
  };
}
