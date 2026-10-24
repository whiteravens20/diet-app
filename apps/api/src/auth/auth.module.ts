// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { MailModule } from '../mail/mail.module.js';
import { SignUps } from '../rate-limit/sign-ups.js';
import { AccountEmail } from './account-email.js';
import { AccountSecondFactor } from './account-second-factor.service.js';
import { AddressResealService } from './address-reseal.service.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { BrowserSignIn } from './browser-sign-in.service.js';
import { JwtStrategy } from './jwt.strategy.js';
import { SecondFactors } from './second-factors.js';
import { SessionsService } from './sessions.service.js';
import { TurnstileService } from './turnstile.service.js';

@Module({
  imports: [PassportModule, JwtModule.register({}), MailModule],
  controllers: [AuthController],
  providers: [AuthService, AccountEmail, AccountSecondFactor, AddressResealService, BrowserSignIn, SecondFactors, SessionsService, JwtStrategy, TurnstileService, SignUps],
  exports: [AuthService, AccountEmail, AccountSecondFactor, AddressResealService, BrowserSignIn, SecondFactors, SessionsService],
})
export class AuthModule {}
