// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiClientError, COOKIE_SESSION } from '@/lib/api';
import { session } from '@/lib/session';
import { aPublicConfig } from '@/testing/public-config';
import messages from '../../messages/en.json';
import { AuthForm } from './auth-form';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

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

describe('signing in to an account with two-step sign-in', () => {
  const aSession = { user: { id: 'u' }, tokens: { accessToken: 'a', expiresIn: 900, refreshExpiresIn: 2_592_000 }, sessionId: 's' };
  const challenge = { secondFactor: { challenge: 'the-challenge', expiresIn: 300 } };

  afterEach(() => {
    vi.restoreAllMocks();
    push.mockClear();
  });

  /** The form after the password was right: it asks for the code. */
  async function atTheSecondStep() {
    const post = vi.spyOn(api, 'post').mockResolvedValueOnce(challenge as never);
    const begin = vi.spyOn(session, 'begin').mockImplementation(() => undefined);
    renderLogin(false);
    await userEvent.type(screen.getByLabelText('Email'), 'holder@example.test');
    await userEvent.type(screen.getByLabelText('Password'), 'a-password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    const code = await screen.findByLabelText(messages.secondFactor.codeOrRecovery);
    return { post, begin, code };
  }

  it('asks for a code after the password, and opens no session yet', async () => {
    const { post, begin } = await atTheSecondStep();

    expect(screen.getByText(messages.secondFactor.signInBody)).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(post).toHaveBeenCalledTimes(1);
    expect(begin).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('signs in with the code and the challenge the password was answered with, as a browser', async () => {
    const { post, begin, code } = await atTheSecondStep();
    post.mockResolvedValueOnce(aSession as never);

    await userEvent.type(code, '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(post).toHaveBeenLastCalledWith('/auth/login/second-factor', { challenge: 'the-challenge', code: '123456' }, COOKIE_SESSION);
    expect(begin).toHaveBeenCalledWith(aSession);
    expect(push).toHaveBeenCalledWith('/dashboard');
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

