// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { Notification, Profile } from '@diet-app/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDatabase } from '../testing/database.js';
import { aProfile, aUser, as, type TestUser } from '../testing/factories.js';
import { createTestApp, type TestApp } from '../testing/test-app.js';
import { NotificationsService } from './notifications.service.js';
import { WeightReminderService } from './weight-reminder.service.js';

const DAY = 86_400_000;

describe('reminders to log a weight', () => {
  let t: TestApp;
  let reminders: WeightReminderService;
  let notifications: NotificationsService;
  let user: TestUser;
  let profile: Profile;

  beforeAll(async () => {
    t = await createTestApp();
    reminders = t.app.get(WeightReminderService);
    notifications = t.app.get(NotificationsService);
  });

  afterAll(async () => {
    await t.close();
  });

  beforeEach(async () => {
    await resetDatabase(t.prisma);
    user = await aUser(t);
    profile = await aProfile(t, user, { weightReminderCadence: 'daily' });
  });

  const unread = async (): Promise<Notification[]> => (await t.http().get('/api/notifications/unread').set(as(user)).expect(200)).body;
  const rows = () => t.prisma.notification.findMany({ where: { profileId: profile.id }, orderBy: { createdAt: 'asc' } });

  it('are made once when two scans find the same profile due at the same moment', async () => {
    const made = await Promise.all([reminders.scan(), reminders.scan(), reminders.scan()]);

    expect(made.reduce((sum, n) => sum + n, 0)).toBe(1);
    expect(await rows()).toHaveLength(1);
  });

  it('do not pile up while they are not read: the one there is, is brought up to date', async () => {
    const now = Date.now();
    await reminders.scan(new Date(now - 3 * DAY));
    const [first] = await rows();

    await reminders.scan(new Date(now - 2 * DAY));
    await reminders.scan(new Date(now - DAY));

    const [only, ...more] = await rows();
    expect(more).toEqual([]);
    expect(only!.id).toBe(first!.id);
    expect(only!.createdAt.getTime()).toBe(now - DAY);
    expect(await unread()).toHaveLength(1);
  });

  it('are made anew once the one before was read', async () => {
    const now = Date.now();
    await reminders.scan(new Date(now - 2 * DAY));
    const [first] = await unread();
    await t.http().post(`/api/notifications/${first!.id}/read`).set(as(user)).expect(204);

    await reminders.scan(new Date(now - DAY));

    expect(await rows()).toHaveLength(2);
    expect((await unread()).map((notification) => notification.id)).not.toContain(first!.id);
  });

  it('are made for the other profiles when one of them fails', async () => {
    const others = await Promise.all([aUser(t), aUser(t)]);
    const theirs = await Promise.all(others.map((other) => aProfile(t, other, { weightReminderCadence: 'weekly' })));
    const real = notifications.remindOfWeight.bind(notifications);
    const failing = vi.spyOn(notifications, 'remindOfWeight').mockImplementation((tx, profileId, ...rest) =>
      profileId === theirs[0]!.id ? Promise.reject(new Error('gone')) : real(tx, profileId, ...rest),
    );

    const made = await reminders.scan();
    failing.mockRestore();

    expect(made).toBe(2);
    expect(await t.prisma.notification.count({ where: { profileId: theirs[1]!.id } })).toBe(1);
    // The profile that failed was not marked as reminded: the next scan tries it again.
    expect((await t.prisma.profile.findUniqueOrThrow({ where: { id: theirs[0]!.id } })).lastWeightReminderAt).toBeNull();
    expect(await reminders.scan()).toBe(1);
  });

  it('and other notifications are removed when nobody will look at them again', async () => {
    const now = Date.now();
    const at = (daysAgo: number): Date => new Date(now - daysAgo * DAY);
    const make = (createdAt: Date, readAt: Date | null) => t.prisma.notification.create({ data: { profileId: profile.id, type: 'weight_reminder', payload: {}, createdAt, readAt } });
    const readLongAgo = await make(at(100), at(61));
    const readLately = await make(at(100), at(59));
    const neverRead = await make(at(366), null);
    const waiting = await make(at(300), null);

    expect(await notifications.prune()).toBe(2);

    const left = (await rows()).map((row) => row.id);
    expect(left).toEqual(expect.arrayContaining([readLately.id, waiting.id]));
    expect(left).not.toContain(readLongAgo.id);
    expect(left).not.toContain(neverRead.id);
  });
});
