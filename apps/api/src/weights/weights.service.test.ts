// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

/**
 * Unit tests for WeightsService (weight log). Prisma is mocked. Focus on
 * the ownership guard (a user cannot read/write/delete another user's profile
 * entries) and the create/list/delete happy paths.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WeightsService } from './weights.service.js';

function makePrisma(profileOwner: string | null = 'user-1') {
  return {
    profile: {
      findUnique: vi
        .fn()
        .mockResolvedValue(profileOwner === null ? null : { userId: profileOwner }),
    },
    weightEntry: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'w1',
          profileId: 'p1',
          kg: 80,
          recordedAt: new Date('2026-06-01'),
          createdAt: new Date('2026-06-01'),
        },
      ]),
      create: vi
        .fn()
        .mockImplementation((args: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'w-new', createdAt: new Date(), ...args.data }),
        ),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

function makeService(prisma: ReturnType<typeof makePrisma>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial test double
  return new WeightsService(prisma as any);
}

describe('WeightsService ownership guard', () => {
  let prisma: ReturnType<typeof makePrisma>;
  beforeEach(() => {
    prisma = makePrisma('user-1');
  });

  it('rejects listing another user’s profile', async () => {
    prisma = makePrisma('someone-else');
    await expect(makeService(prisma).list('user-1', 'p1')).rejects.toMatchObject({
      response: { error: 'PROFILE_NOT_FOUND' },
    });
  });

  it('throws PROFILE_NOT_FOUND when the profile is missing', async () => {
    prisma = makePrisma(null);
    await expect(makeService(prisma).list('user-1', 'p-missing')).rejects.toMatchObject({
      response: expect.objectContaining({ error: 'PROFILE_NOT_FOUND' }),
    });
  });
});

describe('WeightsService happy paths', () => {
  it('lists entries newest-first as DTOs', async () => {
    const prisma = makePrisma('user-1');
    const rows = await makeService(prisma).list('user-1', 'p1');
    expect(rows[0]).toMatchObject({ id: 'w1', kg: 80 });
    expect(rows[0].recordedAt).toBe(new Date('2026-06-01').toISOString());
  });

  it('passes a since-filter into the query', async () => {
    const prisma = makePrisma('user-1');
    const since = new Date('2026-05-01');
    await makeService(prisma).list('user-1', 'p1', since);
    expect(prisma.weightEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ recordedAt: { gte: since } }) }),
    );
  });

  it('creates an entry, defaulting recordedAt to now when omitted', async () => {
    const prisma = makePrisma('user-1');
    const dto = await makeService(prisma).create('user-1', 'p1', { kg: 79.5 } as never);
    expect(dto.kg).toBe(79.5);
    expect(prisma.weightEntry.create).toHaveBeenCalledTimes(1);
  });

  it('uses the provided recordedAt when given', async () => {
    const prisma = makePrisma('user-1');
    await makeService(prisma).create('user-1', 'p1', {
      kg: 79.5,
      recordedAt: '2026-06-10T00:00:00.000Z',
    } as never);
    const data = prisma.weightEntry.create.mock.calls[0][0].data;
    expect((data.recordedAt as Date).toISOString()).toBe('2026-06-10T00:00:00.000Z');
  });

  it("throws WEIGHT_ENTRY_NOT_FOUND when no entry of that id is the account's", async () => {
    const prisma = makePrisma('user-1');
    prisma.weightEntry.deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    await expect(makeService(prisma).remove('user-1', 'missing')).rejects.toMatchObject({
      response: expect.objectContaining({ error: 'WEIGHT_ENTRY_NOT_FOUND' }),
    });
  });

  it('deletes an entry only as one of a profile of the account', async () => {
    const prisma = makePrisma('user-1');
    await makeService(prisma).remove('user-1', 'w1');
    expect(prisma.weightEntry.deleteMany).toHaveBeenCalledWith({
      where: { id: 'w1', profile: { userId: 'user-1' } },
    });
  });
});

describe('the weights of a profile by day', () => {
  const entries = [
    { kg: 80, recordedAt: new Date('2026-06-10T08:00:00Z') },
    { kg: 82, recordedAt: new Date('2026-06-04T08:00:00Z') },
  ];

  it('reads the week before the day of `since` as well, and leaves out the days before that day', async () => {
    const prisma = makePrisma();
    prisma.weightEntry.findMany.mockResolvedValue(entries);
    const since = new Date('2026-06-08T12:00:00Z');

    const days = await makeService(prisma).days('user-1', 'p1', 'Europe/Warsaw', since);

    expect(prisma.weightEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { profileId: 'p1', recordedAt: { gte: new Date('2026-05-31T12:00:00Z') } },
      }),
    );
    // The 4th is read for the mean of the 10th, and not answered as a day of its own.
    expect(days).toEqual([{ date: '2026-06-10', kg: 80, mean: 81 }]);
  });

  it('reads every entry, a thousand at most, without `since`', async () => {
    const prisma = makePrisma();
    prisma.weightEntry.findMany.mockResolvedValue(entries);

    const days = await makeService(prisma).days('user-1', 'p1', 'UTC');

    expect(prisma.weightEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { profileId: 'p1' }, take: 1000 }),
    );
    expect(days.map((day) => day.date)).toEqual(['2026-06-04', '2026-06-10']);
  });

  it("answers PROFILE_NOT_FOUND for another user's profile", async () => {
    await expect(
      makeService(makePrisma('user-2')).days('user-1', 'p1', 'UTC'),
    ).rejects.toMatchObject({ response: { error: 'PROFILE_NOT_FOUND' } });
  });
});
