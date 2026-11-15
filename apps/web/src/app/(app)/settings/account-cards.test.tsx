// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@diet-app/shared';
import { api } from '@/lib/api';
import messages from '../../../../messages/en.json';
import { DangerZoneCard, PasswordCard } from './account-cards';

function renderCard(card: ReactNode = <PasswordCard />) {
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider client={new QueryClient()}>{card}</QueryClientProvider>
    </NextIntlClientProvider>,
  );
}

async function change(current: string, next: string, repeated: string) {
  await userEvent.type(screen.getByLabelText(messages.settings.currentPassword), current);
  await userEvent.type(screen.getByLabelText(messages.settings.newPasswordLabel), next);
  await userEvent.type(screen.getByLabelText(messages.settings.repeatNewPassword), repeated);
  await userEvent.click(screen.getByRole('button', { name: messages.settings.changePassword }));
}

describe('changing the password', () => {
  afterEach(() => vi.restoreAllMocks());

  it('asks for the new password twice, and changes nothing where the two differ, which the second field says', async () => {
    const post = vi.spyOn(api, 'post');
    renderCard();

    await change('Old-Passw0rd-123', 'New-Passw0rd-456', 'New-Passw0rd-457');

    expect(post).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(messages.auth.passwordsDontMatch);
  });

  it('changes it once the two are the same, the repeat never sent', async () => {
    const post = vi.spyOn(api, 'post').mockReturnValue(new Promise(() => {}));
    renderCard();

    await change('Old-Passw0rd-123', 'New-Passw0rd-456', 'New-Passw0rd-456');

    expect(post).toHaveBeenCalledWith('/users/me/password', {
      currentPassword: 'Old-Passw0rd-123',
      newPassword: 'New-Passw0rd-456',
    });
  });
});

describe('deleting the account', () => {
  afterEach(() => vi.restoreAllMocks());

  it('hides the password again once the deletion is confirmed, the password sent as typed', async () => {
    const remove = vi.spyOn(api, 'delete').mockReturnValue(new Promise(() => {}));
    renderCard(<DangerZoneCard me={{ email: 'owner@example.test' } as SessionUser} />);
    await userEvent.click(screen.getByRole('button', { name: messages.settings.deleteAccount }));
    await userEvent.type(
      screen.getByLabelText(messages.settings.deleteAccountTypeEmail),
      'owner@example.test',
    );
    const password = () => screen.getByLabelText(messages.settings.deleteAccountTypePassword);
    await userEvent.type(password(), 'Owner-Passw0rd-123');
    await userEvent.click(screen.getByRole('button', { name: messages.common.showPassword }));
    expect(password()).toHaveAttribute('type', 'text');

    await userEvent.click(
      screen.getByRole('button', { name: messages.settings.deleteAccountConfirm }),
    );

    expect(remove).toHaveBeenCalledWith('/users/me', { currentPassword: 'Owner-Passw0rd-123' });
    expect(password()).toHaveAttribute('type', 'password');
    expect(password()).toHaveValue('Owner-Passw0rd-123');
  });
});
