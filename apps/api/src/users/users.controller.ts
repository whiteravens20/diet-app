// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Readable } from 'node:stream';
import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  StreamableFile,
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
import { requiredUuid, ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { SessionsService } from '../auth/sessions.service.js';
import { AccountExportService } from './account-export.service.js';
import { UsersService } from './users.service.js';

/**
 * Five a minute for each of the routes that check the current password
 * (changing it, changing the address, deleting the account, and what is done
 * about the second factor), counted against the signed-in user: a stolen access token is no way to guess at the
 * password, and nobody keeps the password check busy with their own token.
 */
export const PASSWORD_CHECK = { default: { limit: 5, ttl: 60_000 } };

@Controller('users/me')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly sessions: SessionsService,
    private readonly exports: AccountExportService,
  ) {}

  @Get()
  getMe(@CurrentUser() user: RequestUser) {
    return this.users.getMe(user.id);
  }

  /**
   * Everything the account holds, as one JSON file (`AccountExportService`).
   * It reads every table the account has rows in, so it is asked for a few
   * times an hour at most, counted against the account; and it is nothing
   * for a cache to keep.
   */
  @Get('export')
  @Throttle({ default: { limit: 6, ttl: 3_600_000 } })
  @Header('Cache-Control', 'no-store')
  exportData(@CurrentUser() user: RequestUser): StreamableFile {
    const now = new Date();
    return new StreamableFile(Readable.from(this.exports.pieces(user.id, now)), {
      type: 'application/json; charset=utf-8',
      disposition: `attachment; filename="diet-app-account-${now.toISOString().slice(0, 10)}.json"`,
    });
  }

  /** The sessions of the account that are open: where it is signed in. */
  @Get('sessions')
  listSessions(@CurrentUser() user: RequestUser) {
    return this.sessions.list(user.id);
  }

  /** Sign out everywhere, this session included. */
  @Delete('sessions')
  @HttpCode(204)
  async endSessions(@CurrentUser() user: RequestUser) {
    await this.sessions.endAll(user.id);
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  async endSession(@CurrentUser() user: RequestUser, @Param('id', requiredUuid) id: string) {
    await this.sessions.endOne(user.id, id);
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
