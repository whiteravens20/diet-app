// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Profile, WeightDay, WeightEntry, WeightUnit } from '@diet-app/shared';
import { api } from '@/lib/api';
import messages from '../../messages/en.json';
import { WeightCard } from './weight-card';

// The chart is fetched on demand and draws nothing in a DOM without a size: what stands beside it is what is tested.
vi.mock('next/dynamic', () => ({ default: () => () => null }));

const aProfile = (over: Partial<Profile> = {}): Profile =>
  ({
    id: '6f1c2b1e-7a52-4a3a-9d0e-0a1b2c3d4e5f',
    name: 'Me',
    weightKg: 80,
    targetWeightKg: null,
    ...over,
  }) as Profile;

/** What the pages beside the card show of the profile, each counting how often it was read. */
function Beside({ profileId, reads }: { profileId: string; reads: Record<string, number> }) {
  const counted = (what: string) => () => {
    reads[what] = (reads[what] ?? 0) + 1;
    return Promise.resolve(null);
  };
  useQuery({ queryKey: ['profiles'], queryFn: counted('profiles') });
  useQuery({ queryKey: ['calories', profileId], queryFn: counted('calories') });
  useQuery({ queryKey: ['diary', profileId, '2026-11-06'], queryFn: counted('diary') });
  return null;
}

/**
 * The card of `profile` for an account that weighs in `unit` (null leaves it to where the reader
 * is), with the weights it logged and their days, beside what other pages show of the profile.
 */
async function shown(
  profile: Profile,
  unit: WeightUnit | null,
  logged: { entries?: WeightEntry[]; days?: WeightDay[] } = {},
) {
  vi.spyOn(api, 'get').mockImplementation((path: string) =>
    Promise.resolve(
      (path === '/users/me'
        ? { weightUnit: unit }
        : path.startsWith('/weights/days?')
          ? (logged.days ?? [])
          : path.startsWith('/weights?')
            ? (logged.entries ?? [])
            : []) as never,
    ),
  );
  const post = vi.spyOn(api, 'post').mockResolvedValue({} as never);
  const reads: Record<string, number> = {};
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <WeightCard profile={profile} />
        <Beside profileId={profile.id} reads={reads} />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  const field = await screen.findByLabelText(`Today's weight (${unit ?? 'kg'})`);
  await waitFor(() => expect(reads).toEqual({ profiles: 1, calories: 1, diary: 1 }));
  return {
    post,
    field,
    reads,
    log: () => userEvent.click(screen.getByRole('button', { name: messages.weightCard.log })),
  };
}

const anEntry = (over: Partial<WeightEntry> = {}): WeightEntry => ({
  id: '0b8f5d0e-3c1a-4f7e-9a51-2d6c7e8f9a0b',
  profileId: aProfile().id,
  kg: 79,
  recordedAt: '2026-11-05T07:00:00.000Z',
  createdAt: '2026-11-05T07:00:00.000Z',
  ...over,
});

describe('the weights a profile logs', () => {
  const languages = Object.getOwnPropertyDescriptor(window.navigator, 'languages');

  afterEach(() => {
    vi.restoreAllMocks();
    if (languages) Object.defineProperty(window.navigator, 'languages', languages);
  });

  it("are drawn as the API gives them by day, in the reader's time zone", async () => {
    await shown(aProfile(), 'kg');

    const zone = encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(api.get).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(`^/weights/days\\?profileId=${aProfile().id}&since=[^&]+&timeZone=${zone}$`),
      ),
    );
  });

  it('are typed and shown in kilograms for an account that chose them, and sent as typed', async () => {
    const { post, field, log } = await shown(aProfile(), 'kg');

    expect(field).toHaveAttribute('placeholder', '80');
    expect(screen.getByText('Registered weight: 80 kg')).toBeInTheDocument();
    await userEvent.type(field, '79.4');
    await log();

    expect(post).toHaveBeenCalledWith('/weights', { profileId: aProfile().id, kg: 79.4 });
  });

  it('are typed and shown in pounds for an account that chose them, and sent in kilograms', async () => {
    const { post, field, log } = await shown(aProfile({ targetWeightKg: 70 }), 'lb');

    expect(field).toHaveAttribute('placeholder', '176.4');
    // The weight it began with and the one it works towards, both in its unit.
    expect(
      screen.getByText('Registered weight: 176.4 lb · working towards 154.3 lb'),
    ).toBeInTheDocument();
    await userEvent.type(field, '175');
    await log();

    expect(post).toHaveBeenCalledWith('/weights', { profileId: aProfile().id, kg: 79.38 });
  });

  it('refuse a weight outside what a body weighs, by bounds in the unit of the account', async () => {
    const { post, field, log } = await shown(aProfile(), 'lb');

    // 30 and 400 kg, as pounds: the browser names the bound that was missed.
    expect(field).toHaveAttribute('min', '66.2');
    expect(field).toHaveAttribute('max', '881.8');
    await userEvent.type(field, '50');
    await log();

    expect(field).toBeInvalid();
    expect(post).not.toHaveBeenCalled();
  });

  it("have the profile, its calorie target and its diary read again once one is logged: the newest weight is the profile's", async () => {
    const { field, log, reads } = await shown(aProfile(), 'kg');

    await userEvent.type(field, '79.4');
    await log();

    await waitFor(() => expect(reads).toEqual({ profiles: 2, calories: 2, diary: 2 }));
  });

  it("have them read again once the newest is removed, as the one before it becomes the profile's", async () => {
    const entry = anEntry();
    const { reads } = await shown(aProfile(), 'kg', { entries: [entry] });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const remove = vi.spyOn(api, 'delete').mockResolvedValue(undefined as never);

    await userEvent.click(
      await screen.findByRole('button', { name: new RegExp(messages.weightCard.removeLatest) }),
    );

    expect(remove).toHaveBeenCalledWith(`/weights/${entry.id}`);
    await waitFor(() => expect(reads).toEqual({ profiles: 2, calories: 2, diary: 2 }));
  });

  it('go by where the reader is until the account chooses: kilograms outside the countries that weigh in pounds', async () => {
    Object.defineProperty(window.navigator, 'languages', {
      value: ['pl-PL', 'pl'],
      configurable: true,
    });

    const { field } = await shown(aProfile(), null);

    expect(field).toHaveAttribute('placeholder', '80');
  });
});
