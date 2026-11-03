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
const ADDRESS = 'reader@example.test';

/**
 * The notice for an account whose address is `emailVerified`, on an instance
 * that does or does not send mail, and where a confirmation does or does not
 * unlock the instance's AI.
 */
function shown(emailVerified: boolean, { mail = true, unlocksAi = false, account = 'a1' } = {}) {
  vi.spyOn(api, 'get').mockImplementation(((path: string) =>
    Promise.resolve(
      path === '/users/me'
        ? { id: account, email: ADDRESS, emailVerified }
        : { email: { enabled: mail, confirmationUnlocksAi: unlocksAi } },
    )) as never);
  const post = vi.spyOn(api, 'post');
  const { container, unmount } = render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <ConfirmEmailNotice />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  return { post, container, unmount };
}

const settled = () => new Promise((settle) => setTimeout(settle, 50));

describe('the notice of an address that is not confirmed', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    document.body.innerHTML = '';
  });

  it('says that confirming is not needed and what it gives where nothing is locked, and sends a new link when asked', async () => {
    const { post } = shown(false);
    post.mockResolvedValue(undefined as never);

    expect(await screen.findByText(c.noticePlain.replace('{email}', ADDRESS))).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: c.resend }));

    expect(post).toHaveBeenCalledWith('/users/me/email/resend-verification');
    expect(await screen.findByText(c.sent)).toBeInTheDocument();
  });

  it("says that confirming unlocks the instance's AI where it does", async () => {
    shown(false, { unlocksAi: true });

    expect(await screen.findByText(c.noticeAi.replace('{email}', ADDRESS))).toBeInTheDocument();
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

  it('goes for a month on this browser at "Not now", and stays for another account', async () => {
    const first = shown(false);
    await userEvent.click(await screen.findByRole('button', { name: c.later }));
    expect(first.container).toBeEmptyDOMElement();
    first.unmount();
    vi.restoreAllMocks();

    const again = shown(false);
    await settled();
    expect(again.container).toBeEmptyDOMElement();
    again.unmount();
    vi.restoreAllMocks();

    shown(false, { account: 'a2' });
    expect(await screen.findByRole('button', { name: c.later })).toBeInTheDocument();
  });

  it('comes back once the month is over', async () => {
    localStorage.setItem(
      'diet-app.confirm-email.later',
      JSON.stringify({ account: 'a1', until: Date.now() - 1000 }),
    );

    shown(false);

    expect(await screen.findByRole('button', { name: c.later })).toBeInTheDocument();
  });

  it('is not there for a confirmed address, nor where the instance sends no mail', async () => {
    const confirmed = shown(true);
    await settled();
    expect(confirmed.container).toBeEmptyDOMElement();
    confirmed.unmount();
    vi.restoreAllMocks();

    const mailless = shown(false, { mail: false });
    await settled();
    expect(mailless.container).toBeEmptyDOMElement();
  });
});
