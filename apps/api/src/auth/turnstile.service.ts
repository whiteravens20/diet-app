import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Cloudflare Turnstile verification. Fully optional: when `TURNSTILE_ENABLED` is
 * false (the self-hosted default) `verify()` is a no-op and always passes — rate
 * limiting still protects the endpoints regardless.
 */
@Injectable()
export class TurnstileService {
  private readonly logger = new Logger(TurnstileService.name);

  constructor(private readonly config: ConfigService<Env, true>) {}

  get enabled(): boolean {
    return this.config.get('TURNSTILE_ENABLED', { infer: true });
  }

  /** Returns true when the token is valid, or when Turnstile is disabled. */
  async verify(token: string | undefined): Promise<boolean> {
    if (!this.enabled) return true;
    if (!token) return false;

    const secret = this.config.get('TURNSTILE_SECRET_KEY', { infer: true });
    if (!secret) {
      this.logger.warn('TURNSTILE_ENABLED but TURNSTILE_SECRET_KEY missing — failing closed');
      return false;
    }

    try {
      const res = await fetch(VERIFY_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret, response: token }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = (await res.json()) as { success: boolean };
      return data.success === true;
    } catch (err) {
      this.logger.error('Turnstile verification failed', err);
      return false;
    }
  }
}
