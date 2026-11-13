// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { productsOffered } from '../products/offered.js';
import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MEAL_SLOTS_BY_COUNT,
  MealCountKey,
  PLAN_RELAXATIONS,
  PublicConfig,
  type MealType,
} from '@diet-app/shared';
import { confirmationUnlocksAi } from '../ai/ai-quota.service.js';
import { Answers } from '../common/answers.decorator.js';
import { CatalogueCoverageService } from '../catalogue/catalogue-coverage.service.js';
import type { Env } from '../config/env.js';
import { supplyByMealCount } from '../engine/coverage.js';
import { LESS_WASTE_EFFECT } from '../engine/optimizer.js';
import { MailService } from '../mail/mail.service.js';
import { TurnstileService } from '../auth/turnstile.service.js';
import { PACKAGE_VERSION } from './package-version.js';

/**
 * Public, unauthenticated runtime configuration for the web app. Exposes only
 * non-secret operator choices the front-end needs before sign-in (whether to
 * render Turnstile + the site key, whether email flows are available), what
 * the operator publishes about the instance, which diets the catalogue has
 * recipes for, the limits the operator set for accounts and plans, whether
 * products with a barcode are offered, how a plan's days are laid out, and
 * what a plan that wastes less does on each diet.
 * Mirrors the unauthenticated HealthController, and is limited like it and
 * every other route.
 */
@Controller('config')
export class AppConfigController {
  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly turnstile: TurnstileService,
    private readonly mail: MailService,
    private readonly coverage: CatalogueCoverageService,
  ) {}

  /** What a page has to know before anybody has signed in: whether signing up asks for a challenge, whether mail is on, what AI the instance offers and how well its catalogue serves each diet. */
  @Get()
  @Answers(PublicConfig)
  async get(): Promise<PublicConfig> {
    return {
      turnstile: {
        enabled: this.turnstile.enabled,
        siteKey: this.config.get('TURNSTILE_SITE_KEY', { infer: true }) ?? null,
      },
      email: {
        enabled: this.mail.enabled,
        confirmationUnlocksAi: this.mail.enabled && confirmationUnlocksAi(this.config),
      },
      ai: {
        ollamaUserPolicy: this.config.get('OLLAMA_USER_POLICY', { infer: true }),
      },
      instance: {
        supportUrl: this.config.get('SUPPORT_URL', { infer: true }) ?? null,
        operatorContact: this.config.get('OPERATOR_CONTACT', { infer: true }) ?? null,
        androidAppUrl: this.config.get('ANDROID_APP_URL', { infer: true }) ?? null,
        version: this.config.get('APP_VERSION', { infer: true }) ?? PACKAGE_VERSION,
      },
      catalogue: { supply: supplyByMealCount(await this.coverage.recent()) },
      accounts: { maxProfiles: this.config.get('MAX_PROFILES_PER_ACCOUNT', { infer: true }) },
      products: {
        offered: productsOffered(this.config),
        lookups: this.config.get('OPEN_FOOD_FACTS_LOOKUPS', { infer: true }),
      },
      plans: {
        maxRepeatsPerRecipe:
          this.config.get('DEFAULT_MAX_REPEATS_PER_RECIPE', { infer: true }) ?? null,
        mealSlots: Object.fromEntries(
          MealCountKey.options.map((count) => [count, MEAL_SLOTS_BY_COUNT[Number(count)]!]),
        ) as Record<MealCountKey, MealType[]>,
        relaxations: [...PLAN_RELAXATIONS],
        lessWaste: LESS_WASTE_EFFECT,
      },
    };
  }
}
