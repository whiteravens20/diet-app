// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

/** The page's address, as the router holds it: a chip replaces it, and the page is drawn again with it. */
const address = { search: '' };
let drawAgain: () => void = () => {};
const replace = vi.fn((to: string) => {
  address.search = new URL(to, 'http://localhost').search;
  drawAgain();
});
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(address.search),
  useRouter: () => ({ replace }),
}));

const profiles = [
  { id: '6f1c2b1e-7a52-4a3a-9d0e-000000000001', name: 'Anna' },
  { id: '6f1c2b1e-7a52-4a3a-9d0e-000000000002', name: 'Adam' },
] as Profile[];

/** The dashboard of an account whose profiles are read with `answer`. */
function shown(answer: () => Promise<unknown>) {
  vi.spyOn(api, 'get').mockImplementation(answer as never);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const page = (): ReactNode => (
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider client={client}>
        <DashboardPage />
      </QueryClientProvider>
    </NextIntlClientProvider>
  );
  const { rerender } = render(page());
  drawAgain = () => rerender(page());
  return client;
}

const chip = (name: string) =>
  within(screen.getByRole('group', { name: messages.common.profileChoice })).getByRole('button', {
    name,
  });

describe('the dashboard', () => {
  beforeEach(() => {
    address.search = '';
    replace.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows one profile at a time, the first where the address names none, with a chip for each', async () => {
    shown(() => Promise.resolve(profiles));

    expect(await screen.findByRole('heading', { name: 'Anna' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Adam' })).toBeNull();
    expect(chip('Anna')).toHaveAttribute('aria-pressed', 'true');
    expect(chip('Adam')).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows the profile its chip picks, and keeps the pick in the address', async () => {
    shown(() => Promise.resolve(profiles));
    await screen.findByRole('heading', { name: 'Anna' });

    await userEvent.click(chip('Adam'));

    expect(replace).toHaveBeenCalledWith(`/dashboard?profile=${profiles[1]!.id}`, {
      scroll: false,
    });
    expect(await screen.findByRole('heading', { name: 'Adam' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Anna' })).toBeNull();
  });

  it('shows the profile the address names, as a reminder links to it, and the first for one it does not hold', async () => {
    address.search = `?profile=${profiles[1]!.id}`;
    shown(() => Promise.resolve(profiles));
    expect(await screen.findByRole('heading', { name: 'Adam' })).toBeInTheDocument();

    address.search = '?profile=6f1c2b1e-7a52-4a3a-9d0e-00000000ffff';
    drawAgain();
    expect(await screen.findByRole('heading', { name: 'Anna' })).toBeInTheDocument();
  });

  it('has no chips for an account of one profile', async () => {
    shown(() => Promise.resolve(profiles.slice(0, 1)));

    expect(await screen.findByRole('heading', { name: 'Anna' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: messages.common.profileChoice })).toBeNull();
  });

  it('says why when the profiles cannot be read, in the place of the profiles', async () => {
    shown(() => Promise.reject(new ApiClientError(0, 'NETWORK', 'Failed to fetch')));

    expect(await screen.findByRole('alert')).toHaveTextContent(messages.errors.NETWORK);
    expect(screen.queryByRole('heading', { name: 'Anna' })).toBeNull();
  });

  it('keeps the profile it showed when a read fails again, says why above it, and reads again when asked', async () => {
    const client = shown(() => Promise.resolve(profiles));
    await screen.findByRole('heading', { name: 'Anna' });

    const answerAgain = await failReadsAgain(client);

    const note = await screen.findByText(messages.common.shownFromBefore, { exact: false });
    expect(note.closest('[role="alert"]')).toHaveTextContent(messages.errors.NETWORK);
    expect(screen.getByRole('heading', { name: 'Anna' })).toBeInTheDocument();
    expect(chip('Adam')).toBeInTheDocument();
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
