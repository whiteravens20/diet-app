// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  MAX_WEIGHTS_A_DAY,
  MAX_WEIGHTS_LISTED,
  WEIGHT_DAYS_BACK,
  type WeightDay,
  type WeightEntry,
  type WeightEntryInput,
} from '@diet-app/shared';
import { holdProfile } from '../common/hold.js';
import { writeOnce } from '../common/idempotency.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { dayIn, weightDays } from './weight-days.js';

/**
 * A week and a day: the six days before the day of a moment, wherever a
 * change of the clocks puts their start, and the day itself.
 */
const WEEK_BEFORE_MS = 8 * 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Per-profile weight log: the entries as they were logged, and by day as the
 * dashboard's chart draws them with the mean of each seven days. Nothing is
 * kept of the days: they are worked out from the entries at every request,
 * so a corrected entry shows at once. The newest entry is the profile's
 * weight, which its calorie target is worked out from: a loss is planned on
 * the body as it is now, not as it was when the profile was made.
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

  /**
   * Note a weight, taken at most `WEIGHT_DAYS_BACK` days before now. The day in
   * UTC it was taken on holds at most `MAX_WEIGHTS_A_DAY`, counted while the
   * profile is held. Sent again with its key, the request is answered with the
   * entry the first one noted, and notes nothing.
   */
  create(
    userId: string,
    profileId: string,
    input: WeightEntryInput,
    key: string | null = null,
  ): Promise<WeightEntry> {
    return writeOnce(this.prisma, {
      userId,
      key,
      route: 'POST /weights',
      request: { profileId, ...input },
      write: async (keep) => {
        await this.assertProfile(userId, profileId);
        const recordedAt = input.recordedAt ? new Date(input.recordedAt) : new Date();
        if (recordedAt.getTime() < Date.now() - WEIGHT_DAYS_BACK * DAY_MS) {
          throw new ConflictException({
            error: 'WEIGHT_TOO_OLD',
            message: 'The weight log takes new entries at most a year back.',
          });
        }
        const row = await this.prisma.$transaction(async (tx) => {
          await holdProfile(tx, profileId);
          const day = Date.UTC(
            recordedAt.getUTCFullYear(),
            recordedAt.getUTCMonth(),
            recordedAt.getUTCDate(),
          );
          const held = await tx.weightEntry.count({
            where: { profileId, recordedAt: { gte: new Date(day), lt: new Date(day + DAY_MS) } },
          });
          if (held >= MAX_WEIGHTS_A_DAY) {
            throw new ConflictException({
              error: 'WEIGHT_DAY_FULL',
              message:
                'The weight log holds no more entries for this day: remove the last entry to log another.',
            });
          }
          const noted = await tx.weightEntry.create({
            data: { profileId, kg: input.kg, recordedAt },
          });
          // The newest weight is the profile's; one logged for an earlier day changes nothing of it.
          const newer = await tx.weightEntry.count({
            where: { profileId, recordedAt: { gt: recordedAt } },
          });
          if (newer === 0)
            await tx.profile.update({ where: { id: profileId }, data: { weightKg: input.kg } });
          await keep(tx, noted.id);
          return noted;
        });
        return this.toDto(row);
      },
      replay: (id) => this.entry(userId, id),
    });
  }

  /**
   * Remove an entry. Removing the newest gives the profile the weight of the
   * one before it, where there is one; with none left the profile keeps the
   * weight it has.
   */
  async remove(userId: string, id: string): Promise<void> {
    const notFound = () =>
      new NotFoundException({
        error: 'WEIGHT_ENTRY_NOT_FOUND',
        message: 'Weight entry not found.',
      });
    await this.prisma.$transaction(async (tx) => {
      // An entry of somebody else's profile is answered as one that is not there.
      const entry = await tx.weightEntry.findFirst({
        where: { id, profile: { userId } },
        select: { profileId: true, recordedAt: true },
      });
      if (!entry) throw notFound();
      await holdProfile(tx, entry.profileId);
      const removed = await tx.weightEntry.deleteMany({ where: { id, profile: { userId } } });
      if (removed.count === 0) throw notFound();
      const newest = await tx.weightEntry.findFirst({
        where: { profileId: entry.profileId },
        orderBy: { recordedAt: 'desc' },
        select: { kg: true, recordedAt: true },
      });
      if (newest && newest.recordedAt <= entry.recordedAt)
        await tx.profile.update({ where: { id: entry.profileId }, data: { weightKg: newest.kg } });
    });
  }

  /** A noted weight of one of the user's profiles, as it is now. */
  private async entry(userId: string, id: string): Promise<WeightEntry> {
    const row = await this.prisma.weightEntry.findFirst({ where: { id, profile: { userId } } });
    if (!row)
      throw new NotFoundException({
        error: 'WEIGHT_ENTRY_NOT_FOUND',
        message: 'Weight entry not found.',
      });
    return this.toDto(row);
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
