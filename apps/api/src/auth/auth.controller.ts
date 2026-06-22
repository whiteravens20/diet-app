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
import { AuthService } from './auth.service.js';

/** Auth endpoints. Throttled tighter than the global default to blunt abuse. */
@Controller('auth')
@Throttle({ default: { limit: 10, ttl: 60_000 } })
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
  login(@Body(new ZodValidationPipe(LoginRequest)) dto: LoginRequest) {
    return this.auth.login(dto);
  }

  @Post('refresh')
  @HttpCode(200)
  refresh(@Body(new ZodValidationPipe(RefreshRequest)) dto: RefreshRequest) {
    return this.auth.refresh(dto.refreshToken);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Body(new ZodValidationPipe(RefreshRequest)) dto: RefreshRequest) {
    await this.auth.logout(dto.refreshToken);
  }

  @Post('password-reset/request')
  @HttpCode(202)
  async requestReset(@Body(new ZodValidationPipe(PasswordResetRequest)) dto: PasswordResetRequest) {
    await this.auth.requestPasswordReset(dto);
  }

  @Post('password-reset/confirm')
  @HttpCode(204)
  async confirmReset(@Body(new ZodValidationPipe(PasswordResetConfirm)) dto: PasswordResetConfirm) {
    await this.auth.confirmPasswordReset(dto);
  }

  @Post('verify-email')
  @HttpCode(204)
  async verifyEmail(@Body(new ZodValidationPipe(VerifyEmailRequest)) dto: VerifyEmailRequest) {
    await this.auth.verifyEmail(dto.token);
  }

  @Post('confirm-email-change')
  @HttpCode(204)
  async confirmEmailChange(
    @Body(new ZodValidationPipe(ConfirmEmailChangeRequest)) dto: ConfirmEmailChangeRequest,
  ) {
    await this.auth.confirmEmailChange(dto.token);
  }
}
