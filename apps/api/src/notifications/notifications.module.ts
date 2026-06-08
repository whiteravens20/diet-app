import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';
import { WeightReminderService } from './weight-reminder.service.js';

@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, WeightReminderService],
  exports: [NotificationsService, WeightReminderService],
})
export class NotificationsModule {}
