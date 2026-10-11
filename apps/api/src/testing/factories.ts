// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Shortcuts that put a test in its starting state: an account, a profile, a
 * plan. They call the services directly, so a file that needs many of them does
 * not run into the per-route request limits; the behaviour under test goes over
 * HTTP.
 */
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Prisma } from '@prisma/client';
import { GeneratePlanRequest, ProfileInput, type MealPlan, type Profile } from '@diet-app/shared';
import { AuthService } from '../auth/auth.service.js';
import { recipeFacts } from '../engine/recipe-facts.js';
import { InstanceSettingsService } from '../instance-settings/instance-settings.service.js';
import { PlanGenerationService } from '../meal-plans/plan-generation.service.js';
import { ProfilesService } from '../profiles/profiles.service.js';
import { REVIEWER_COOKIE_NAME, resolveReviewerSecret, signReviewerCookie } from '../review/session.js';
import type { TestApp } from './test-app.js';

export interface TestUser {
  id: string;
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
}

let sequence = 0;

/** The header that authenticates a request as `user`. */
export const as = (user: TestUser): { Authorization: string } => ({
  Authorization: `Bearer ${user.accessToken}`,
});

/** A registered account. */
export async function aUser(t: TestApp, overrides: Partial<Pick<TestUser, 'email' | 'password'>> = {}): Promise<TestUser> {
  sequence += 1;
  const email = overrides.email ?? `user-${sequence}-${Date.now().toString(36)}@example.test`;
  const password = overrides.password ?? 'Integration-Passw0rd';
  const { user, tokens } = await t.app
    .get(AuthService)
    .register({ email, password, displayName: `User ${sequence}` });
  return { id: user.id, email, password, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
}

/** A profile of `user`: a 30-year-old on a balanced diet with three meals unless overridden. */
export function aProfile(t: TestApp, user: TestUser, overrides: Partial<ProfileInput> = {}): Promise<Profile> {
  const input = ProfileInput.parse({ name: 'Me', age: 30, sex: 'male', heightCm: 180, weightKg: 80, ...overrides });
  return t.app.get(ProfilesService).create(user.id, input);
}

/** A generated plan for `profile`: seven days from a fixed Monday unless overridden. */
export function aPlan(
  t: TestApp,
  user: TestUser,
  profile: Profile,
  overrides: Partial<GeneratePlanRequest> = {},
): Promise<MealPlan> {
  const request = GeneratePlanRequest.parse({
    profileId: profile.id,
    startDate: '2026-01-05',
    durationDays: 7,
    ...overrides,
  });
  return t.app.get(PlanGenerationService).generate(user.id, 'en', request);
}

/** Run `n` calls of `fn` at the same time and report how each ended. */
export function race<T>(n: number, fn: (index: number) => Promise<T>): Promise<PromiseSettledResult<T>[]> {
  return Promise.allSettled(Array.from({ length: n }, (_, index) => fn(index)));
}

/** A recipe that belongs to `user` alone, as an AI draft or an ingredient swap leaves one. */
export async function aPrivateRecipe(
  t: TestApp,
  user: TestUser,
  overrides: { title?: string; allergens?: string[]; mealTypes?: string[] } = {},
): Promise<{ id: string; title: string }> {
  const ingredient = await t.prisma.ingredient.findFirstOrThrow({ where: { slug: 'white-rice' } });
  return t.prisma.recipe.create({
    data: {
      title: overrides.title ?? 'A private recipe',
      description: 'Only its owner may see this.',
      servings: 1,
      mealTypes: overrides.mealTypes ?? ['lunch'],
      dietTags: ['vegetarian', 'vegan'],
      steps: ['Cook the rice.', 'Serve.'],
      prepMinutes: 5,
      cookMinutes: 15,
      allergens: overrides.allergens ?? [],
      origin: 'ai',
      caloriesPerServing: 360,
      proteinPerServing: 7,
      fatPerServing: 1,
      carbsPerServing: 79,
      createdByUserId: user.id,
      ingredients: { create: [{ ingredientId: ingredient.id, quantity: 100, unit: 'g' }] },
    },
    select: { id: true, title: true },
  });
}

/** The header of the administrator the test application is set up with. */
export const asAdmin = { Authorization: `Basic ${Buffer.from('admin:integration-test-admin-password').toString('base64')}` };

/**
 * A reviewer who is signed in: the reviewer interface is switched on and the
 * header carries a session under `label`. The session is signed here, not
 * asked for over HTTP, so that a file with many tests does not meet the limit
 * on reviewer sign-ins.
 */
export async function aReviewer(t: TestApp, label = 'pl reviewer'): Promise<{ Cookie: string }> {
  await t.app.get(InstanceSettingsService).patch({ reviewerEnabled: true, reviewerPassword: 'Reviewers-Passw0rd' });
  const { token } = signReviewerCookie(t.app.get(JwtService, { strict: false }), resolveReviewerSecret(t.app.get(ConfigService)), { label });
  return { Cookie: `${REVIEWER_COOKIE_NAME}=${token}` };
}

/**
 * A recipe draft as a batch run leaves one in the queue: English and Polish,
 * three ingredients of the test catalogue unless `lines` names others, the
 * engine's own figures for them, pending.
 */
export async function aRecipeDraft(
  t: TestApp,
  overrides: Partial<Prisma.RecipeDraftUncheckedCreateInput> = {},
  lines: { slug: string; quantity: number; unit: 'g' | 'ml' | 'piece'; note: string | null }[] = [
    { slug: 'rolled-oats', quantity: 60, unit: 'g', note: null },
    { slug: 'oat-drink', quantity: 200, unit: 'ml', note: null },
    { slug: 'banana', quantity: 120, unit: 'g', note: null },
  ],
) {
  sequence += 1;
  const rows = await t.prisma.ingredient.findMany({ where: { slug: { in: lines.map((line) => line.slug) } } });
  const facts = recipeFacts(lines.map((line) => ({ ...line, ingredient: rows.find((row) => row.slug === line.slug)! })), 1);
  return t.prisma.recipeDraft.create({
    data: {
      slug: `draft-dish-${sequence}`,
      titles: { en: 'Oat bowl', pl: 'Owsianka' },
      descriptions: { en: 'Oats with a banana.', pl: 'Płatki z bananem.' },
      steps: { en: ['Warm the drink.', 'Stir in the oats and the banana.'], pl: ['Podgrzej napój.', 'Wmieszaj płatki i banana.'] },
      locales: ['en', 'pl'],
      servings: 1,
      mealTypes: ['breakfast'],
      dietTags: facts.dietTags,
      prepMinutes: 5,
      cookMinutes: 5,
      difficulty: 'easy',
      complexity: 'simple',
      caloriesPerServing: facts.perServing.calories,
      proteinPerServing: facts.perServing.protein,
      fatPerServing: facts.perServing.fat,
      carbsPerServing: facts.perServing.carbs,
      allergens: facts.allergens,
      ingredientsJson: lines,
      batchId: 'test-batch',
      ...overrides,
    },
    include: { localeReviews: true },
  });
}

/** A draft of a Polish name for an ingredient of the test catalogue, pending. */
export function anIngredientNameDraft(t: TestApp, overrides: Partial<Prisma.IngredientNameDraftUncheckedCreateInput> = {}) {
  return t.prisma.ingredientNameDraft.create({
    data: {
      ingredientSlug: 'chicken-breast',
      rawDescription: 'Chicken, broilers or fryers, breast, meat only, raw',
      suggestions: { name: { pl: 'Pierś z kurczaka' } },
      locales: ['pl'],
      batchId: 'test-batch',
      ...overrides,
    },
    include: { localeReviews: true },
  });
}
