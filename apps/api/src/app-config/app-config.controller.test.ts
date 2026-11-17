// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import { NamedDiet } from '@diet-app/shared';
import { describe, expect, it } from 'vitest';
import type { TurnstileService } from '../auth/turnstile.service.js';
import type { CatalogueCoverageService } from '../catalogue/catalogue-coverage.service.js';
import type { Env } from '../config/env.js';
import { recipesPerDietAndMeal } from '../engine/coverage.js';
import type { MailService } from '../mail/mail.service.js';
import { AppConfigController } from './app-config.controller.js';

/** What the settings hold when a test says nothing of products: as they are left out. */
const NO_PRODUCT_SETTINGS: Partial<Env> = {
  OPEN_FOOD_FACTS_LOOKUPS: true,
  OPEN_FOOD_FACTS_COUNTRIES: [],
};

function configOf(env: Partial<Env>, mail = true) {
  const held = { ...NO_PRODUCT_SETTINGS, ...env };
  const config = { get: (key: keyof Env) => held[key] } as unknown as ConfigService<Env, true>;
  const controller = new AppConfigController(
    config,
    { enabled: false } as TurnstileService,
    { enabled: mail } as MailService,
    { recent: () => Promise.resolve(recipesPerDietAndMeal([])) } as CatalogueCoverageService,
  );
  return controller.get();
}

const packageVersion = (
  JSON.parse(readFileSync(resolve(__dirname, '../../../../package.json'), 'utf8')) as {
    version: string;
  }
).version;

describe('GET /api/config', () => {
  it.each([
    ['lookups on', true, [], { offered: true, lookups: true }],
    ['lookups on and a country', true, ['poland'], { offered: true, lookups: true }],
    ['a country alone', false, ['poland'], { offered: true, lookups: false }],
    ['neither', false, [], { offered: false, lookups: false }],
  ])('says what it offers of products with %s', async (_, lookups, countries, products) => {
    const answer = await configOf({
      OLLAMA_USER_POLICY: 'off',
      OPEN_FOOD_FACTS_LOOKUPS: lookups,
      OPEN_FOOD_FACTS_COUNTRIES: countries,
    });
    expect(answer.products).toEqual(products);
  });

  it('publishes nothing about the operator unless they set it, and the package version', async () => {
    expect((await configOf({ OLLAMA_USER_POLICY: 'allowlist' })).instance).toEqual({
      supportUrl: null,
      operatorContact: null,
      androidAppUrl: null,
      version: packageVersion,
    });
  });

  it('publishes what the operator set', async () => {
    const { instance } = await configOf({
      OLLAMA_USER_POLICY: 'off',
      SUPPORT_URL: 'https://example.org/support',
      OPERATOR_CONTACT: 'ops@example.org',
      ANDROID_APP_URL: 'https://example.org/android/',
      APP_VERSION: '2026.10-a1b2c3d',
    });
    expect(instance).toEqual({
      supportUrl: 'https://example.org/support',
      operatorContact: 'ops@example.org',
      androidAppUrl: 'https://example.org/android/',
      version: '2026.10-a1b2c3d',
    });
  });

  it('publishes how many profiles an account may hold on this instance', async () => {
    expect((await configOf({ MAX_PROFILES_PER_ACCOUNT: 4 })).accounts).toEqual({ maxProfiles: 4 });
  });

  it('publishes the most a recipe repeats in a plan that names no number, and that the operator set none', async () => {
    expect((await configOf({ DEFAULT_MAX_REPEATS_PER_RECIPE: 3 })).plans.maxRepeatsPerRecipe).toBe(
      3,
    );
    expect((await configOf({})).plans.maxRepeatsPerRecipe).toBeNull();
  });

  it('publishes the meals of a day at each number of meals, in the order of the day', async () => {
    expect((await configOf({})).plans.mealSlots).toEqual({
      '2': ['breakfast', 'dinner'],
      '3': ['breakfast', 'lunch', 'dinner'],
      '4': ['breakfast', 'lunch', 'dinner', 'snack'],
      '5': ['breakfast', 'second_breakfast', 'lunch', 'snack', 'dinner'],
    });
  });

  it("publishes the order in which a plan's limits give way, the kinds of protein first and the times in seven days last", async () => {
    expect((await configOf({})).plans.relaxations).toEqual([
      'ingredient_cap',
      'kind_same_day',
      'variety_floor',
      'cook_time',
      'same_day',
      'consecutive_days',
      'weekly_cap',
    ]);
  });

  it('publishes what a plan that wastes less does on every diet with a split of its own: more of the pantry and the packs used, for fewer recipes', async () => {
    const { lessWaste } = (await configOf({})).plans;
    expect(Object.keys(lessWaste).sort()).toEqual([...NamedDiet.options].sort());
    for (const effect of Object.values(lessWaste)) {
      expect(effect.pantry.less).toBeGreaterThan(effect.pantry.now);
      expect(effect.packs.less).toBeGreaterThanOrEqual(effect.packs.now);
      expect(effect.fewerRecipes).toBeGreaterThan(0);
    }
  });

  it('publishes what a plan that wastes nothing does on every diet, and the rules it keeps', async () => {
    const { lessWaste, noWaste, waste } = (await configOf({})).plans;
    expect(Object.keys(noWaste).sort()).toEqual([...NamedDiet.options].sort());
    for (const diet of NamedDiet.options) {
      // More of the packs used than a plan that wastes less, for fewer recipes still.
      expect(noWaste[diet].packs.less).toBeGreaterThanOrEqual(lessWaste[diet].packs.less);
      expect(noWaste[diet].fewerRecipes).toBeGreaterThan(lessWaste[diet].fewerRecipes);
    }
    expect(waste).toEqual({
      less: { restsOfDay: 3 },
      none: {
        restsOfDay: 5,
        daysInARow: 3,
        timesAWeek: 5,
        twiceADay: true,
        meatAndFishDays: 3,
        otherDays: 5,
      },
    });
  });

  describe("the terms of the instance's own AI", () => {
    /** The operator's provider as wrcloud sets it up, with the defaults of the rest. */
    const OPERATORS: Partial<Env> = {
      OLLAMA_USER_POLICY: 'off',
      AI_DEFAULT_PROVIDER: 'openrouter',
      AI_DEFAULT_MODEL: 'openai/gpt-6-luna',
      OPENROUTER_API_KEY: 'or-secret-key',
      AI_ADMIN_DATA_POLICY: 'no_training',
      AI_ADMIN_ACCESS: 'approved',
      AI_ADMIN_USER_MONTHLY_LIMIT: 40,
      AI_ADMIN_INSTANCE_MONTHLY_LIMIT: 1000,
    };

    it('are which endpoints its requests may reach, which accounts may use it and how much', async () => {
      expect((await configOf({ ...OPERATORS, AI_ADMIN_DATA_POLICY: 'no_retention' })).ai).toEqual({
        ollamaUserPolicy: 'off',
        operator: {
          dataPolicy: 'no_retention',
          access: 'approved',
          monthlyLimit: 40,
          instanceMonthlyLimit: 1000,
        },
      });
    });

    it.each<[string, Partial<Env>]>([
      ['no provider is set', { AI_DEFAULT_PROVIDER: undefined }],
      ['a provider is set without a model', { AI_DEFAULT_MODEL: undefined }],
      ['the model is blank', { AI_DEFAULT_MODEL: '' }],
      ['an account may make no request', { AI_ADMIN_USER_MONTHLY_LIMIT: 0 }],
      ['the instance may make no request', { AI_ADMIN_INSTANCE_MONTHLY_LIMIT: 0 }],
    ])('are none where %s', async (_, change) => {
      expect((await configOf({ ...OPERATORS, ...change })).ai.operator).toBeNull();
    });

    it('name no choice of endpoints for a provider that is not OpenRouter', async () => {
      const { ai } = await configOf({ ...OPERATORS, AI_DEFAULT_PROVIDER: 'openai' });
      expect(ai.operator?.dataPolicy).toBeNull();
    });

    it('say every account for the confirmed ones where the instance sends no mail, as an address is confirmed at sign-up', async () => {
      const confirmed = { ...OPERATORS, AI_ADMIN_ACCESS: 'confirmed' as const };
      expect((await configOf(confirmed, true)).ai.operator?.access).toBe('confirmed');
      expect((await configOf(confirmed, false)).ai.operator?.access).toBe('everyone');
      expect((await configOf(OPERATORS, false)).ai.operator?.access).toBe('approved');
    });

    it('leave the provider, the model and the key unsaid', async () => {
      const body = JSON.stringify(await configOf(OPERATORS));
      expect(body).not.toContain('openrouter');
      expect(body).not.toContain('gpt-6-luna');
      expect(body).not.toContain('or-secret-key');
    });
  });

  it('never carries a secret', async () => {
    const body = JSON.stringify(
      await configOf({ TURNSTILE_SECRET_KEY: 'turnstile-secret', JWT_ACCESS_SECRET: 'jwt-secret' }),
    );
    expect(body).not.toContain('turnstile-secret');
    expect(body).not.toContain('jwt-secret');
  });
});
