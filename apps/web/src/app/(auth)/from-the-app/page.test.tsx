// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { act, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { session } from '@/lib/session';
import messages from '../../../../messages/en.json';
import FromTheAppPage from './page';

vi.mock('@/lib/session', () => ({ session: { replaced: vi.fn(), load: vi.fn() } }));

const CODE = 'c0de'.repeat(16);
const ACCOUNT = { email: 'anna@example.test', displayName: 'Anna' };

const answered = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** What the page asked of the API: each path with the body it sent. */
const asked = (fetchMock: ReturnType<typeof vi.fn>): { path: string; body: unknown }[] =>
  fetchMock.mock.calls.map((call) => {
    const [url, init] = call as [string, RequestInit];
    return {
      path: new URL(url, 'http://here.test').pathname,
      body: JSON.parse(String(init.body)) as unknown,
    };
  });

async function openAt(address: string) {
  window.history.replaceState(null, '', address);
  await act(async () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <FromTheAppPage />
      </NextIntlClientProvider>,
    );
  });
}

describe('the page that signs a browser in from the application', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    window.history.replaceState(null, '', '/');
  });

  it('takes the code out of the address and the history, and shows whose account it is for without signing in', async () => {
    fetchMock.mockResolvedValueOnce(answered(200, ACCOUNT));

    await openAt(`/from-the-app#code=${CODE}&next=%2Fsettings`);

    expect(window.location.href).toBe(`${window.location.origin}/from-the-app`);
    expect(screen.getByText('anna@example.test')).toBeInTheDocument();
    expect(screen.getByText('Anna')).toBeInTheDocument();
    expect(screen.getByText(messages.fromTheApp.onlyYours)).toBeInTheDocument();
    expect(asked(fetchMock)).toEqual([
      { path: '/api/auth/browser-sign-in/account', body: { code: CODE } },
    ]);
    expect(session.replaced).not.toHaveBeenCalled();
  });

  it('signs in when its reader says so, and goes on to the page the application asked for', async () => {
    fetchMock
      .mockResolvedValueOnce(answered(200, ACCOUNT))
      .mockResolvedValueOnce(answered(200, { sessionId: 'x' }));
    await openAt(`/from-the-app#code=${CODE}&next=%2Fmeal-plans%3Fprofile%3Dp1%26plan%3Dq2`);

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Sign in' })));

    expect(asked(fetchMock)[1]).toEqual({
      path: '/api/auth/browser-sign-in',
      body: { code: CODE },
    });
    expect(session.replaced).toHaveBeenCalledWith('/meal-plans?profile=p1&plan=q2');
  });

  it('goes on to the home page of the account in the place of a page that is not one of an account', async () => {
    fetchMock
      .mockResolvedValueOnce(answered(200, ACCOUNT))
      .mockResolvedValueOnce(answered(200, { sessionId: 'x' }));
    await openAt(`/from-the-app#code=${CODE}&next=https%3A%2F%2Felsewhere.example%2F`);

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Sign in' })));

    expect(session.replaced).toHaveBeenCalledWith('/dashboard');
  });

  it('signs nobody in when its reader cancels', async () => {
    fetchMock.mockResolvedValueOnce(answered(200, ACCOUNT));
    await openAt(`/from-the-app#code=${CODE}&next=%2Fsettings`);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(session.load).toHaveBeenCalledWith('/');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(session.replaced).not.toHaveBeenCalled();
  });

  it('says why a code that is no good signs nobody in, and leads to the sign-in page', async () => {
    fetchMock.mockResolvedValueOnce(
      answered(401, {
        statusCode: 401,
        error: 'INVALID_BROWSER_CODE',
        message: 'The code is not good.',
      }),
    );

    await openAt(`/from-the-app#code=${CODE}&next=%2Fsettings`);

    expect(screen.getByRole('alert')).toHaveTextContent(messages.errors.INVALID_BROWSER_CODE);
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      '/login?next=%2Fsettings',
    );
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument();
  });

  it('says why when the code was used up between the question and the answer', async () => {
    fetchMock.mockResolvedValueOnce(answered(200, ACCOUNT)).mockResolvedValueOnce(
      answered(401, {
        statusCode: 401,
        error: 'INVALID_BROWSER_CODE',
        message: 'The code is not good.',
      }),
    );
    await openAt(`/from-the-app#code=${CODE}&next=%2Fsettings`);

    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Sign in' })));

    expect(screen.getByRole('alert')).toHaveTextContent(messages.errors.INVALID_BROWSER_CODE);
    expect(session.replaced).not.toHaveBeenCalled();
  });

  it('asks nothing of the API when the address holds no code', async () => {
    await openAt('/from-the-app');

    expect(screen.getByRole('alert')).toHaveTextContent(messages.fromTheApp.missing);
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
