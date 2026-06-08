import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { WeightEntry, WeightEntryInput } from '@diet-app/shared';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * F19 — per-profile weight log. The dashboard chart, 7-day moving average
 * and delta against the profile's target weight are all derived client-side
 * from the rows this service returns, so a corrected entry shows up
 * immediately without a server round-trip beyond the create/delete itself.
 */
@Injectable()
export class WeightsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * List entries for a profile newest-first. `since` lets the dashboard
   * cap to the 90-day window without pulling years of history; the worker
   * cron uses the `latest()` helper instead.
   */
  async list(userId: string, profileId: string, since?: Date): Promise<WeightEntry[]> {
    await this.assertProfile(userId, profileId);
    const rows = await this.prisma.weightEntry.findMany({
      where: { profileId, ...(since ? { recordedAt: { gte: since } } : {}) },
      orderBy: { recordedAt: 'desc' },
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
    const row = await this.prisma.weightEntry.findUnique({ where: { id } });
    if (!row) throw new NotFoundException({ error: 'WEIGHT_ENTRY_NOT_FOUND', message: 'Weight entry not found.' });
    await this.assertProfile(userId, row.profileId);
    await this.prisma.weightEntry.delete({ where: { id } });
  }

  private async assertProfile(userId: string, profileId: string): Promise<void> {
    const profile = await this.prisma.profile.findUnique({ where: { id: profileId }, select: { userId: true } });
    if (!profile) throw new NotFoundException({ error: 'PROFILE_NOT_FOUND', message: 'Profile not found.' });
    if (profile.userId !== userId) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Profile belongs to another user.' });
    }
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
