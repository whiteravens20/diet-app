// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Global, Module } from '@nestjs/common';
import { SignInGate } from './sign-in-gate.js';
import { SignUps } from './sign-ups.js';

/**
 * What slows clients down. Global, because the count of failed sign-ins has
 * to be one count: the guard of the admin panel is provided by three modules.
 * The count of the accounts an address opens is one count for the same reason.
 */
@Global()
@Module({
  providers: [SignInGate, SignUps],
  exports: [SignInGate, SignUps],
})
export class RateLimitModule {}
