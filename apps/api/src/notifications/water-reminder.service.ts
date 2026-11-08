// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Injectable, Logger } from '@nestjs/common';
import {
  WATER_PACE_FROM_HOUR,
  WATER_PACE_TO_HOUR,
  WATER_REMINDER_BEHIND_ML,
  WATER_REMINDER_EVERY_HOURS,
  WATER_REMINDER_FROM_HOUR,
  WATER_REMINDER_TO_HOUR,
  type WaterReminderPayload,
} from '@diet-app/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { localClock } from './local-clock.js';
import { NotificationsService } from './notifications.service.js';

const HOUR_MS = 60 * 60 * 1000;

/**
 * The scan that reminds a profile to drink (`water_reminder`), run by the
 * worker every hour. A profile that switched the reminders on, names a target
 * and whose account's clients sent their time zone is reminded between
 * `WATER_REMINDER_FROM_HOUR` and `WATER_REMINDER_TO_HOUR` by that clock, while
 * its day holds more than `WATER_REMINDER_BEHIND_ML` less than an even pace to
 * the target from `WATER_PACE_FROM_HOUR` to `WATER_PACE_TO_HOUR`, and at most
 * every `WATER_REMINDER_EVERY_HOURS` hours; never once the target is reached.
 * Two scans at once remind it once between them.
 */
@Injectable()
export class WaterReminderService {
  private readonly logger = new Logger('WaterReminderService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /** One pass. Returns the number of reminders made. */
  async scan(now: Date = new Date()): Promise<number> {
    const profiles = await this.prisma.profile.findMany({
      where: {
        waterReminders: true,
        waterTracking: true,
        waterTargetMl: { not: null },
        user: { timeZone: { not: null } },
      },
      select: {
        id: true,
        waterTargetMl: true,
        lastWaterReminderAt: true,
        user: { select: { timeZone: true } },
      },
    });
    const notSince = new Date(now.getTime() - WATER_REMINDER_EVERY_HOURS * HOUR_MS);
    let made = 0;
    for (const profile of profiles) {
      if (profile.lastWaterReminderAt && profile.lastWaterReminderAt > notSince) continue;
      try {
        const clock = localClock(now, profile.user.timeZone!);
        if (clock.hour < WATER_REMINDER_FROM_HOUR || clock.hour >= WATER_REMINDER_TO_HOUR) continue;
        const target = profile.waterTargetMl!;
        const held = await this.prisma.waterEntry.aggregate({
          where: { profileId: profile.id, day: new Date(clock.day) },
          _sum: { ml: true },
        });
        const ml = held._sum.ml ?? 0;
        if (ml >= target) continue;
        const share = Math.min(
          1,
          Math.max(
            0,
            (clock.hour + clock.minute / 60 - WATER_PACE_FROM_HOUR) /
              (WATER_PACE_TO_HOUR - WATER_PACE_FROM_HOUR),
          ),
        );
        if (ml >= target * share - WATER_REMINDER_BEHIND_ML) continue;
        if (await this.remind(profile.id, { day: clock.day, ml, target }, notSince, now)) made += 1;
      } catch (err) {
        // One profile that fails (deleted since it was read, a zone this runtime no longer knows) does not keep the rest.
        this.logger.warn(
          `The water reminder of profile ${profile.id} was not made: ${(err as Error).message}`,
        );
      }
    }
    if (made > 0) this.logger.log(`Made ${made} water_reminder notification(s)`);
    return made;
  }

  /** Make the reminder, if no other scan made one since `notSince`: claimed and made together, or neither. */
  private remind(
    profileId: string,
    payload: WaterReminderPayload,
    notSince: Date,
    now: Date,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.profile.updateMany({
        where: {
          id: profileId,
          OR: [{ lastWaterReminderAt: null }, { lastWaterReminderAt: { lte: notSince } }],
        },
        data: { lastWaterReminderAt: now },
      });
      if (claimed.count !== 1) return false;
      await this.notifications.remindOfWater(tx, profileId, payload, now);
      return true;
    });
  }
}
