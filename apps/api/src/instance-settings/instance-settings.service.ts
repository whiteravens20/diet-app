// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Singleton runtime configuration owned by the operator and managed from
 * /admin. Currently surfaces the reviewer-interface toggle +
 * password. Mirrors the ADMIN_PASSWORD pattern but stored in DB so the
 * operator can flip it from the panel without restarting the API.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { Passwords } from '../common/passwords.js';
import { PrismaService } from '../prisma/prisma.service.js';

const SINGLETON_ID = 'singleton';

export interface InstanceSettingsState {
  reviewerEnabled: boolean;
  reviewerPasswordSet: boolean;
  updatedAt: string;
}

export interface InstanceSettingsPatch {
  reviewerEnabled?: boolean;
  /**
   * Empty string clears the existing hash (and disables review by side
   * effect — the guard refuses to admit sessions when the hash is null).
   * `undefined` means "do not touch".
   */
  reviewerPassword?: string;
}

@Injectable()
export class InstanceSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: Passwords,
  ) {}

  /** Returns the current settings; creates the singleton row lazily. */
  async get(): Promise<InstanceSettingsState> {
    const row = await this.prisma.instanceSettings.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID },
      update: {},
    });
    return {
      reviewerEnabled: row.reviewerEnabled,
      reviewerPasswordSet: row.reviewerPasswordHash !== null,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * Returns the bcrypt hash directly. Used only by `ReviewerSessionGuard`
   * and the auth controller — never exposed over the wire.
   */
  async readReviewerCredentials(): Promise<{
    reviewerEnabled: boolean;
    reviewerPasswordHash: string | null;
    /** The epoch a reviewer's session has to be of to count. */
    reviewerSessionEpoch: number;
  }> {
    const row = await this.prisma.instanceSettings.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID },
      update: {},
    });
    return {
      reviewerEnabled: row.reviewerEnabled,
      reviewerPasswordHash: row.reviewerPasswordHash,
      reviewerSessionEpoch: row.reviewerSessionEpoch,
    };
  }

  /**
   * Change the reviewer settings. A changed or cleared password, and closing
   * the panel, end every reviewer session there is: the epoch moves on, and
   * a session of an earlier one is none. Opening the panel again brings
   * nothing back.
   */
  async patch(patch: InstanceSettingsPatch): Promise<InstanceSettingsState> {
    const before = await this.readReviewerCredentials();
    const data: Prisma.InstanceSettingsUpdateInput = {};
    let endsSessions = false;

    if (patch.reviewerEnabled !== undefined) {
      data.reviewerEnabled = patch.reviewerEnabled;
      endsSessions ||= before.reviewerEnabled && !patch.reviewerEnabled;
    }
    if (patch.reviewerPassword !== undefined) {
      data.reviewerPasswordHash =
        patch.reviewerPassword === '' ? null : await this.passwords.hash(patch.reviewerPassword);
      endsSessions = true;
    }
    if (endsSessions) data.reviewerSessionEpoch = { increment: 1 };

    const row = await this.prisma.instanceSettings.update({ where: { id: SINGLETON_ID }, data });
    return {
      reviewerEnabled: row.reviewerEnabled,
      reviewerPasswordSet: row.reviewerPasswordHash !== null,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
