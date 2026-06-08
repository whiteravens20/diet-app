/**
 * Unit tests for WeightReminderService. Pins the cadence math + the
 * lastWeightReminderAt debounce — bugs here would either pester users or
 * silently never fire.
 */
import { describe, expect, it, vi } from 'vitest';
import type { WeightReminderPayload } from '@diet-app/shared';
import { NotificationsService } from './notifications.service.js';
import { WeightReminderService } from './weight-reminder.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-06-04T12:00:00Z');
const DAYS_AGO = (n: number): Date => new Date(NOW.getTime() - n * DAY_MS);

interface FakeProfile {
  id: string;
  weightReminderCadence: 'off' | 'daily' | 'weekly';
  lastWeightReminderAt: Date | null;
  weightEntries: { recordedAt: Date }[];
}

function makePrisma(profiles: FakeProfile[]) {
  return {
    profile: {
      findMany: vi.fn().mockImplementation(({ where }: { where: { weightReminderCadence: { in: string[] } } }) =>
        Promise.resolve(profiles.filter((p) => where.weightReminderCadence.in.includes(p.weightReminderCadence))),
      ),
      update: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as ConstructorParameters<typeof WeightReminderService>[0];
}

function makeNotifications(): NotificationsService {
  return {
    createWeightReminder: vi
      .fn()
      .mockImplementation(
        (profileId: string, payload: WeightReminderPayload) =>
          Promise.resolve({ id: 'n', profileId, type: 'weight_reminder', payload, readAt: null, createdAt: '' }),
      ),
  } as unknown as NotificationsService;
}

describe('WeightReminderService.scan', () => {
  it('skips profiles with cadence=off (excluded by the query)', async () => {
    const prisma = makePrisma([
      { id: 'p-off', weightReminderCadence: 'off', lastWeightReminderAt: null, weightEntries: [] },
    ]);
    const notifications = makeNotifications();
    const svc = new WeightReminderService(prisma, notifications);
    expect(await svc.scan(NOW)).toBe(0);
    expect(notifications.createWeightReminder).not.toHaveBeenCalled();
  });

  it('fires for daily cadence when last entry is ≥1 day old', async () => {
    const prisma = makePrisma([
      {
        id: 'p-daily-stale',
        weightReminderCadence: 'daily',
        lastWeightReminderAt: null,
        weightEntries: [{ recordedAt: DAYS_AGO(2) }],
      },
    ]);
    const notifications = makeNotifications();
    const svc = new WeightReminderService(prisma, notifications);
    expect(await svc.scan(NOW)).toBe(1);
    expect(notifications.createWeightReminder).toHaveBeenCalledWith('p-daily-stale', {
      daysSinceLastEntry: 2,
      cadence: 'daily',
    });
  });

  it('skips daily cadence when last entry is <1 day old', async () => {
    const prisma = makePrisma([
      {
        id: 'p-fresh',
        weightReminderCadence: 'daily',
        lastWeightReminderAt: null,
        weightEntries: [{ recordedAt: new Date(NOW.getTime() - 3 * 60 * 60 * 1000) }],
      },
    ]);
    const notifications = makeNotifications();
    const svc = new WeightReminderService(prisma, notifications);
    expect(await svc.scan(NOW)).toBe(0);
  });

  it('fires for weekly cadence at ≥7 days, skips at 6 days', async () => {
    const prisma = makePrisma([
      {
        id: 'p-7d',
        weightReminderCadence: 'weekly',
        lastWeightReminderAt: null,
        weightEntries: [{ recordedAt: DAYS_AGO(7) }],
      },
      {
        id: 'p-6d',
        weightReminderCadence: 'weekly',
        lastWeightReminderAt: null,
        weightEntries: [{ recordedAt: DAYS_AGO(6) }],
      },
    ]);
    const notifications = makeNotifications();
    const svc = new WeightReminderService(prisma, notifications);
    expect(await svc.scan(NOW)).toBe(1);
    expect(notifications.createWeightReminder).toHaveBeenCalledWith('p-7d', expect.any(Object));
    expect(notifications.createWeightReminder).not.toHaveBeenCalledWith('p-6d', expect.any(Object));
  });

  it('debounces against lastWeightReminderAt within the cadence window', async () => {
    const prisma = makePrisma([
      {
        id: 'p-recent-nudge',
        weightReminderCadence: 'weekly',
        // Entry is ancient but we nudged 3 days ago — quiet for now.
        lastWeightReminderAt: DAYS_AGO(3),
        weightEntries: [{ recordedAt: DAYS_AGO(30) }],
      },
      {
        id: 'p-old-nudge',
        weightReminderCadence: 'weekly',
        // Nudged 8 days ago — window elapsed, fire again.
        lastWeightReminderAt: DAYS_AGO(8),
        weightEntries: [{ recordedAt: DAYS_AGO(30) }],
      },
    ]);
    const notifications = makeNotifications();
    const svc = new WeightReminderService(prisma, notifications);
    expect(await svc.scan(NOW)).toBe(1);
    expect(notifications.createWeightReminder).toHaveBeenCalledWith('p-old-nudge', expect.any(Object));
  });

  it('fires for a profile with no entries at all (cadence applies from day 0)', async () => {
    const prisma = makePrisma([
      { id: 'p-empty', weightReminderCadence: 'weekly', lastWeightReminderAt: null, weightEntries: [] },
    ]);
    const notifications = makeNotifications();
    const svc = new WeightReminderService(prisma, notifications);
    expect(await svc.scan(NOW)).toBe(1);
    const calls = (notifications.createWeightReminder as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][1]).toEqual({ daysSinceLastEntry: 0, cadence: 'weekly' });
  });
});
