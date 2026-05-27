/**
 * @diet-app/shared — the Diet App API contract.
 *
 * Every request/response shape crossing the network is a Zod schema here, with
 * its TypeScript type inferred from it. The web app imports these directly; the
 * Android app mirrors them (see docs/contracts in the Android repo). Changing a
 * schema is a contract change — bump it deliberately.
 */
export * from './enums.js';
export * from './nutrition.js';
export * from './auth.js';
export * from './settings.js';
export * from './profile.js';
export * from './ingredient.js';
export * from './recipe.js';
export * from './meal-plan.js';
export * from './shopping-list.js';
export * from './ai.js';

/** Standard API error envelope returned for any non-2xx response. */
export { ApiError } from './error.js';
