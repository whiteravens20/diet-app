// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  dayAfter,
  DIARY_DAYS_BACK,
  MAX_WATER_ENTRIES_A_DAY,
  type AddWaterRequest,
  type WaterDay,
} from '@diet-app/shared';
import { holdProfile } from '../common/hold.js';
import { writeOnce } from '../common/idempotency.js';
import { isoDate } from '../meal-plans/plan-days.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** What reads a profile's water: the service's client or a transaction of it. */
type Reader = PrismaService | Prisma.TransactionClient;

/**
 * The water a profile drinks, a day of its own calendar at a time: amounts
 * pressed or typed, and an entry written by mistake removed. A day is the sum
 * of its entries, against the profile's target.
 */
@Injectable()
export class WaterService {
  constructor(private readonly prisma: PrismaService) {}

  /** The water of a day of one of the user's profiles. */
  async day(userId: string, profileId: string, day: string): Promise<WaterDay> {
    await this.assertProfile(userId, profileId);
    return this.dayOf(this.prisma, profileId, day);
  }

  /**
   * Water drunk on a day of today or at most a year before it (`today` is the
   * client's day), answered with the day as it is then. A day holds at most
   * `MAX_WATER_ENTRIES_A_DAY` entries. Sent again with the same
   * `Idempotency-Key` within a week, it writes nothing and is answered with
   * the day as it is now.
   */
  add(
    userId: string,
    request: AddWaterRequest,
    key: string | null,
    today: string | null,
  ): Promise<WaterDay> {
    const { profileId, day, ml } = request;
    return writeOnce(this.prisma, {
      userId,
      key,
      route: 'POST /water',
      request,
      write: async (keep) => {
        await this.assertProfile(userId, profileId);
        this.refuseDayOutside(day, today);
        return this.prisma.$transaction(async (tx) => {
          await holdProfile(tx, profileId);
          const held = await tx.waterEntry.count({ where: { profileId, day: new Date(day) } });
          if (held >= MAX_WATER_ENTRIES_A_DAY) {
            throw new ConflictException({
              error: 'WATER_DAY_FULL',
              message: `A day holds at most ${MAX_WATER_ENTRIES_A_DAY} entries of water.`,
            });
          }
          const noted = await tx.waterEntry.create({
            data: { profileId, day: new Date(day), ml },
          });
          await keep(tx, noted.id);
          return this.dayOf(tx, profileId, day);
        });
      },
      replay: async (entryId) => {
        const entry = await this.prisma.waterEntry.findUnique({
          where: { id: entryId },
          select: { profileId: true, day: true },
        });
        // The entry is gone with its profile: the day is read as it is, which is nothing.
        return this.dayOf(
          this.prisma,
          entry?.profileId ?? profileId,
          entry ? isoDate(entry.day) : day,
        );
      },
    });
  }

  /**
   * Remove an entry of one of the user's profiles, answered with its day as it
   * is then. An entry of somebody else's profile is answered as one that is
   * not there.
   */
  async remove(userId: string, id: string): Promise<WaterDay> {
    const entry = await this.prisma.waterEntry.findFirst({
      where: { id, profile: { userId } },
      select: { profileId: true, day: true },
    });
    if (!entry) {
      throw new NotFoundException({
        error: 'WATER_ENTRY_NOT_FOUND',
        message: 'Water entry not found.',
      });
    }
    // Removed by another request in the meantime, it is gone all the same.
    await this.prisma.waterEntry.deleteMany({ where: { id } });
    return this.dayOf(this.prisma, entry.profileId, isoDate(entry.day));
  }

  /** What a day of a profile holds against its target, and its last entry. */
  private async dayOf(reader: Reader, profileId: string, day: string): Promise<WaterDay> {
    const [held, last, profile] = await Promise.all([
      reader.waterEntry.aggregate({
        where: { profileId, day: new Date(day) },
        _sum: { ml: true },
        _count: true,
      }),
      reader.waterEntry.findFirst({
        where: { profileId, day: new Date(day) },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true, ml: true, createdAt: true },
      }),
      reader.profile.findUnique({ where: { id: profileId }, select: { waterTargetMl: true } }),
    ]);
    return {
      day,
      ml: held._sum.ml ?? 0,
      target: profile?.waterTargetMl ?? null,
      entries: held._count,
      last: last ? { id: last.id, ml: last.ml, at: last.createdAt.toISOString() } : null,
    };
  }

  /** A day of water is one of today and the year before it, as the diary's is. */
  private refuseDayOutside(day: string, today: string | null): void {
    const now = today ?? isoDate(new Date());
    // Dates in this form compare as text.
    if (day > now) {
      throw new ConflictException({
        error: 'DIARY_DAY_AHEAD',
        message: 'The diary takes today and the year before it, not a day still to come.',
      });
    }
    if (day < dayAfter(now, -DIARY_DAYS_BACK)) {
      throw new ConflictException({
        error: 'DIARY_DAY_TOO_OLD',
        message: 'The diary takes a new entry at most a year back.',
      });
    }
  }

  private async assertProfile(userId: string, profileId: string): Promise<void> {
    const owned = await this.prisma.profile.count({ where: { id: profileId, userId } });
    if (owned === 0) {
      throw new NotFoundException({ error: 'PROFILE_NOT_FOUND', message: 'Profile not found.' });
    }
  }
}
