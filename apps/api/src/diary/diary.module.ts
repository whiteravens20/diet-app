// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Module } from '@nestjs/common';
import { DiaryController } from './diary.controller.js';
import { DiaryService } from './diary.service.js';

@Module({
  controllers: [DiaryController],
  providers: [DiaryService],
})
export class DiaryModule {}
