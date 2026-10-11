// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Injectable, NotFoundException } from '@nestjs/common';
import { MAX_WEIGHTS_LISTED, type WeightEntry, type WeightEntryInput } from '@diet-app/shared';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Per-profile weight log. The dashboard chart, 7-day moving average
 * and delta against the weight the profile registered (`Profile.weightKg`,
 * which the calorie calculation takes as the current body weight) are all
 * derived client-side from the rows this service returns, so a corrected
 * entry shows up immediately without a server round-trip beyond the
 * create/delete itself.
 */
@Injectable()
export class WeightsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * List entries for a profile newest-first, a thousand at most. `since`
   * lets the dashboard cap to the 90-day window without pulling years of
   * history.
   */
  async list(userId: string, profileId: string, since?: Date): Promise<WeightEntry[]> {
    await this.assertProfile(userId, profileId);
    const rows = await this.prisma.weightEntry.findMany({
      where: { profileId, ...(since ? { recordedAt: { gte: since } } : {}) },
      orderBy: { recordedAt: 'desc' },
      take: MAX_WEIGHTS_LISTED,
    });
    return rows.map((r) => this.toDto(r));
  }

  async create(userId: string, profileId: string, input: WeightEntryInput): Promise<WeightEntry> {
    await this.assertProfile(userId, profileId);
    const row = await this.prisma.weightEntry.create({
      data: {
        profileId,
        kg: input.kg,
        recordedAt: input.recordedAt ? new Date(input.recordedAt) : new Date(),
      },
    });
    return this.toDto(row);
  }

  async remove(userId: string, id: string): Promise<void> {
    // An entry of somebody else's profile is answered as one that is not there.
    const removed = await this.prisma.weightEntry.deleteMany({ where: { id, profile: { userId } } });
    if (removed.count === 0) throw new NotFoundException({ error: 'WEIGHT_ENTRY_NOT_FOUND', message: 'Weight entry not found.' });
  }

  private async assertProfile(userId: string, profileId: string): Promise<void> {
    const profile = await this.prisma.profile.findUnique({ where: { id: profileId }, select: { userId: true } });
    if (!profile || profile.userId !== userId) throw new NotFoundException({ error: 'PROFILE_NOT_FOUND', message: 'Profile not found.' });
  }

  private toDto(row: { id: string; profileId: string; kg: number; recordedAt: Date; createdAt: Date }): WeightEntry {
    return {
      id: row.id,
      profileId: row.profileId,
      kg: row.kg,
      recordedAt: row.recordedAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    };
  }
}
