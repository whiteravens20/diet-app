import { Injectable, Logger } from '@nestjs/common';
import type { WeightReminderPayload } from '@diet-app/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { NotificationsService } from './notifications.service.js';

/**
 * F19 — periodic scan that emits `weight_reminder` notifications.
 *
 * Called from the worker process on a 1-hour interval (see worker.ts).
 * Cadence is per-profile: `daily` fires when the last entry is ≥1 day old;
 * `weekly` fires when ≥7 days old; `off` is skipped. To avoid pestering
 * a stale-by-one-day profile every hour we additionally debounce on
 * `Profile.lastWeightReminderAt` so the reminder fires at most once per
 * cadence window even if the user keeps not logging.
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
      await this.notifications.createWeightReminder(p.id, payload);
      await this.prisma.profile.update({
        where: { id: p.id },
        data: { lastWeightReminderAt: now },
      });
      emitted += 1;
    }

    if (emitted > 0) this.logger.log(`Emitted ${emitted} weight_reminder notification(s)`);
    return emitted;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
