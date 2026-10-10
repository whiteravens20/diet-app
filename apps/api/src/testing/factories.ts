// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Shortcuts that put a test in its starting state: an account, a profile, a
 * plan. They call the services directly, so a file that needs many of them does
 * not run into the per-route request limits; the behaviour under test goes over
 * HTTP.
 */
import { GeneratePlanRequest, ProfileInput, type MealPlan, type Profile } from '@diet-app/shared';
import { AuthService } from '../auth/auth.service.js';
import { MealPlansService } from '../meal-plans/meal-plans.service.js';
import { ProfilesService } from '../profiles/profiles.service.js';
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
  return t.app.get(MealPlansService).generate(user.id, 'en', request);
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
