// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminApi } from '@/lib/admin-api';
import messages from '../../../messages/en.json';
import { ReviewerConfigCard } from './reviewer-config-card';

const t = messages.admin.reviewer;
const settings = {
  reviewerEnabled: true,
  reviewerPasswordSet: false,
  updatedAt: '2026-11-10T12:00:00.000Z',
};

async function renderCard() {
  vi.spyOn(adminApi, 'instanceSettings').mockResolvedValue(settings);
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ReviewerConfigCard />
    </NextIntlClientProvider>,
  );
  await screen.findByLabelText(t.setPassword);
}

async function save(password: string, repeated: string) {
  await userEvent.type(screen.getByLabelText(t.setPassword), password);
  await userEvent.type(screen.getByLabelText(t.repeatPassword), repeated);
  await userEvent.click(screen.getByRole('button', { name: t.savePassword }));
}

describe('the reviewer password', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is asked for twice, and not saved where the two differ, which the second field says', async () => {
    await renderCard();
    const patch = vi.spyOn(adminApi, 'patchInstanceSettings');

    await save('Reviewer-Passw0rd-1', 'Reviewer-Passw0rd-2');

    expect(patch).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(messages.auth.passwordsDontMatch);
  });

  it('is saved once the two are the same, the repeat never sent', async () => {
    await renderCard();
    const patch = vi
      .spyOn(adminApi, 'patchInstanceSettings')
      .mockResolvedValue({ ...settings, reviewerPasswordSet: true });

    await save('Reviewer-Passw0rd-1', 'Reviewer-Passw0rd-1');

    expect(patch).toHaveBeenCalledWith({ reviewerPassword: 'Reviewer-Passw0rd-1' });
    expect(screen.queryByText(messages.auth.passwordsDontMatch)).not.toBeInTheDocument();
  });
});
