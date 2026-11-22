// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Injectable, Logger } from '@nestjs/common';
import {
  WEIGHT_REMINDER_FROM_HOUR,
  WEIGHT_REMINDER_TO_HOUR,
  type WeightReminderPayload,
} from '@diet-app/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { localClock } from './local-clock.js';
import { NotificationsService } from './notifications.service.js';

/**
 * Periodic scan that emits `weight_reminder` notifications.
 *
 * Called from the worker process on a 1-hour interval (see worker.ts).
 * Cadence is per-profile: `daily` fires when the last entry is ≥1 day old;
 * `weekly` fires when ≥7 days old; `off` is skipped. To avoid pestering
 * a stale-by-one-day profile every hour we additionally debounce on
 * `Profile.lastWeightReminderAt` so the reminder fires at most once per
 * cadence window even if the user keeps not logging. Two scans that run at
 * once (two workers, or an old and a new one while the instance is updated)
 * remind a profile once between them. Where the account's clients sent its
 * time zone, a reminder is made only from `WEIGHT_REMINDER_FROM_HOUR` to
 * before `WEIGHT_REMINDER_TO_HOUR` by that clock, as water and cooking are:
 * a profile due at night is reminded in the morning.
 */
@Injectable()
export class WeightReminderService {
  private readonly logger = new Logger('WeightReminderService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /** One pass. Returns the number of reminders emitted. */
  async scan(now: Date = new Date()): Promise<number> {
    const profiles = await this.prisma.profile.findMany({
      where: { weightReminderCadence: { in: ['daily', 'weekly'] } },
      select: {
        id: true,
        weightReminderCadence: true,
        lastWeightReminderAt: true,
        user: { select: { timeZone: true } },
        weightEntries: {
          select: { recordedAt: true },
          orderBy: { recordedAt: 'desc' },
          take: 1,
        },
      },
    });

    let emitted = 0;
    for (const p of profiles) {
      const cadence = p.weightReminderCadence as 'daily' | 'weekly';
      const cadenceDays = cadence === 'daily' ? 1 : 7;
      const lastEntry = p.weightEntries[0]?.recordedAt ?? null;
      const daysSinceLastEntry = lastEntry
        ? Math.floor((now.getTime() - lastEntry.getTime()) / DAY_MS)
        : Number.POSITIVE_INFINITY;
      if (daysSinceLastEntry < cadenceDays) continue;
      if (!inDaytime(now, p.user.timeZone)) continue;

      // Debounce: once a reminder fired for this cadence window, hold off
      // for at least one cadence period regardless of whether the user
      // logs new entries.
      if (p.lastWeightReminderAt) {
        const daysSinceReminder = (now.getTime() - p.lastWeightReminderAt.getTime()) / DAY_MS;
        if (daysSinceReminder < cadenceDays) continue;
      }

      const payload: WeightReminderPayload = {
        daysSinceLastEntry: Number.isFinite(daysSinceLastEntry) ? daysSinceLastEntry : 0,
        cadence,
      };
      // One profile that fails (deleted since it was read, say) does not keep the rest from being reminded.
      try {
        if (await this.remind(p.id, payload, new Date(now.getTime() - cadenceDays * DAY_MS), now))
          emitted += 1;
      } catch (err) {
        this.logger.warn(
          `The reminder for profile ${p.id} was not made: ${(err as Error).message}`,
        );
      }
    }

    if (emitted > 0) this.logger.log(`Emitted ${emitted} weight_reminder notification(s)`);
    return emitted;
  }

  /**
   * Make the reminder of a profile, if no other scan made it since
   * `notSince`. The reminder is claimed before it is made, and both happen
   * or neither: of two scans that find the profile due, one moves the mark,
   * and the other finds it moved and makes nothing.
   */
  private remind(
    profileId: string,
    payload: WeightReminderPayload,
    notSince: Date,
    now: Date,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.profile.updateMany({
        where: {
          id: profileId,
          OR: [{ lastWeightReminderAt: null }, { lastWeightReminderAt: { lte: notSince } }],
        },
        data: { lastWeightReminderAt: now },
      });
      if (claimed.count !== 1) return false;
      await this.notifications.remindOfWeight(tx, profileId, payload, now);
      return true;
    });
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether `now` is in the hours a weight is reminded of, by the clock of `zone`; any hour for an account without one. */
function inDaytime(now: Date, zone: string | null): boolean {
  if (!zone) return true;
  try {
    const { hour } = localClock(now, zone);
    return hour >= WEIGHT_REMINDER_FROM_HOUR && hour < WEIGHT_REMINDER_TO_HOUR;
  } catch {
    // A zone this runtime does not know reminds as an account without one.
    return true;
  }
}
