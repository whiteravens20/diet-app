// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';
import type { PublicConfig } from '@diet-app/shared';
import type { Env } from '../config/env.js';
import { MailService } from '../mail/mail.service.js';
import { TurnstileService } from '../auth/turnstile.service.js';
import { PACKAGE_VERSION } from './package-version.js';

/**
 * Public, unauthenticated runtime configuration for the web app. Exposes only
 * non-secret operator choices the front-end needs before sign-in (whether to
 * render Turnstile + the site key, whether email flows are available) and what
 * the operator publishes about the instance. Mirrors the unauthenticated
 * HealthController.
 *
 * Not limited: it reads nothing but the process's own settings, every page
 * needs it before anybody is signed in, and visitors behind one proxy would
 * otherwise use up one another's allowance for it.
 */
@SkipThrottle()
@Controller('config')
export class AppConfigController {
  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly turnstile: TurnstileService,
    private readonly mail: MailService,
  ) {}

  @Get()
  get(): PublicConfig {
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
    };
  }
}
