// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SecondFactors } from '../auth/second-factors.js';
import type { Env } from '../config/env.js';

/**
 * The way back in for an administrator who lost the authenticator app: with
 * `ADMIN_SECOND_FACTOR_RESET` on, the administrator's second factor is
 * removed when the application starts. Whoever can set the environment of the
 * instance holds the password too, so this gives away nothing they did not
 * have. While it is on no second factor can be set up: it would be gone at
 * the next start, without anybody noticing.
 */
@Injectable()
export class AdminSecondFactorReset implements OnApplicationBootstrap {
  private readonly logger = new Logger('Admin');

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly factors: SecondFactors,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.get('ADMIN_SECOND_FACTOR_RESET', { infer: true })) return;
    if (await this.factors.remove('administrator')) {
      this.logger.warn("ADMIN_SECOND_FACTOR_RESET is on: the administrator's second factor was removed. The panel opens with the password alone.");
    }
  }
}
