// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Body, Controller, HttpCode, HttpException, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import {
  type AuthResponse,
  ConfirmEmailChangeRequest,
  type Locale,
  LoginRequest,
  PasswordResetConfirm,
  PasswordResetRequest,
  RefreshRequest,
  RegisterRequest,
  VerifyEmailRequest,
} from '@diet-app/shared';
import { readCookie } from '../common/cookies.js';
import { RequestLocale } from '../common/request-locale.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import type { Env } from '../config/env.js';
import { byAccount, byAccountAndAddress, byRefreshToken, byToken, TriesCredential } from '../rate-limit/trackers.js';
import { AuthService } from './auth.service.js';
import { asksForCookies, assertFromTheApplication, noSessionCookies, REFRESH_COOKIE, sessionCookies, withoutRefreshToken } from './session-cookies.js';
import { sessionLabel } from './session-label.js';
import { SessionsService } from './sessions.service.js';

const MINUTE = 60_000;
const QUARTER_HOUR = 15 * MINUTE;

/**
 * Auth endpoints. Each is limited tighter than the global default, twice
 * over. `@Throttle` is what one sender may do, as on every route: ten a
 * minute unless the route says otherwise. `@TriesCredential` is what may be
 * tried at one credential: the account for a sign-in or a reset, the token
 * for a refresh or a link from a mail. Attempts on one account, or with one
 * token, therefore never use up anybody else's, and one sender cannot go
 * through account after account. Creating an account has no identity yet and
 * is counted against its sender alone.
 */
@Controller('auth')
@Throttle({ default: { limit: 10, ttl: MINUTE } })
export class AuthController {
  private readonly appUrl: string;

  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionsService,
    config: ConfigService<Env, true>,
  ) {
    this.appUrl = config.get('APP_URL', { infer: true });
  }

  /** Hand a new session to the client in the way it asked for: in cookies to a browser, in the answer to any other. */
  private begun(req: Request, res: Response, answer: AuthResponse): AuthResponse {
    if (!asksForCookies(req.headers)) return answer;
    res.setHeader('Set-Cookie', sessionCookies(answer.tokens, this.appUrl));
    return withoutRefreshToken(answer);
  }

  /** The refresh token of a browser's session, from its cookie, for a request that comes from the application's own pages. */
  private cookieOf(req: Request): string {
    const token = readCookie(req.headers.cookie, REFRESH_COOKIE);
    if (!token) throw new UnauthorizedException({ error: 'INVALID_REFRESH', message: 'Refresh token rejected.' });
    assertFromTheApplication(req.headers.origin, this.appUrl);
    return token;
  }

  @Post('register')
  async register(
    @Body(new ZodValidationPipe(RegisterRequest)) dto: RegisterRequest,
    @RequestLocale() locale: Locale,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.begun(req, res, await this.auth.register(dto, locale, sessionLabel(req.headers['user-agent'])));
  }

  // Ten tries in a quarter of an hour at one account from one address: whoever
  // guesses uses up their own tries, not those of the owner at another
  // address. Fifty from everywhere together, so that changing address does not
  // buy unlimited guesses at one password; five addresses have to work
  // together before that keeps the owner out.
  @Post('login')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: QUARTER_HOUR } })
  @TriesCredential({ by: byAccountAndAddress, limit: 10, ttl: QUARTER_HOUR }, { by: byAccount, limit: 50, ttl: QUARTER_HOUR })
  async login(@Body(new ZodValidationPipe(LoginRequest)) dto: LoginRequest, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.begun(req, res, await this.auth.login(dto, sessionLabel(req.headers['user-agent'])));
  }

  // Thirty a minute for one sender: many people behind one address refresh
  // their sessions through it.
  @Post('refresh')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: MINUTE } })
  @TriesCredential({ by: byRefreshToken, limit: 10, ttl: MINUTE })
  async refresh(@Body(new ZodValidationPipe(RefreshRequest.prefault({}))) dto: RefreshRequest, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // A client that keeps its own tokens sends one, and gets the next in the answer.
    if (dto.refreshToken) return this.sessions.refresh(dto.refreshToken);

    const token = this.cookieOf(req);
    try {
      const answer = await this.sessions.refresh(token);
      res.setHeader('Set-Cookie', sessionCookies(answer.tokens, this.appUrl));
      return withoutRefreshToken(answer);
    } catch (err) {
      // A session that has ended leaves no cookies behind; one that another tab just refreshed keeps the ones that tab was given.
      if (err instanceof HttpException && err.getStatus() === 401) res.setHeader('Set-Cookie', noSessionCookies(this.appUrl));
      throw err;
    }
  }

  @Post('logout')
  @HttpCode(204)
  @Throttle({ default: { limit: 30, ttl: MINUTE } })
  @TriesCredential({ by: byRefreshToken, limit: 10, ttl: MINUTE })
  async logout(@Body(new ZodValidationPipe(RefreshRequest.prefault({}))) dto: RefreshRequest, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    if (dto.refreshToken) return this.sessions.end(dto.refreshToken);

    await this.sessions.end(this.cookieOf(req));
    res.setHeader('Set-Cookie', noSessionCookies(this.appUrl));
  }

  // Every accepted request sends a mail: five in a quarter of an hour for one
  // account is plenty for somebody who mistyped, and no way to flood a
  // mailbox. Counted by the account alone, wherever the requests come from:
  // it is the mailbox that is protected.
  @Post('password-reset/request')
  @HttpCode(202)
  @Throttle({ default: { limit: 15, ttl: QUARTER_HOUR } })
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
