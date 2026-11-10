// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import messages from '../../../../messages/en.json';
import ResetPasswordPage from './page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams('token=a-token-from-the-mail'),
}));

async function setNew(password: string, repeated: string) {
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ResetPasswordPage />
    </NextIntlClientProvider>,
  );
  await userEvent.type(await screen.findByLabelText(messages.auth.newPasswordField), password);
  await userEvent.type(screen.getByLabelText(messages.auth.confirmPasswordField), repeated);
  await userEvent.click(screen.getByRole('button', { name: messages.auth.newPasswordSubmit }));
}

describe('a new password after a reset', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is asked for twice, and not set where the two differ, which the second field says', async () => {
    const post = vi.spyOn(api, 'post');

    await setNew('New-Passw0rd-456', 'New-Passw0rd-457');

    expect(post).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(messages.auth.passwordsDontMatch);
  });

  it("is set with the mail's token once the two are the same, the repeat never sent", async () => {
    const post = vi.spyOn(api, 'post').mockReturnValue(new Promise(() => {}));

    await setNew('New-Passw0rd-456', 'New-Passw0rd-456');

    expect(post).toHaveBeenCalledWith('/auth/password-reset/confirm', {
      token: 'a-token-from-the-mail',
      password: 'New-Passw0rd-456',
    });
  });
});
