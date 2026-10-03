// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';

/** Global so every feature module can inject PrismaService without re-importing. */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
