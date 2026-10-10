// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ChangeEmailRequest,
  ChangePasswordRequest,
  DeleteAccountRequest,
  UpdateUserSettings,
} from '@diet-app/shared';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser, type RequestUser } from '../common/current-user.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { UsersService } from './users.service.js';

/**
 * Five a minute for each of the three routes that check the current password
 * (changing it, changing the address, deleting the account), counted against
 * the signed-in user: a stolen access token is no way to guess at the
 * password, and nobody keeps the password check busy with their own token.
 */
const PASSWORD_CHECK = { default: { limit: 5, ttl: 60_000 } };

@Controller('users/me')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  getMe(@CurrentUser() user: RequestUser) {
    return this.users.getMe(user.id);
  }

  @Patch()
  updateSettings(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(UpdateUserSettings)) dto: UpdateUserSettings,
  ) {
    return this.users.updateSettings(user.id, dto);
  }

  @Post('password')
  @HttpCode(204)
  @Throttle(PASSWORD_CHECK)
  async changePassword(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(ChangePasswordRequest)) dto: ChangePasswordRequest,
  ) {
    await this.users.changePassword(user.id, dto);
  }

  @Post('email')
  @HttpCode(202)
  @Throttle(PASSWORD_CHECK)
  async requestEmailChange(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(ChangeEmailRequest)) dto: ChangeEmailRequest,
  ) {
    await this.users.requestEmailChange(user.id, dto);
  }

  @Post('email/resend-verification')
  @HttpCode(202)
  async resendVerification(@CurrentUser() user: RequestUser) {
    await this.users.resendVerification(user.id);
  }

  @Delete()
  @HttpCode(204)
  @Throttle(PASSWORD_CHECK)
  async deleteAccount(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(DeleteAccountRequest)) dto: DeleteAccountRequest,
  ) {
    await this.users.deleteAccount(user.id, dto);
  }
}
