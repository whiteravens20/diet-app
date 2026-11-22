// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Global, Module } from '@nestjs/common';
import { SignInGate } from './sign-in-gate.js';
import { WebServer } from './web-server.js';

/**
 * What slows clients down. Global, because the count of failed sign-ins has
 * to be one count: the guard of the admin panel is provided by three modules.
 * The web server's addresses are known once, for every request.
 */
@Global()
@Module({
  providers: [SignInGate, WebServer],
  exports: [SignInGate, WebServer],
})
export class RateLimitModule {}
