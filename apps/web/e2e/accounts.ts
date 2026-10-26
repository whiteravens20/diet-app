// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { APIRequestContext } from '@playwright/test';

/** An account with something on every page: a profile, a plan, a shopping list, a pantry row, a weight, a marked recipe. */
export interface Account {
  email: string;
  password: string;
  profileId: string;
  planId: string;
  recipeId: string;
}

/** Where a run keeps what its tests share: the accounts it made, and each project's browser session. */
export const STATE = join(__dirname, '.state');
const ACCOUNTS = join(STATE, 'accounts.json');

const PASSWORD = 'Browser-Test-Passw0rd';

/** The day it is for the browser, as the API takes days. */
function today(): string {
  const now = new Date();
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
}

async function made<T>(
  request: APIRequestContext,
  path: string,
  token: string,
  data: unknown,
): Promise<T> {
  const res = await request.post(`/api${path}`, {
    data,
    headers: { authorization: `Bearer ${token}`, 'x-client-date': today() },
  });
  if (!res.ok()) throw new Error(`POST ${path} answered ${res.status()}: ${await res.text()}`);
  return (await res.json()) as T;
}

/**
 * Register an account through the API and give it something to show on every page. It signs up
 * in `locale`, as the web asks in the language of its page, and that becomes the account's.
 */
export async function anAccount(
  request: APIRequestContext,
  name: string,
  locale: string,
): Promise<Account> {
  const email = `browser-${name}-${Date.now().toString(36)}@example.test`;
  const registered = await request.post('/api/auth/register', {
    data: { email, password: PASSWORD, displayName: 'Browser test' },
    headers: { 'accept-language': locale },
  });
  if (!registered.ok())
    throw new Error(`registration answered ${registered.status()}: ${await registered.text()}`);
  const token = ((await registered.json()) as { tokens: { accessToken: string } }).tokens
    .accessToken;

  const profile = await made<{ id: string }>(request, '/profiles', token, {
    name: 'Me',
    age: 30,
    sex: 'male',
    heightCm: 180,
    weightKg: 80,
  });
  const plan = await made<{ id: string; days: { meals: { recipe: { id: string } | null }[] }[] }>(
    request,
    '/meal-plans/generate',
    token,
    {
      profileId: profile.id,
      startDate: today(),
      durationDays: 3,
    },
  );
  const recipeId = plan.days.flatMap((day) => day.meals).find((meal) => meal.recipe)!.recipe!.id;
  await made(request, '/shopping-lists/generate', token, { planId: plan.id });
  await made(request, '/weights', token, { profileId: profile.id, kg: 80 });
  await made(request, '/favorites', token, { profileId: profile.id, recipeId });
  const found = await request.get('/api/ingredients?search=rice', {
    headers: { authorization: `Bearer ${token}` },
  });
  const [ingredient] = (await found.json()) as { id: string }[];
  if (ingredient)
    await made(request, '/inventory', token, {
      profileId: profile.id,
      ingredientId: ingredient.id,
      quantity: 500,
      unit: 'g',
    });
  return { email, password: PASSWORD, profileId: profile.id, planId: plan.id, recipeId };
}

export function keepAccounts(accounts: Record<string, Account>): void {
  mkdirSync(STATE, { recursive: true });
  writeFileSync(ACCOUNTS, JSON.stringify(accounts, null, 2));
}

export function accountOf(project: string): Account {
  const account = (JSON.parse(readFileSync(ACCOUNTS, 'utf8')) as Record<string, Account>)[project];
  if (!account) throw new Error(`The run made no account for the project "${project}".`);
  return account;
}
