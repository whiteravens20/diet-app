import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  type Notification,
  NotificationType,
  type WeightReminderPayload,
} from '@diet-app/shared';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * F19 — device-agnostic notification surface. HTTP side (this service) is
 * read-mostly: the client polls `unread`, then marks rows read. Writes
 * come from the worker (weight-reminder cron) via `createWeightReminder()`.
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Unread rows across every profile the user owns. We don't filter by
   * profile here — the bell-icon counter in the app shell is account-wide;
   * per-profile filtering happens client-side once a profile is selected.
   */
  async listUnread(userId: string): Promise<Notification[]> {
    const rows = await this.prisma.notification.findMany({
      where: { readAt: null, profile: { userId } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.map((r) => this.toDto(r));
  }

  async markRead(userId: string, id: string): Promise<Notification> {
    const row = await this.prisma.notification.findUnique({
      where: { id },
      include: { profile: { select: { userId: true } } },
    });
    if (!row) throw new NotFoundException({ error: 'NOTIFICATION_NOT_FOUND', message: 'Notification not found.' });
    if (row.profile.userId !== userId) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Notification belongs to another user.' });
    }
    const updated = row.readAt
      ? row
      : await this.prisma.notification.update({ where: { id }, data: { readAt: new Date() } });
    return this.toDto(updated);
  }

  async markAllRead(userId: string): Promise<{ updated: number }> {
    const res = await this.prisma.notification.updateMany({
      where: { readAt: null, profile: { userId } },
      data: { readAt: new Date() },
    });
    return { updated: res.count };
  }

  /**
   * Called from the worker's weight-reminder cron. Idempotent at the
   * cron-tick boundary: the caller already guards on `Profile.lastWeightReminderAt`
   * so this just writes the row.
   */
  async createWeightReminder(profileId: string, payload: WeightReminderPayload): Promise<Notification> {
    const row = await this.prisma.notification.create({
      data: {
        profileId,
        type: NotificationType.enum.weight_reminder,
        payload,
      },
    });
    return this.toDto(row);
  }

  private toDto(row: {
    id: string;
    profileId: string;
    type: string;
    payload: unknown;
    readAt: Date | null;
    createdAt: Date;
  }): Notification {
    return {
      id: row.id,
      profileId: row.profileId,
      type: NotificationType.parse(row.type),
      payload: row.payload ?? null,
      readAt: row.readAt ? row.readAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
