// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { Injectable, NotFoundException } from '@nestjs/common';
import {
  MAX_UNREAD_LISTED,
  type Notification,
  NotificationType,
  type WeightReminderPayload,
} from '@diet-app/shared';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';

/** How long a notification is kept after it was read, and how long one that never was. */
const READ_KEPT_DAYS = 60;
const UNREAD_KEPT_DAYS = 365;

/**
 * Device-agnostic notification surface. HTTP side (this service) is
 * read-mostly: the client polls `unread`, then marks rows read. Writes
 * come from the worker (the weight-reminder scan) via `remindOfWeight()`.
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Unread rows across every profile the user owns, the newest first and
   * fifty at most. We don't filter by profile here — the bell-icon counter in
   * the app shell is account-wide; per-profile filtering happens client-side
   * once a profile is selected.
   */
  async listUnread(userId: string): Promise<Notification[]> {
    const rows = await this.prisma.notification.findMany({
      where: { readAt: null, profile: { userId } },
      orderBy: { createdAt: 'desc' },
      take: MAX_UNREAD_LISTED,
    });
    return rows.map((r) => this.toDto(r));
  }

  async markRead(userId: string, id: string): Promise<void> {
    const row = await this.prisma.notification.findUnique({
      where: { id },
      include: { profile: { select: { userId: true } } },
    });
    if (!row?.profile || row.profile.userId !== userId)
      throw new NotFoundException({
        error: 'NOTIFICATION_NOT_FOUND',
        message: 'Notification not found.',
      });
    // Read already, or read by another request meanwhile: it is read either way.
    await this.prisma.notification.updateMany({
      where: { id, readAt: null },
      data: { readAt: new Date() },
    });
  }

  async markAllRead(userId: string): Promise<{ updated: number }> {
    const res = await this.prisma.notification.updateMany({
      where: { readAt: null, profile: { userId } },
      data: { readAt: new Date() },
    });
    return { updated: res.count };
  }

  /**
   * Remind a profile to log its weight, inside the transaction that claimed
   * the reminder. A profile has one unread reminder at most: while the one
   * before is unread, it is brought up to date and moved to the top, and no
   * second one is put under it.
   */
  async remindOfWeight(
    tx: Prisma.TransactionClient,
    profileId: string,
    payload: WeightReminderPayload,
    now: Date,
  ): Promise<void> {
    const type = NotificationType.enum.weight_reminder;
    const unread = await tx.notification.findFirst({
      where: { profileId, type, readAt: null },
      select: { id: true },
    });
    if (unread)
      await tx.notification.update({ where: { id: unread.id }, data: { payload, createdAt: now } });
    else await tx.notification.create({ data: { profileId, type, payload, createdAt: now } });
  }

  /**
   * Remove the notifications nobody will look at again: read more than sixty
   * days ago, or unread for a year. Returns how many were removed.
   */
  async prune(now: Date = new Date()): Promise<number> {
    const day = 86_400_000;
    const removed = await this.prisma.notification.deleteMany({
      where: {
        OR: [
          { readAt: { lt: new Date(now.getTime() - READ_KEPT_DAYS * day) } },
          { readAt: null, createdAt: { lt: new Date(now.getTime() - UNREAD_KEPT_DAYS * day) } },
        ],
      },
    });
    return removed.count;
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
