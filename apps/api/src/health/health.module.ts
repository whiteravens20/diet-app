// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { RequestTimes } from './request-times.js';

@Module({
  controllers: [HealthController],
  providers: [RequestTimes],
  exports: [RequestTimes],
})
export class HealthModule {}
