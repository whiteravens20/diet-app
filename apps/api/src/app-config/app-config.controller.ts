// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PublicConfig } from '@diet-app/shared';
import { Answers } from '../common/answers.decorator.js';
import { CatalogueCoverageService } from '../catalogue/catalogue-coverage.service.js';
import type { Env } from '../config/env.js';
import { depthByMealCount } from '../engine/coverage.js';
import { MailService } from '../mail/mail.service.js';
import { TurnstileService } from '../auth/turnstile.service.js';
import { PACKAGE_VERSION } from './package-version.js';

/**
 * Public, unauthenticated runtime configuration for the web app. Exposes only
 * non-secret operator choices the front-end needs before sign-in (whether to
 * render Turnstile + the site key, whether email flows are available), what
 * the operator publishes about the instance, which diets the catalogue has
 * recipes for, and the limits the operator set for accounts and plans.
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

  /** What a page has to know before anybody has signed in: whether signing up asks for a challenge, whether mail is on, what AI the instance offers and how deep its catalogue is. */
  @Get()
  @Answers(PublicConfig)
  async get(): Promise<PublicConfig> {
    return {
      turnstile: {
        enabled: this.turnstile.enabled,
        siteKey: this.config.get('TURNSTILE_SITE_KEY', { infer: true }) ?? null,
      },
      email: { enabled: this.mail.enabled },
      ai: {
        ollamaUserPolicy: this.config.get('OLLAMA_USER_POLICY', { infer: true }),
      },
      instance: {
        supportUrl: this.config.get('SUPPORT_URL', { infer: true }) ?? null,
        operatorContact: this.config.get('OPERATOR_CONTACT', { infer: true }) ?? null,
        version: this.config.get('APP_VERSION', { infer: true }) ?? PACKAGE_VERSION,
      },
      catalogue: { depth: depthByMealCount(await this.coverage.recent()) },
      accounts: { maxProfiles: this.config.get('MAX_PROFILES_PER_ACCOUNT', { infer: true }) },
      plans: {
        maxRepeatsPerRecipe:
          this.config.get('DEFAULT_MAX_REPEATS_PER_RECIPE', { infer: true }) ?? null,
      },
    };
  }
}
