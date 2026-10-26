// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Body, Controller, Delete, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  RecoveryCodes,
  SecondFactorConfirmRequest,
  SecondFactorProofRequest,
  SecondFactorSetup,
  SecondFactorSetupRequest,
  SecondFactorState,
} from '@diet-app/shared';
import { AccountSecondFactor } from '../auth/account-second-factor.service.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { CurrentUser, type RequestUser } from '../common/current-user.decorator.js';
import { Answers } from '../common/answers.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { PASSWORD_CHECK } from './users.controller.js';

/** The second factor of the signed-in account: whether it has one, setting one up, and taking it away. */
@Controller('users/me/second-factor')
@UseGuards(JwtAuthGuard)
export class SecondFactorController {
  constructor(private readonly secondFactor: AccountSecondFactor) {}

  /** Whether the account signs in with a second factor, since when, and how many recovery codes it has left. */
  @Get()
  @Answers(SecondFactorState)
  state(@CurrentUser() user: RequestUser) {
    return this.secondFactor.state(user.id);
  }

  /** A secret to set an authenticator app up with. It counts from the first code on (`POST` here). */
  @Post('setup')
  @HttpCode(200)
  @Throttle(PASSWORD_CHECK)
  @Answers(SecondFactorSetup)
  propose(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(SecondFactorSetupRequest)) dto: SecondFactorSetupRequest,
  ) {
    return this.secondFactor.propose(user.id, dto);
  }

  /** The first code: signing in takes one from now on. Answers with the recovery codes, this once. */
  @Post()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Answers(RecoveryCodes)
  begin(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(SecondFactorConfirmRequest)) dto: SecondFactorConfirmRequest,
  ) {
    return this.secondFactor.begin(user.id, user.sessionId, dto);
  }

  /** Switch the second factor off. Asks for the password and a code. */
  @Delete()
  @HttpCode(204)
  @Throttle(PASSWORD_CHECK)
  async end(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(SecondFactorProofRequest)) dto: SecondFactorProofRequest,
  ) {
    await this.secondFactor.end(user.id, dto);
  }

  /** New recovery codes in the place of the ones the account had. Answers with them, this once. */
  @Post('recovery-codes')
  @HttpCode(200)
  @Throttle(PASSWORD_CHECK)
  @Answers(RecoveryCodes)
  newRecoveryCodes(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(SecondFactorProofRequest)) dto: SecondFactorProofRequest,
  ) {
    return this.secondFactor.newRecoveryCodes(user.id, dto);
  }
}
