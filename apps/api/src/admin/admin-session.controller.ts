// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  AdminSecondFactorOffRequest,
  AdminSecondFactorSetupRequest,
  AdminSessionState,
  AdminSignInRequest,
  SecondFactorConfirmRequest,
  SecondFactorSetup,
} from '@diet-app/shared';
import { alreadyOn, notOn, SecondFactors, wrongCode } from '../auth/second-factors.js';
import { assertFromTheApplication } from '../auth/session-cookies.js';
import { readCookie } from '../common/cookies.js';
import { Answers } from '../common/answers.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { type Env, isAdminEnabled } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SignInGate } from '../rate-limit/sign-in-gate.js';
import {
  ADMIN_COOKIE,
  adminCookie,
  isAdminSession,
  isAdministrator,
  sameText,
  signAdminSession,
} from './admin-session.js';
import { AdminSessionGuard, adminSessionEpoch, assertAdminEnabled } from './admin-session.guard.js';

/** Where the administrator's session begins and ends. */
@Controller('admin/session')
export class AdminSessionController {
  private readonly appUrl: string;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly gate: SignInGate,
    private readonly factors: SecondFactors,
  ) {
    this.appUrl = config.get('APP_URL', { infer: true });
  }

  /**
   * What the admin pages ask first. Says nothing but whether a panel exists,
   * whether this browser is in, and whether signing in takes a code.
   */
  @Get()
  @Answers(AdminSessionState)
  async state(@Req() req: Request): Promise<AdminSessionState> {
    const enabled = isAdminEnabled({
      ADMIN_PASSWORD: this.config.get('ADMIN_PASSWORD', { infer: true }),
    });
    const token = readCookie(req.headers.cookie, ADMIN_COOKIE);
    const signedIn =
      enabled &&
      Boolean(token) &&
      isAdminSession(this.config, token!, await adminSessionEpoch(this.prisma));
    return {
      enabled,
      signedIn,
      secondFactor: enabled && (await this.factors.has('administrator')),
    };
  }

  /** Sign the administrator in: the password, and a code where the second factor is on. The session is a cookie. */
  // One password for the instance, so there is no account to count attempts
  // against: ten a minute per client, and after five wrong ones in a row the
  // sign-in gate makes the client wait, thirty seconds at first and up to a
  // quarter of an hour.
  //
  // Where the administrator has a second factor, the code goes with the
  // password, and a wrong one answers as a wrong password does: without the
  // code nobody learns whether a password they tried was right.
  @Post()
  @HttpCode(204)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async signIn(
    @Body(new ZodValidationPipe(AdminSignInRequest)) body: AdminSignInRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    assertAdminEnabled(this.config);
    // A page of another site cannot sign a visitor in to a session of its choosing.
    assertFromTheApplication(req.headers.origin, this.appUrl);
    const client = req.ip ?? 'unknown';
    // A client that guessed wrong too often waits before its next guess is looked at, right or wrong.
    this.gate.assertOpen('admin', client, res);
    // The code is looked at only for the right password: wrong codes are
    // counted for everybody together, and a stranger must not be able to
    // run that count up.
    if (
      !isAdministrator(this.config, body.user, body.password) ||
      !(await this.passesSecondStep(body.code))
    ) {
      this.gate.failed('admin', client);
      throw new UnauthorizedException({
        error: 'INVALID_CREDENTIALS',
        message: 'Invalid credentials.',
      });
    }
    this.gate.succeeded('admin', client);
    res.setHeader(
      'Set-Cookie',
      adminCookie(signAdminSession(this.config, await adminSessionEpoch(this.prisma)), this.appUrl),
    );
  }

  private async passesSecondStep(code: string | undefined): Promise<boolean> {
    if (code === undefined) return !(await this.factors.has('administrator'));
    const check = await this.factors.check('administrator', code);
    return check === null || check.accepted;
  }

  /** A secret to set an authenticator app up with. It counts from the first code on (`POST second-factor`). */
  @Post('second-factor/setup')
  @HttpCode(200)
  @UseGuards(AdminSessionGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Answers(SecondFactorSetup)
  async proposeSecondFactor(
    @Body(new ZodValidationPipe(AdminSecondFactorSetupRequest)) body: AdminSecondFactorSetupRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SecondFactorSetup> {
    this.assertNotBeingReset();
    this.assertPassword(body.password, req, res);
    if (await this.factors.has('administrator')) throw alreadyOn();
    return this.factors.propose('administrator', this.config.get('ADMIN_USER', { infer: true }));
  }

  /**
   * The first code: signing in to the panel takes one from now on. Every
   * admin session there is began with the password alone and ends; this
   * browser, which has shown the code, gets a new one.
   */
  @Post('second-factor')
  @HttpCode(204)
  @UseGuards(AdminSessionGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async beginSecondFactor(
    @Body(new ZodValidationPipe(SecondFactorConfirmRequest)) body: SecondFactorConfirmRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    this.assertNotBeingReset();
    let epoch = 0;
    await this.factors.begin('administrator', body.enrolment, body.code, async (tx) => {
      const settings = await tx.instanceSettings.upsert({
        where: { id: 'singleton' },
        create: { id: 'singleton', adminSessionEpoch: 1 },
        update: { adminSessionEpoch: { increment: 1 } },
        select: { adminSessionEpoch: true },
      });
      epoch = settings.adminSessionEpoch;
    });
    res.setHeader('Set-Cookie', adminCookie(signAdminSession(this.config, epoch), this.appUrl));
  }

  /** Switch the second factor off: the panel opens with the password alone again. */
  @Delete('second-factor')
  @HttpCode(204)
  @UseGuards(AdminSessionGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async endSecondFactor(
    @Body(new ZodValidationPipe(AdminSecondFactorOffRequest)) body: AdminSecondFactorOffRequest,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    this.assertPassword(body.password, req, res);
    const check = await this.factors.check('administrator', body.code);
    if (check === null) throw notOn();
    if (!check.accepted) throw wrongCode();
    await this.factors.remove('administrator');
  }

  /** The password again, for what a session alone must not be enough for. Wrong ones count as wrong sign-ins do. */
  private assertPassword(password: string, req: Request, res: Response): void {
    const client = req.ip ?? 'unknown';
    this.gate.assertOpen('admin', client, res);
    if (sameText(password, this.config.get('ADMIN_PASSWORD', { infer: true }))) return;
    this.gate.failed('admin', client);
    throw new UnauthorizedException({
      error: 'INVALID_PASSWORD',
      message: 'Current password is incorrect.',
    });
  }

  private assertNotBeingReset(): void {
    if (!this.config.get('ADMIN_SECOND_FACTOR_RESET', { infer: true })) return;
    throw new ConflictException({
      error: 'ADMIN_SECOND_FACTOR_RESET_SET',
      message:
        'ADMIN_SECOND_FACTOR_RESET is on: a second factor would be removed at the next start. Switch it off and restart, then set one up.',
    });
  }

  /** Sign out of this browser. */
  @Delete()
  @HttpCode(204)
  signOut(@Req() req: Request, @Res({ passthrough: true }) res: Response): void {
    assertFromTheApplication(req.headers.origin, this.appUrl);
    res.setHeader('Set-Cookie', adminCookie(null, this.appUrl));
  }

  /** End every admin session there is, this one too: for when a session may be in the wrong hands. */
  @Post('end-all')
  @HttpCode(204)
  @UseGuards(AdminSessionGuard)
  async endAll(@Res({ passthrough: true }) res: Response): Promise<void> {
    await this.prisma.instanceSettings.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', adminSessionEpoch: 1 },
      update: { adminSessionEpoch: { increment: 1 } },
    });
    res.setHeader('Set-Cookie', adminCookie(null, this.appUrl));
  }
}
