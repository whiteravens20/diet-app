/**
 * Singleton runtime configuration owned by the operator and managed from
 * /admin. Currently surfaces the Phase H reviewer-interface toggle +
 * password. Mirrors the ADMIN_PASSWORD pattern but stored in DB so the
 * operator can flip it from the panel without restarting the API.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import type { Env } from '../config/env.js';
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
    private readonly config: ConfigService<Env, true>,
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
  }> {
    const row = await this.prisma.instanceSettings.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID },
      update: {},
    });
    return {
      reviewerEnabled: row.reviewerEnabled,
      reviewerPasswordHash: row.reviewerPasswordHash,
    };
  }

  async patch(patch: InstanceSettingsPatch): Promise<InstanceSettingsState> {
    const data: {
      reviewerEnabled?: boolean;
      reviewerPasswordHash?: string | null;
    } = {};

    if (patch.reviewerEnabled !== undefined) {
      data.reviewerEnabled = patch.reviewerEnabled;
    }
    if (patch.reviewerPassword !== undefined) {
      if (patch.reviewerPassword === '') {
        data.reviewerPasswordHash = null;
      } else {
        const rounds = this.config.get('PASSWORD_HASH_ROUNDS', { infer: true });
        data.reviewerPasswordHash = await bcrypt.hash(patch.reviewerPassword, rounds);
      }
    }

    const row = await this.prisma.instanceSettings.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, ...data },
      update: data,
    });
    return {
      reviewerEnabled: row.reviewerEnabled,
      reviewerPasswordSet: row.reviewerPasswordHash !== null,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
