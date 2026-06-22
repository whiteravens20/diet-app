import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PublicConfig } from '@diet-app/shared';
import type { Env } from '../config/env.js';
import { MailService } from '../mail/mail.service.js';
import { TurnstileService } from '../auth/turnstile.service.js';

/**
 * Public, unauthenticated runtime configuration for the web app. Exposes only
 * non-secret operator choices the front-end needs before sign-in (whether to
 * render Turnstile + the site key, whether email flows are available). Mirrors
 * the unauthenticated HealthController.
 */
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
    };
  }
}
