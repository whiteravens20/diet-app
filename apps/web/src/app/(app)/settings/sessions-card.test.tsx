// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountSession } from '@diet-app/shared';
import { api, ApiClientError } from '@/lib/api';
import { session as browserSession } from '@/lib/session';
import messages from '../../../../messages/en.json';
import { SessionsCard } from './sessions-card';

const HERE = '11111111-1111-4111-8111-111111111111';
const PHONE = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const aSession = (id: string, label: string | null): AccountSession => ({
  id,
  label,
  startedAt: '2026-01-05T08:00:00.000Z',
  lastUsedAt: '2026-01-06T09:30:00.000Z',
  endsAt: '2026-04-05T08:00:00.000Z',
});

/** The card for an account signed in from this browser, a phone and something that did not say what it is. */
function shown(list: AccountSession[] = [aSession(HERE, 'Firefox on Linux'), aSession(PHONE, 'Safari on iOS'), aSession(OTHER, null)]) {
  vi.spyOn(browserSession, 'id', 'get').mockReturnValue(HERE);
  const forget = vi.spyOn(browserSession, 'forget').mockImplementation(() => undefined);
  const get = vi.spyOn(api, 'get').mockResolvedValue(list as never);
  const remove = vi.spyOn(api, 'delete').mockResolvedValue(undefined as never);
  const onSignedOut = vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <SessionsCard onSignedOut={onSignedOut} />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  return { get, remove, forget, onSignedOut };
}

describe('the list of where an account is signed in', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('names each session, says which is this browser, and when each began and was last used', async () => {
    shown();

    const rows = await screen.findAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText('Firefox on Linux')).toBeInTheDocument();
    expect(within(rows[0]!).getByText(messages.settings.sessionCurrent)).toBeInTheDocument();
    // Read out as two things, not as one word.
    expect(rows[0]!.querySelector('p')!.textContent).toBe(`Firefox on Linux ${messages.settings.sessionCurrent}`);
    expect(within(rows[1]!).queryByText(messages.settings.sessionCurrent)).toBeNull();
    expect(within(rows[2]!).getByText(messages.settings.sessionUnknown)).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Signed in Jan 5, 2026, 8:00 AM · last active Jan 6, 2026, 9:30 AM')).toBeInTheDocument();
  });

  it('signs out another session and stays, with the list read again', async () => {
    const { get, remove, forget, onSignedOut } = shown();

    await userEvent.click(await screen.findByRole('button', { name: 'Sign out Safari on iOS' }));

    expect(remove).toHaveBeenCalledWith(`/users/me/sessions/${PHONE}`);
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(forget).not.toHaveBeenCalled();
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it('leaves the page when the session of this browser is the one signed out', async () => {
    const { forget, onSignedOut } = shown();

    await userEvent.click(await screen.findByRole('button', { name: 'Sign out Firefox on Linux' }));

    await vi.waitFor(() => expect(onSignedOut).toHaveBeenCalledTimes(1));
    expect(forget).toHaveBeenCalledTimes(1);
  });

  it('signs out everywhere, and leaves the page', async () => {
    const { remove, forget, onSignedOut } = shown();

    await userEvent.click(await screen.findByRole('button', { name: messages.settings.sessionEndAll }));

    expect(remove).toHaveBeenCalledWith('/users/me/sessions');
    await vi.waitFor(() => expect(onSignedOut).toHaveBeenCalledTimes(1));
    expect(forget).toHaveBeenCalledTimes(1);
  });

  it('says so when a session was gone already, and reads the list again', async () => {
    const { get, remove } = shown();
    remove.mockRejectedValueOnce(new ApiClientError(404, 'SESSION_NOT_FOUND', 'That session is not open.'));

    await userEvent.click(await screen.findByRole('button', { name: 'Sign out Safari on iOS' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(messages.errors.SESSION_NOT_FOUND);
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  });

  it('says that the list could not be read', async () => {
    vi.spyOn(browserSession, 'id', 'get').mockReturnValue(HERE);
    vi.spyOn(api, 'get').mockRejectedValue(new ApiClientError(503, 'SERVER_BUSY', 'busy'));
    render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <SessionsCard onSignedOut={() => undefined} />
        </QueryClientProvider>
      </NextIntlClientProvider>,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(messages.settings.sessionsFailed);
  });
});
