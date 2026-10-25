// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Body, Controller, Delete, Get, HttpCode, Put, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AccountSecondFactorRemoval, AdminOperatorAi, OperatorAiApproval } from '@diet-app/shared';
import { AccountSecondFactor } from '../auth/account-second-factor.service.js';
import { Answers } from '../common/answers.decorator.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { AdminSessionGuard } from './admin-session.guard.js';
import { OperatorAiApprovals } from './operator-ai-approvals.service.js';

/** What the operator does about an account: for its holder when they can no longer do it, and whether it may use the operator's AI provider. */
@Controller('admin/accounts')
@UseGuards(AdminSessionGuard)
export class AdminAccountsController {
  constructor(
    private readonly secondFactor: AccountSecondFactor,
    private readonly approvals: OperatorAiApprovals,
  ) {}

  /**
   * Take the second factor off the account of an address: for a holder who
   * lost the authenticator app and the recovery codes. The account signs in
   * with its password alone afterwards, and is told so by mail. Whether the
   * one who asks is the holder is for the operator to make sure of.
   */
  @Delete('second-factor')
  @HttpCode(204)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async removeSecondFactor(
    @Body(new ZodValidationPipe(AccountSecondFactorRemoval)) body: AccountSecondFactorRemoval,
  ): Promise<void> {
    await this.secondFactor.removeFor(body.email);
  }

  /** Who may use the operator's AI provider (`AI_ADMIN_ACCESS`), and how many accounts are approved for it. */
  @Get('operator-ai')
  @Answers(AdminOperatorAi)
  operatorAi(): Promise<AdminOperatorAi> {
    return this.approvals.overview();
  }

  /**
   * Approve the account of an address for the operator's AI provider. It
   * counts while `AI_ADMIN_ACCESS` is `approved`. Approving it again changes
   * nothing; an address without an account is 404.
   */
  @Put('operator-ai')
  @HttpCode(204)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async approve(
    @Body(new ZodValidationPipe(OperatorAiApproval)) body: OperatorAiApproval,
  ): Promise<void> {
    await this.approvals.approve(body.email);
  }

  /** Take the approval of the account of an address back. An address without an account is 404. */
  @Delete('operator-ai')
  @HttpCode(204)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async revoke(
    @Body(new ZodValidationPipe(OperatorAiApproval)) body: OperatorAiApproval,
  ): Promise<void> {
    await this.approvals.revoke(body.email);
  }
}
