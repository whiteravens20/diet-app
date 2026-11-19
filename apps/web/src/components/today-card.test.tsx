// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiaryDay, Profile } from '@diet-app/shared';
import { api } from '@/lib/api';
import { ApiClientError } from '@/lib/http';
import messages from '../../messages/en.json';
import { TodayCard } from './today-card';

// The diary's window is fetched on the press: a stand-in writes one meal of one's own when it is sent.
vi.mock('next/dynamic', async () => {
  const { createElement } = await import('react');
  return {
    default:
      () => (props: { meal: string; onSubmit: (entry: object) => void; onClose: () => void }) =>
        createElement(
          'div',
          { role: 'dialog', 'aria-label': 'The diary window' },
          createElement(
            'button',
            {
              type: 'button',
              onClick: () =>
                props.onSubmit({
                  kind: 'meal',
                  mealType: props.meal,
                  name: 'Soup',
                  servings: 1,
                  nutrition: { calories: 300 },
                }),
            },
            'Write it',
          ),
        ),
  };
});

const texts = messages.diary;
const profile = { id: '6f1c2b1e-7a52-4a3a-9d0e-0a1b2c3d4e5f', name: 'Me' } as Profile;

const aDay = (): DiaryDay =>
  ({
    profileId: profile.id,
    date: '2026-11-19',
    target: {
      calories: 2000,
      protein: 125,
      fat: 67,
      carbs: 225,
      carbsFloor: null,
      from: 'profile',
    },
    plan: null,
    entries: [],
    eaten: { calories: 750, protein: 34, fat: 19, carbs: 109 },
    estimated: false,
  }) as unknown as DiaryDay;

function shown(answer: DiaryDay | Error) {
  const get = vi
    .spyOn(api, 'get')
    .mockImplementation(() =>
      answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer as never),
    );
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <TodayCard profile={profile} />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  return { get };
}

describe("today's card on the dashboard", () => {
  afterEach(() => vi.restoreAllMocks());

  it('says what was eaten today against the target, and leads to the diary of the day', async () => {
    const { get } = shown(aDay());

    expect(await screen.findByText('750 of 2000 kcal')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: texts.openDiary })).toHaveAttribute(
      'href',
      `/diary?profile=${profile.id}`,
    );
    expect(get.mock.calls[0]![0]).toMatch(
      new RegExp(`^/diary/day\\?profileId=${profile.id}&date=`),
    );
  });

  it("opens the diary's window over the dashboard, and writes what it is given for today", async () => {
    shown(aDay());
    const posted = vi.spyOn(api, 'post').mockResolvedValue({} as never);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: texts.addTitle }));
    await user.click(screen.getByRole('button', { name: 'Write it' }));

    expect(posted).toHaveBeenCalledWith('/diary/entries', {
      kind: 'meal',
      mealType: 'breakfast',
      name: 'Soup',
      servings: 1,
      nutrition: { calories: 300 },
      profileId: profile.id,
      date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
    // Written, the window goes.
    expect(await screen.findByRole('button', { name: texts.addTitle })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('says why where the day cannot be read, and still offers to add to it', async () => {
    shown(new ApiClientError(503, 'UNAVAILABLE', 'down'));

    expect(await screen.findByRole('button', { name: messages.common.retry })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: texts.addTitle })).toBeInTheDocument();
  });
});
