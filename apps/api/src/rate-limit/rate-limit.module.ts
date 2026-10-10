// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Global, Module } from '@nestjs/common';
import { SignInGate } from './sign-in-gate.js';

/**
 * What slows clients down. Global, because the count of failed sign-ins has
 * to be one count: the guard of the admin panel is provided by three modules.
 */
@Global()
@Module({
  providers: [SignInGate],
  exports: [SignInGate],
})
export class RateLimitModule {}
