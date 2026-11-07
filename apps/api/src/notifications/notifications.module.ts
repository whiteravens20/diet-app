// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';
import { CookingReminderService } from './cooking-reminder.service.js';
import { WaterReminderService } from './water-reminder.service.js';
import { WeightReminderService } from './weight-reminder.service.js';

@Module({
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    WeightReminderService,
    CookingReminderService,
    WaterReminderService,
  ],
  exports: [
    NotificationsService,
    WeightReminderService,
    CookingReminderService,
    WaterReminderService,
  ],
})
export class NotificationsModule {}
