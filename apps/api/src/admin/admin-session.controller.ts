// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Body, Controller, Delete, Get, HttpCode, Post, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { AdminSessionState, AdminSignInRequest } from '@diet-app/shared';
import { assertFromTheApplication } from '../auth/session-cookies.js';
import { readCookie } from '../common/cookies.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { type Env, isAdminEnabled } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SignInGate } from '../rate-limit/sign-in-gate.js';
import { ADMIN_COOKIE, adminCookie, isAdminSession, isAdministrator, signAdminSession } from './admin-session.js';
import { AdminSessionGuard, adminSessionEpoch, assertAdminEnabled } from './admin-session.guard.js';

/** Where the administrator's session begins and ends. */
@Controller('admin/session')
export class AdminSessionController {
  private readonly appUrl: string;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly gate: SignInGate,
  ) {
    this.appUrl = config.get('APP_URL', { infer: true });
  }

  /** What the admin pages ask first. Says nothing but whether a panel exists and whether this browser is in. */
  @Get()
  async state(@Req() req: Request): Promise<AdminSessionState> {
    const enabled = isAdminEnabled({ ADMIN_PASSWORD: this.config.get('ADMIN_PASSWORD', { infer: true }) });
    const token = readCookie(req.headers.cookie, ADMIN_COOKIE);
    const signedIn = enabled && Boolean(token) && isAdminSession(this.config, token!, await adminSessionEpoch(this.prisma));
    return { enabled, signedIn };
  }

  // One password for the instance, so there is no account to count attempts
  // against: ten a minute per client, and after five wrong ones in a row the
  // sign-in gate makes the client wait, thirty seconds at first and up to a
  // quarter of an hour.
  @Post()
  @HttpCode(204)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async signIn(@Body(new ZodValidationPipe(AdminSignInRequest)) body: AdminSignInRequest, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    assertAdminEnabled(this.config);
    // A page of another site cannot sign a visitor in to a session of its choosing.
    assertFromTheApplication(req.headers.origin, this.appUrl);
    const client = req.ip ?? 'unknown';
    // A client that guessed wrong too often waits before its next guess is looked at, right or wrong.
    this.gate.assertOpen('admin', client, res);
    if (!isAdministrator(this.config, body.user, body.password)) {
      this.gate.failed('admin', client);
      throw new UnauthorizedException({ error: 'INVALID_CREDENTIALS', message: 'Invalid credentials.' });
    }
    this.gate.succeeded('admin', client);
    res.setHeader('Set-Cookie', adminCookie(signAdminSession(this.config, await adminSessionEpoch(this.prisma)), this.appUrl));
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
