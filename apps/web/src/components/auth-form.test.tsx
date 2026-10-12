// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, COOKIE_SESSION } from '@/lib/api';
import { ApiClientError } from '@/lib/http';
import { session } from '@/lib/session';
import { aPublicConfig } from '@/testing/public-config';
import messages from '../../messages/en.json';
import { AuthForm } from './auth-form';

const router = { replace: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));

/** The address the form is shown at. */
const at = (address: string): void => window.history.replaceState(null, '', address);

function renderLogin(emailEnabled: boolean) {
  const client = new QueryClient();
  client.setQueryData(['config'], aPublicConfig({ email: { enabled: emailEnabled } }));
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider client={client}>
        <AuthForm mode="login" />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

describe('AuthForm', () => {
  it('offers the password reset link where email is configured', () => {
    renderLogin(true);
    expect(screen.getByRole('link', { name: 'Forgot password?' })).toHaveAttribute(
      'href',
      '/forgot-password',
    );
  });

  it('has no password reset link where email is not configured', () => {
    renderLogin(false);
    expect(screen.queryByRole('link', { name: 'Forgot password?' })).not.toBeInTheDocument();
  });
});

const aSession = { user: { id: 'u' }, tokens: { accessToken: 'a', expiresIn: 900, refreshExpiresIn: 2_592_000 }, sessionId: 's' };

describe('where signing in leads', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    router.replace.mockClear();
    at('/');
  });

  /** Sign in with a password that is right, and say where the form went: always as a page loaded anew. */
  async function signedInAt(address: string): Promise<unknown[]> {
    at(address);
    vi.spyOn(api, 'post').mockResolvedValueOnce(aSession as never);
    vi.spyOn(session, 'begin').mockImplementation(() => undefined);
    const load = vi.spyOn(session, 'load').mockImplementation(() => undefined);
    renderLogin(false);
    await userEvent.type(screen.getByLabelText('Email'), 'holder@example.test');
    await userEvent.type(screen.getByLabelText('Password'), 'a-password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    return load.mock.calls[0]!;
  }

  it('is the home page of the account when no other page was asked for', async () => {
    expect(await signedInAt('/login')).toEqual(['/dashboard']);
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('is the page the visitor was sent here from', async () => {
    expect(await signedInAt('/login?next=%2Fmeal-plans%3Fprofile%3Dabc')).toEqual(['/meal-plans?profile=abc']);
  });

  it.each(['https://elsewhere.example/', '//elsewhere.example', '/\\elsewhere.example', 'javascript:alert(1)'])('is the home page when it is asked to be %s', async (asked) => {
    expect(await signedInAt(`/login?next=${encodeURIComponent(asked)}`)).toEqual(['/dashboard']);
  });

  it('sends a visitor who is signed in already on, without asking for anything', () => {
    at('/login?next=%2Frecipes');
    vi.spyOn(session, 'exists').mockReturnValue(true);
    const post = vi.spyOn(api, 'post');

    renderLogin(false);

    expect(router.replace).toHaveBeenCalledWith('/recipes');
    expect(post).not.toHaveBeenCalled();
  });
});

describe('signing in to an account with two-step sign-in', () => {
  const challenge = { secondFactor: { challenge: 'the-challenge', expiresIn: 300 } };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The form after the password was right: it asks for the code. */
  async function atTheSecondStep() {
    const post = vi.spyOn(api, 'post').mockResolvedValueOnce(challenge as never);
    const begin = vi.spyOn(session, 'begin').mockImplementation(() => undefined);
    const load = vi.spyOn(session, 'load').mockImplementation(() => undefined);
    renderLogin(false);
    await userEvent.type(screen.getByLabelText('Email'), 'holder@example.test');
    await userEvent.type(screen.getByLabelText('Password'), 'a-password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    const code = await screen.findByLabelText(messages.secondFactor.codeOrRecovery);
    return { post, begin, load, code };
  }

  it('asks for a code after the password, and opens no session yet', async () => {
    const { post, begin, load } = await atTheSecondStep();

    expect(screen.getByText(messages.secondFactor.signInBody)).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(post).toHaveBeenCalledTimes(1);
    expect(begin).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });

  it('signs in with the code and the challenge the password was answered with, as a browser', async () => {
    const { post, begin, load, code } = await atTheSecondStep();
    post.mockResolvedValueOnce(aSession as never);

    await userEvent.type(code, '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(post).toHaveBeenLastCalledWith('/auth/login/second-factor', { challenge: 'the-challenge', code: '123456' }, COOKIE_SESSION);
    expect(begin).toHaveBeenCalledWith(aSession);
    expect(load).toHaveBeenCalledWith('/dashboard');
  });

  it('says so when the code is wrong, and stays at the code', async () => {
    const { post, code } = await atTheSecondStep();
    post.mockRejectedValueOnce(new ApiClientError(401, 'INVALID_SECOND_FACTOR_CODE', 'That code is not right.'));

    await userEvent.type(code, '000000');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(messages.errors.INVALID_SECOND_FACTOR_CODE);
    expect(screen.getByLabelText(messages.secondFactor.codeOrRecovery)).toBeInTheDocument();
  });

  it('says how long codes have to wait after too many wrong ones', async () => {
    const { post, code } = await atTheSecondStep();
    post.mockRejectedValueOnce(new ApiClientError(429, 'TOO_MANY_ATTEMPTS', 'Too many wrong codes.', undefined, 240));

    await userEvent.type(code, '000000');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts. Try again in 4 minutes.');
  });

  it('begins again with the password when the sign-in took too long', async () => {
    const { post, code } = await atTheSecondStep();
    post.mockRejectedValueOnce(new ApiClientError(401, 'INVALID_SIGN_IN_CHALLENGE', 'This sign-in took too long.'));

    await userEvent.type(code, '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByText(messages.errors.INVALID_SIGN_IN_CHALLENGE)).toBeInTheDocument();
  });

  it('lets the visitor go back to the password', async () => {
    await atTheSecondStep();

    await userEvent.click(screen.getByRole('button', { name: messages.secondFactor.signInBack }));

    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });
});

