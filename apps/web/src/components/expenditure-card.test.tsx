// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Expenditure, Profile } from '@diet-app/shared';
import { api } from '@/lib/api';
import messages from '../../messages/en.json';
import { ExpenditureCard, KeptCorrection } from './expenditure-card';

const texts = messages.expenditure;
const PROFILE = {
  id: '6f1c2b1e-7a52-4a3a-9d0e-0a1b2c3d4e5f',
  name: 'Me',
  expenditureCorrectionKcal: null,
} as Profile;

const anExpenditure = (over: Partial<Expenditure> = {}): Expenditure => ({
  state: 'proposed',
  days: 15,
  weights: 4,
  estimate: 2950,
  maintenance: 2685,
  correction: 270,
  target: 2135,
  targetCorrected: 2405,
  checkedOn: '2026-11-07',
  laterUntil: null,
  ...over,
});

const within = (node: ReactNode) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <NextIntlClientProvider locale="en" messages={messages}>
        {node}
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );

describe('a corrected target the real expenditure proposes', () => {
  afterEach(() => vi.restoreAllMocks());

  it('says what the body seems to use and the target that would come of it, and takes it when accepted', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(anExpenditure());
    const post = vi.spyOn(api, 'post').mockResolvedValue(anExpenditure({ state: 'kept' }) as never);
    within(<ExpenditureCard profile={PROFILE} />);

    expect(
      await screen.findByText(
        'Your diary and weights of the last 3 weeks come to about 2950 kcal a day, 270 kcal more than the formula says. The daily target would be 2405 kcal instead of 2135.',
      ),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: texts.accept }));
    expect(post).toHaveBeenCalledWith('/diary/expenditure/accept', { profileId: PROFILE.id });
    // Accepted, it is no proposal any more.
    await waitFor(() => expect(screen.queryByRole('button', { name: texts.accept })).toBeNull());
  });

  it('puts the proposal off', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(
      anExpenditure({ correction: -150, targetCorrected: 1985 }),
    );
    const post = vi
      .spyOn(api, 'post')
      .mockResolvedValue(anExpenditure({ state: 'later' }) as never);
    within(<ExpenditureCard profile={PROFILE} />);

    expect(await screen.findByText(/150 kcal less than the formula says/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: texts.later }));
    expect(post).toHaveBeenCalledWith('/diary/expenditure/later', { profileId: PROFILE.id });
  });

  it.each(['too_little', 'near', 'later', 'kept'] as const)(
    'says nothing while %s',
    async (state) => {
      const get = vi.spyOn(api, 'get').mockResolvedValue(anExpenditure({ state }));
      const { container } = within(<ExpenditureCard profile={PROFILE} />);

      await waitFor(() => expect(get).toHaveBeenCalled());
      expect(container).toBeEmptyDOMElement();
    },
  );

  it("shows a kept correction on the profile's page, and takes it away", async () => {
    const post = vi
      .spyOn(api, 'post')
      .mockResolvedValue(anExpenditure({ state: 'later' }) as never);
    within(<KeptCorrection profile={{ ...PROFILE, expenditureCorrectionKcal: 270 }} />);

    expect(
      screen.getByText('The target holds a correction from the real expenditure: +270 kcal a day.'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: texts.drop }));
    expect(post).toHaveBeenCalledWith('/diary/expenditure/drop', { profileId: PROFILE.id });
  });
});
