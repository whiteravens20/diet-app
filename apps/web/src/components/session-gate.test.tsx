// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import type { AuthResponse } from '@diet-app/shared';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { session } from '@/lib/session';
import messages from '../../messages/en.json';
import { SessionGate } from './session-gate';

const anAnswer = (accessToken: string): AuthResponse => ({
  user: {
    id: '22222222-2222-4222-8222-222222222222',
    email: 'user@example.test',
    displayName: 'User',
    role: 'user',
    emailVerified: true,
  },
  tokens: { accessToken, expiresIn: 900, refreshExpiresIn: 2_592_000 },
  sessionId: '11111111-1111-4111-8111-111111111111',
});
const answered = (status: number, body: unknown = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const THE_PAGE = 'The page of the account';
const thePage = (): HTMLElement | null => screen.queryByText(THE_PAGE);

function shown() {
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <SessionGate>
        <p>{THE_PAGE}</p>
      </SessionGate>
    </NextIntlClientProvider>,
  );
}

describe('the pages of a signed-in account', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let leave: ReturnType<typeof vi.spyOn>;

  /** The browser holds a session, or none: by the marker cookie. */
  const aBrowser = (signedIn: boolean): void => {
    document.cookie = signedIn ? 'diet_session=1; Path=/' : 'diet_session=; Max-Age=0; Path=/';
  };

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    leave = vi.spyOn(session, 'leave').mockImplementation(() => undefined);
  });

  afterEach(() => {
    // The session is one for all the tests of the file: each leaves it ended.
    session.forget();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('are shown at once to a page that holds a token', () => {
    aBrowser(true);
    session.begin(anAnswer('access-1'));

    shown();

    expect(thePage()).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('wait for a page that was just loaded to get its token, and ask the API for nothing until then', async () => {
    aBrowser(true);
    let answer!: (res: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((resolve) => (answer = resolve)));

    shown();

    expect(thePage()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/auth/refresh');

    await act(async () => answer(answered(200, anAnswer('access-2'))));

    expect(await screen.findByText(THE_PAGE)).toBeInTheDocument();
    expect(leave).not.toHaveBeenCalled();
  });

  it('are not shown to a browser without a session: it is sent to sign in', () => {
    aBrowser(false);

    shown();

    expect(leave).toHaveBeenCalledTimes(1);
    expect(thePage()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('are left for the sign-in page when the server refuses the session', async () => {
    aBrowser(true);
    fetchMock.mockResolvedValue(answered(401, { error: 'INVALID_REFRESH' }));

    shown();

    await vi.waitFor(() => expect(leave).toHaveBeenCalled());
    expect(thePage()).toBeNull();
    expect(session.exists()).toBe(false);
  });

  it.each([
    ['is busy', () => Promise.resolve(answered(503))],
    ['asks to wait', () => Promise.resolve(answered(429))],
    ['cannot be reached', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])(
    'say so when the server %s, sign nobody out, and come up when a new try gets through',
    async (_what, respond) => {
      aBrowser(true);
      fetchMock.mockImplementation(respond);

      shown();

      expect(await screen.findByRole('alert')).toHaveTextContent(messages.auth.sessionUnreachable);
      expect(thePage()).toBeNull();
      expect(leave).not.toHaveBeenCalled();
      expect(session.exists()).toBe(true);

      fetchMock.mockImplementation(() => Promise.resolve(answered(200, anAnswer('access-3'))));
      await userEvent.click(screen.getByRole('button', { name: messages.common.retry }));

      expect(await screen.findByText(THE_PAGE)).toBeInTheDocument();
      expect(screen.queryByRole('alert')).toBeNull();
    },
  );

  it('keep saying that the session could not be reached while a new try is on its way, with nothing to press twice', async () => {
    aBrowser(true);
    fetchMock.mockResolvedValueOnce(answered(503));
    shown();
    await screen.findByRole('alert');
    let answer!: (res: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => (answer = resolve)));

    await userEvent.click(screen.getByRole('button', { name: messages.common.retry }));

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: messages.common.retry })).toBeDisabled();

    await act(async () => answer(answered(503)));

    await vi.waitFor(() =>
      expect(screen.getByRole('button', { name: messages.common.retry })).toBeEnabled(),
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('go when the session ends under them', async () => {
    aBrowser(true);
    session.begin(anAnswer('access-1'));
    shown();
    expect(thePage()).toBeInTheDocument();

    act(() => session.forget());

    expect(thePage()).toBeNull();
  });

  it('are loaded anew when the browser shows a page it had kept in memory', () => {
    aBrowser(true);
    session.begin(anAnswer('access-1'));
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    shown();

    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
    expect(reload).not.toHaveBeenCalled();

    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
