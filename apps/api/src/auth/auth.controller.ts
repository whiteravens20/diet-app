// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ConfirmEmailChangeRequest,
  type Locale,
  LoginRequest,
  PasswordResetConfirm,
  PasswordResetRequest,
  RefreshRequest,
  RegisterRequest,
  VerifyEmailRequest,
} from '@diet-app/shared';
import { RequestLocale } from '../common/request-locale.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { byEmail, byToken } from '../rate-limit/trackers.js';
import { AuthService } from './auth.service.js';

const MINUTE = 60_000;

/**
 * Auth endpoints. Each is limited tighter than the global default, and counts
 * a request against the credential it tries: the account for a sign-in or a
 * reset, the token for a refresh or a link from a mail. Attempts on one
 * account, or with one token, therefore never use up anybody else's. Creating
 * an account has no identity yet and is counted against the client's address.
 */
@Controller('auth')
@Throttle({ default: { limit: 10, ttl: MINUTE } })
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  register(
    @Body(new ZodValidationPipe(RegisterRequest)) dto: RegisterRequest,
    @RequestLocale() locale: Locale,
  ) {
    return this.auth.register(dto, locale);
  }

  @Post('login')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: MINUTE, getTracker: byEmail } })
  login(@Body(new ZodValidationPipe(LoginRequest)) dto: LoginRequest) {
    return this.auth.login(dto);
  }

  @Post('refresh')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: MINUTE, getTracker: byToken('refreshToken') } })
  refresh(@Body(new ZodValidationPipe(RefreshRequest)) dto: RefreshRequest) {
    return this.auth.refresh(dto.refreshToken);
  }

  @Post('logout')
  @HttpCode(204)
  @Throttle({ default: { limit: 10, ttl: MINUTE, getTracker: byToken('refreshToken') } })
  async logout(@Body(new ZodValidationPipe(RefreshRequest)) dto: RefreshRequest) {
    await this.auth.logout(dto.refreshToken);
  }

  // Every accepted request sends a mail: five in a quarter of an hour for one
  // address is plenty for somebody who mistyped, and no way to flood a mailbox.
  @Post('password-reset/request')
  @HttpCode(202)
  @Throttle({ default: { limit: 5, ttl: 15 * MINUTE, getTracker: byEmail } })
  async requestReset(@Body(new ZodValidationPipe(PasswordResetRequest)) dto: PasswordResetRequest) {
    await this.auth.requestPasswordReset(dto);
  }

  @Post('password-reset/confirm')
  @HttpCode(204)
  @Throttle({ default: { limit: 10, ttl: MINUTE, getTracker: byToken('token') } })
  async confirmReset(@Body(new ZodValidationPipe(PasswordResetConfirm)) dto: PasswordResetConfirm) {
    await this.auth.confirmPasswordReset(dto);
  }

  @Post('verify-email')
  @HttpCode(204)
  @Throttle({ default: { limit: 10, ttl: MINUTE, getTracker: byToken('token') } })
  async verifyEmail(@Body(new ZodValidationPipe(VerifyEmailRequest)) dto: VerifyEmailRequest) {
    await this.auth.verifyEmail(dto.token);
  }

  @Post('confirm-email-change')
  @HttpCode(204)
  @Throttle({ default: { limit: 10, ttl: MINUTE, getTracker: byToken('token') } })
  async confirmEmailChange(
    @Body(new ZodValidationPipe(ConfirmEmailChangeRequest)) dto: ConfirmEmailChangeRequest,
  ) {
    await this.auth.confirmEmailChange(dto.token);
  }
}
