// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AdminOperatorAi } from '@diet-app/shared';
import { AccountEmail } from '../auth/account-email.js';
import type { Env } from '../config/env.js';
import { MailService } from '../mail/mail.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * The accounts the operator lets use its AI provider, for an instance set up
 * that way (`AI_ADMIN_ACCESS=approved`). The operator names an account by its
 * address, as with every matter of an account in the panel: the panel holds no
 * list of accounts.
 */
@Injectable()
export class OperatorAiApprovals {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly emails: AccountEmail,
    private readonly mail: MailService,
  ) {}

  /** Who may use the operator's provider, and how many accounts are approved for it. */
  async overview(): Promise<AdminOperatorAi> {
    return {
      access: this.config.get('AI_ADMIN_ACCESS', { infer: true }),
      mailConfigured: this.mail.enabled,
      approved: await this.prisma.user.count({ where: { operatorAiApprovedAt: { not: null } } }),
    };
  }

  /** Approve the account of an address. Approving it again changes nothing. */
  async approve(address: string): Promise<void> {
    const id = await this.holderOf(address);
    await this.prisma.user.updateMany({
      where: { id, operatorAiApprovedAt: null },
      data: { operatorAiApprovedAt: new Date() },
    });
  }

  /**
   * Take the approval of the account of an address back. Its mode stays as it
   * is: its next request to the operator's provider is refused, and says why.
   */
  async revoke(address: string): Promise<void> {
    const id = await this.holderOf(address);
    await this.prisma.user.update({ where: { id }, data: { operatorAiApprovedAt: null } });
  }

  private async holderOf(address: string): Promise<string> {
    const holder = await this.prisma.user.findUnique({
      where: { emailIndex: this.emails.indexOf(this.emails.normalise(address)) },
      select: { id: true },
    });
    if (!holder)
      throw new NotFoundException({
        error: 'USER_NOT_FOUND',
        message: 'No account has that address.',
      });
    return holder.id;
  }
}
