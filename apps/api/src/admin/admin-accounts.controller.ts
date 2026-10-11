// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Body, Controller, Delete, HttpCode, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AccountSecondFactorRemoval } from '@diet-app/shared';
import { AccountSecondFactor } from '../auth/account-second-factor.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { AdminSessionGuard } from './admin-session.guard.js';

/** What the operator does for the holder of an account who can no longer do it. */
@Controller('admin/accounts')
@UseGuards(AdminSessionGuard)
export class AdminAccountsController {
  constructor(private readonly secondFactor: AccountSecondFactor) {}

  /**
   * Take the second factor off the account of an address: for a holder who
   * lost the authenticator app and the recovery codes. The account signs in
   * with its password alone afterwards, and is told so by mail. Whether the
   * one who asks is the holder is for the operator to make sure of.
   */
  @Delete('second-factor')
  @HttpCode(204)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async removeSecondFactor(@Body(new ZodValidationPipe(AccountSecondFactorRemoval)) body: AccountSecondFactorRemoval): Promise<void> {
    await this.secondFactor.removeFor(body.email);
  }
}
