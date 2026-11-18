// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Profile } from '@diet-app/shared';
import { api } from '@/lib/api';
import { ApiClientError } from '@/lib/http';
import { failReadsAgain } from '@/testing/read-again';
import messages from '../../../../messages/en.json';
import DashboardPage from './page';

// What a profile comes to is tested with its own cards; here the page is what holds them.
vi.mock('@/components/profile-summary', () => ({
  ProfileSummary: ({ profile }: { profile: Profile }) => <h2>{profile.name}</h2>,
}));

const profiles = [
  { id: '6f1c2b1e-7a52-4a3a-9d0e-000000000001', name: 'Anna' },
  { id: '6f1c2b1e-7a52-4a3a-9d0e-000000000002', name: 'Adam' },
] as Profile[];

/** The dashboard of an account whose profiles are read with `answer`. */
function shown(answer: () => Promise<unknown>) {
  vi.spyOn(api, 'get').mockImplementation(answer as never);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider client={client}>
        <DashboardPage />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  return client;
}

describe('the dashboard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows every profile', async () => {
    shown(() => Promise.resolve(profiles));

    expect(await screen.findByRole('heading', { name: 'Anna' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Adam' })).toBeInTheDocument();
  });

  it('says why when the profiles cannot be read, in the place of the profiles', async () => {
    shown(() => Promise.reject(new ApiClientError(0, 'NETWORK', 'Failed to fetch')));

    expect(await screen.findByRole('alert')).toHaveTextContent(messages.errors.NETWORK);
    expect(screen.queryByRole('heading', { name: 'Anna' })).toBeNull();
  });

  it('keeps the profiles it showed when a read fails again, says why above them, and reads again when asked', async () => {
    const client = shown(() => Promise.resolve(profiles));
    await screen.findByRole('heading', { name: 'Anna' });

    const answerAgain = await failReadsAgain(client);

    const note = await screen.findByText(messages.common.shownFromBefore, { exact: false });
    expect(note.closest('[role="alert"]')).toHaveTextContent(messages.errors.NETWORK);
    expect(screen.getByRole('heading', { name: 'Anna' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Adam' })).toBeInTheDocument();
    answerAgain();
    await userEvent.click(
      within(note.closest('[role="alert"]') as HTMLElement).getByRole('button', {
        name: messages.common.retry,
      }),
    );
    await vi.waitFor(() =>
      expect(screen.queryByText(messages.common.shownFromBefore, { exact: false })).toBeNull(),
    );
  });
});
