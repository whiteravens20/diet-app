// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Injectable, NotFoundException } from '@nestjs/common';
import {
  MAX_WEIGHTS_LISTED,
  type WeightDay,
  type WeightEntry,
  type WeightEntryInput,
} from '@diet-app/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { dayIn, weightDays } from './weight-days.js';

/**
 * A week and a day: the six days before the day of a moment, wherever a
 * change of the clocks puts their start, and the day itself.
 */
const WEEK_BEFORE_MS = 8 * 24 * 60 * 60 * 1000;

/**
 * Per-profile weight log: the entries as they were logged, and by day as the
 * dashboard's chart draws them with the mean of each seven days. Nothing is
 * kept of the days: they are worked out from the entries at every request,
 * so a corrected entry shows at once.
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

  /**
   * The days of a profile's weights in `timeZone`, as a chart draws them
   * (`weightDays`), from the day `since` falls on there. What was logged in the
   * week before it is read as well, for the means of the first days; of a
   * thousand entries at most, the newest.
   */
  async days(
    userId: string,
    profileId: string,
    timeZone: string,
    since?: Date,
  ): Promise<WeightDay[]> {
    await this.assertProfile(userId, profileId);
    const rows = await this.prisma.weightEntry.findMany({
      where: {
        profileId,
        ...(since ? { recordedAt: { gte: new Date(since.getTime() - WEEK_BEFORE_MS) } } : {}),
      },
      orderBy: { recordedAt: 'desc' },
      take: MAX_WEIGHTS_LISTED,
      select: { kg: true, recordedAt: true },
    });
    const days = weightDays(rows, timeZone);
    if (!since) return days;
    const first = dayIn(timeZone)(since);
    return days.filter((day) => day.date >= first);
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
    const removed = await this.prisma.weightEntry.deleteMany({
      where: { id, profile: { userId } },
    });
    if (removed.count === 0)
      throw new NotFoundException({
        error: 'WEIGHT_ENTRY_NOT_FOUND',
        message: 'Weight entry not found.',
      });
  }

  private async assertProfile(userId: string, profileId: string): Promise<void> {
    const profile = await this.prisma.profile.findUnique({
      where: { id: profileId },
      select: { userId: true },
    });
    if (!profile || profile.userId !== userId)
      throw new NotFoundException({ error: 'PROFILE_NOT_FOUND', message: 'Profile not found.' });
  }

  private toDto(row: {
    id: string;
    profileId: string;
    kg: number;
    recordedAt: Date;
    createdAt: Date;
  }): WeightEntry {
    return {
      id: row.id,
      profileId: row.profileId,
      kg: row.kg,
      recordedAt: row.recordedAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    };
  }
}
