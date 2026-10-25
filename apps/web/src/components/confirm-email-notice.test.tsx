// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { ApiClientError } from '@/lib/http';
import messages from '../../messages/en.json';
import { ConfirmEmailNotice } from './confirm-email-notice';

const c = messages.confirmEmail;

/** The notice for an account whose address is `emailVerified`, on an instance that does or does not send mail. */
function shown(emailVerified: boolean, mail = true) {
  vi.spyOn(api, 'get').mockImplementation(((path: string) =>
    Promise.resolve(
      path === '/users/me'
        ? { email: 'reader@example.test', emailVerified }
        : { email: { enabled: mail } },
    )) as never);
  const post = vi.spyOn(api, 'post');
  const { container } = render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <ConfirmEmailNotice />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  return { post, container };
}

describe('the notice of an address that is not confirmed', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('names the address and sends a new link when asked', async () => {
    const { post } = shown(false);
    post.mockResolvedValue(undefined as never);

    expect(
      await screen.findByText(
        'Confirm your email address reader@example.test: follow the link in the message received at that address. A link lasts an hour.',
      ),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: c.resend }));

    expect(post).toHaveBeenCalledWith('/users/me/email/resend-verification');
    expect(await screen.findByText(c.sent)).toBeInTheDocument();
  });

  it('says that a link went out a moment ago, when it did', async () => {
    const { post } = shown(false);
    post.mockRejectedValue(
      new ApiClientError(
        429,
        'VERIFICATION_SENT_RECENTLY',
        'A verification mail was sent a moment ago.',
        undefined,
        75,
      ),
    );

    await userEvent.click(await screen.findByRole('button', { name: c.resend }));

    expect(await screen.findByText(messages.errors.VERIFICATION_SENT_RECENTLY)).toBeInTheDocument();
  });

  it('is not there for a confirmed address, nor where the instance sends no mail', async () => {
    const confirmed = shown(true);
    await new Promise((settle) => setTimeout(settle, 50));
    expect(confirmed.container).toBeEmptyDOMElement();
    vi.restoreAllMocks();
    document.body.innerHTML = '';

    const mailless = shown(false, false);
    await new Promise((settle) => setTimeout(settle, 50));
    expect(mailless.container).toBeEmptyDOMElement();
  });
});
