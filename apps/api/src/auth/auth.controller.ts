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
import { byAccount, byAccountAndAddress, byToken, TriesCredential } from '../rate-limit/trackers.js';
import { AuthService } from './auth.service.js';

const MINUTE = 60_000;
const QUARTER_HOUR = 15 * MINUTE;

/**
 * Auth endpoints. Each is limited tighter than the global default, and counts
 * a request by the credential it tries: the account for a sign-in or a reset,
 * the token for a refresh or a link from a mail. Attempts on one account, or
 * with one token, therefore never use up anybody else's. Creating an account
 * has no identity yet and is counted against the client's address.
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

  // Ten tries in a quarter of an hour at one account from one address: whoever
  // guesses uses up their own tries, not those of the owner at another
  // address. Fifty from everywhere together, so that changing address does not
  // buy unlimited guesses at one password; five addresses have to work
  // together before that keeps the owner out.
  @Post('login')
  @HttpCode(200)
  @TriesCredential({ by: byAccountAndAddress, limit: 10, ttl: QUARTER_HOUR }, { by: byAccount, limit: 50, ttl: QUARTER_HOUR })
  login(@Body(new ZodValidationPipe(LoginRequest)) dto: LoginRequest) {
    return this.auth.login(dto);
  }

  @Post('refresh')
  @HttpCode(200)
  @TriesCredential({ by: byToken('refreshToken'), limit: 10, ttl: MINUTE })
  refresh(@Body(new ZodValidationPipe(RefreshRequest)) dto: RefreshRequest) {
    return this.auth.refresh(dto.refreshToken);
  }

  @Post('logout')
  @HttpCode(204)
  @TriesCredential({ by: byToken('refreshToken'), limit: 10, ttl: MINUTE })
  async logout(@Body(new ZodValidationPipe(RefreshRequest)) dto: RefreshRequest) {
    await this.auth.logout(dto.refreshToken);
  }

  // Every accepted request sends a mail: five in a quarter of an hour for one
  // account is plenty for somebody who mistyped, and no way to flood a
  // mailbox. Counted by the account alone, wherever the requests come from:
  // it is the mailbox that is protected.
  @Post('password-reset/request')
  @HttpCode(202)
  @TriesCredential({ by: byAccount, limit: 5, ttl: QUARTER_HOUR })
  async requestReset(@Body(new ZodValidationPipe(PasswordResetRequest)) dto: PasswordResetRequest) {
    await this.auth.requestPasswordReset(dto);
  }

  @Post('password-reset/confirm')
  @HttpCode(204)
  @TriesCredential({ by: byToken('token'), limit: 10, ttl: MINUTE })
  async confirmReset(@Body(new ZodValidationPipe(PasswordResetConfirm)) dto: PasswordResetConfirm) {
    await this.auth.confirmPasswordReset(dto);
  }

  @Post('verify-email')
  @HttpCode(204)
  @TriesCredential({ by: byToken('token'), limit: 10, ttl: MINUTE })
  async verifyEmail(@Body(new ZodValidationPipe(VerifyEmailRequest)) dto: VerifyEmailRequest) {
    await this.auth.verifyEmail(dto.token);
  }

  @Post('confirm-email-change')
  @HttpCode(204)
  @TriesCredential({ by: byToken('token'), limit: 10, ttl: MINUTE })
  async confirmEmailChange(
    @Body(new ZodValidationPipe(ConfirmEmailChangeRequest)) dto: ConfirmEmailChangeRequest,
  ) {
    await this.auth.confirmEmailChange(dto.token);
  }
}
