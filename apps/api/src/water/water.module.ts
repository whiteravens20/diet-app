// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Module } from '@nestjs/common';
import { WaterController } from './water.controller.js';
import { WaterService } from './water.service.js';

@Module({ controllers: [WaterController], providers: [WaterService] })
export class WaterModule {}
