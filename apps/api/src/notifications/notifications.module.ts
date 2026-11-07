// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';
import { CookingReminderService } from './cooking-reminder.service.js';
import { WeightReminderService } from './weight-reminder.service.js';

@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, WeightReminderService, CookingReminderService],
  exports: [NotificationsService, WeightReminderService, CookingReminderService],
})
export class NotificationsModule {}
