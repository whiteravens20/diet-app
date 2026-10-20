// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Body, Controller, HttpCode, HttpException, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import {
  AuthResponse,
  BrowserCode,
  BrowserCodeAccount,
  BrowserCodeRequest,
  BrowserSignInRequest,
  ConfirmEmailChangeRequest,
  LoginRequest,
  LoginResponse,
  PasswordResetConfirm,
  PasswordResetRequest,
  RefreshRequest,
  RegisterRequest,
  SecondFactorSignInRequest,
  VerifyEmailRequest,
  type Locale,
} from '@diet-app/shared';
import { readCookie } from '../common/cookies.js';
import { RequestLocale } from '../common/request-locale.decorator.js';
import { Answers } from '../common/answers.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import type { Env } from '../config/env.js';
import { byAccount, byAccountAndAddress, byRefreshToken, byToken, TriesCredential } from '../rate-limit/trackers.js';
import { AuthService } from './auth.service.js';
import { BrowserSignIn } from './browser-sign-in.service.js';
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
    private readonly browsers: BrowserSignIn,
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

  /** Open an account, and a session with it. */
  @Post('register')
  @Answers(AuthResponse)
  async register(
    @Body(new ZodValidationPipe(RegisterRequest)) dto: RegisterRequest,
    @RequestLocale() locale: Locale,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.begun(req, res, await this.auth.register(dto, locale, sessionLabel(req.headers['user-agent'])));
  }

  /** Sign in with an address and a password. An account with a second factor gets a challenge in the place of a session. */
  // Ten tries in a quarter of an hour at one account from one address: whoever
  // guesses uses up their own tries, not those of the owner at another
  // address. Fifty from everywhere together, so that changing address does not
  // buy unlimited guesses at one password; five addresses have to work
  // together before that keeps the owner out.
  @Post('login')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: QUARTER_HOUR } })
  @TriesCredential({ by: byAccountAndAddress, limit: 10, ttl: QUARTER_HOUR }, { by: byAccount, limit: 50, ttl: QUARTER_HOUR })
  @Answers(LoginResponse)
  async login(@Body(new ZodValidationPipe(LoginRequest)) dto: LoginRequest, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const answer = await this.auth.login(dto, sessionLabel(req.headers['user-agent']));
    // An account with a second factor has no session yet: its second step is still to come.
    return 'secondFactor' in answer ? answer : this.begun(req, res, answer);
  }

  /** The second step of signing in: the challenge of the first, and a code. */
  // The second step of signing in, for whoever got a challenge for the right
  // password. Ten tries at one challenge; how many wrong codes an account
  // may be given is counted with the account, wherever they come from.
  @Post('login/second-factor')
  @HttpCode(200)
  @TriesCredential({ by: byToken('challenge'), limit: 10, ttl: 5 * MINUTE })
  @Answers(AuthResponse)
  async finishLogin(
    @Body(new ZodValidationPipe(SecondFactorSignInRequest)) dto: SecondFactorSignInRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.begun(req, res, await this.auth.finishLogin(dto, sessionLabel(req.headers['user-agent'])));
  }

  /** A new access token for a refresh token, which is replaced by a new one. */
  // Thirty a minute for one sender: many people behind one address refresh
  // their sessions through it.
  @Post('refresh')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: MINUTE } })
  @TriesCredential({ by: byRefreshToken, limit: 10, ttl: MINUTE })
  @Answers(AuthResponse)
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

  /** End the session of the refresh token. */
  @Post('logout')
  @HttpCode(204)
  @Throttle({ default: { limit: 30, ttl: MINUTE } })
  @TriesCredential({ by: byRefreshToken, limit: 10, ttl: MINUTE })
  async logout(@Body(new ZodValidationPipe(RefreshRequest.prefault({}))) dto: RefreshRequest, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    if (dto.refreshToken) return this.sessions.end(dto.refreshToken);

    await this.sessions.end(this.cookieOf(req));
    res.setHeader('Set-Cookie', noSessionCookies(this.appUrl));
  }

  /**
   * A code that signs a browser in to the account of a client that keeps its
   * own tokens: for the refresh token of its session, which is replaced by a
   * new one as a refresh replaces it. An account gets at most 30 codes in an
   * hour.
   */
  // Counted as a refresh is: for the refresh token, and for one sender.
  @Post('browser-code')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: MINUTE } })
  @TriesCredential({ by: byRefreshToken, limit: 10, ttl: MINUTE })
  @Answers(BrowserCode)
  codeForABrowser(@Body(new ZodValidationPipe(BrowserCodeRequest)) dto: BrowserCodeRequest) {
    return this.browsers.codeFor(dto.refreshToken);
  }

  /** Whose account a code from an application is for, without using the code. Only the application's own pages may ask. */
  @Post('browser-sign-in/account')
  @HttpCode(200)
  @TriesCredential({ by: byToken('code'), limit: 10, ttl: MINUTE })
  @Answers(BrowserCodeAccount)
  accountOfABrowserCode(@Body(new ZodValidationPipe(BrowserSignInRequest)) dto: BrowserSignInRequest, @Req() req: Request) {
    assertFromTheApplication(req.headers.origin, this.appUrl);
    return this.browsers.accountOf(dto.code);
  }

  /**
   * Sign this browser in with a code from an application: a session of its
   * own for a day, in cookies, which takes the place of the session the
   * browser had. Only the application's own pages may ask.
   */
  @Post('browser-sign-in')
  @HttpCode(200)
  @TriesCredential({ by: byToken('code'), limit: 10, ttl: MINUTE })
  @Answers(AuthResponse)
  async signInABrowser(@Body(new ZodValidationPipe(BrowserSignInRequest)) dto: BrowserSignInRequest, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    assertFromTheApplication(req.headers.origin, this.appUrl);
    const answer = await this.browsers.signIn(dto.code, readCookie(req.headers.cookie, REFRESH_COOKIE), sessionLabel(req.headers['user-agent']));
    res.setHeader('Set-Cookie', sessionCookies(answer.tokens, this.appUrl));
    return withoutRefreshToken(answer);
  }

  /** Ask for a mail with a link to set a new password. The answer says nothing of whether the address has an account. */
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

  /** Set a new password with the token from the mail. */
  @Post('password-reset/confirm')
  @HttpCode(204)
  @TriesCredential({ by: byToken('token'), limit: 10, ttl: MINUTE })
  async confirmReset(@Body(new ZodValidationPipe(PasswordResetConfirm)) dto: PasswordResetConfirm) {
    await this.auth.confirmPasswordReset(dto);
  }

  /** Confirm the account's address with the token from the mail. */
  @Post('verify-email')
  @HttpCode(204)
  @TriesCredential({ by: byToken('token'), limit: 10, ttl: MINUTE })
  async verifyEmail(@Body(new ZodValidationPipe(VerifyEmailRequest)) dto: VerifyEmailRequest) {
    await this.auth.verifyEmail(dto.token);
  }

  /** Confirm a new address with the token from the mail that was sent to it. */
  @Post('confirm-email-change')
  @HttpCode(204)
  @TriesCredential({ by: byToken('token'), limit: 10, ttl: MINUTE })
  async confirmEmailChange(
    @Body(new ZodValidationPipe(ConfirmEmailChangeRequest)) dto: ConfirmEmailChangeRequest,
  ) {
    await this.auth.confirmEmailChange(dto.token);
  }
}
