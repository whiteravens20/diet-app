// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { Notification, Updated } from '@diet-app/shared';
import { CurrentUser, type RequestUser } from '../common/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { NotificationsService } from './notifications.service.js';
import { Answers, AnswersListOf } from '../common/answers.decorator.js';
import { requiredUuid } from '../common/zod-validation.pipe.js';

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  /** The notifications of the account that are not read yet. */
  @Get('unread')
  @AnswersListOf(Notification)
  unread(@CurrentUser() user: RequestUser) {
    return this.notifications.listUnread(user.id);
  }

  /** Mark a notification as read. */
  @Post(':id/read')
  @HttpCode(204)
  async markRead(
    @CurrentUser() user: RequestUser,
    @Param('id', requiredUuid) id: string,
  ): Promise<void> {
    await this.notifications.markRead(user.id, id);
  }

  /** Mark every notification of the account as read, and say how many there were. */
  @Post('read-all')
  @HttpCode(200)
  @Answers(Updated)
  markAllRead(@CurrentUser() user: RequestUser) {
    return this.notifications.markAllRead(user.id);
  }
}
