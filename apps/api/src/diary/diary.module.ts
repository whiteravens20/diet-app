// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Module } from '@nestjs/common';
import { DiarySummaryController } from './diary-summary.controller.js';
import { DiarySummaryService } from './diary-summary.service.js';
import { DiaryController } from './diary.controller.js';
import { DiaryService } from './diary.service.js';

@Module({
  controllers: [DiaryController, DiarySummaryController],
  providers: [DiaryService, DiarySummaryService],
})
export class DiaryModule {}
