// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminApi } from '@/lib/admin-api';
import { ApiClientError } from '@/lib/http';
import messages from '../../../messages/en.json';
import { OperatorAiCard } from './operator-ai-card';

const o = messages.admin.operatorAi;

const shown = () =>
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <OperatorAiCard />
    </NextIntlClientProvider>,
  );

describe("who may use the operator's AI, in the admin panel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('says what the instance is set up with and how many accounts are approved', async () => {
    vi.spyOn(adminApi, 'operatorAi').mockResolvedValue({
      access: 'approved',
      mailConfigured: false,
      approved: 2,
    });
    shown();

    expect(await screen.findByText(o.access.approved)).toBeInTheDocument();
    expect(screen.getByText('2 accounts are approved.')).toBeInTheDocument();
    expect(screen.queryByText(o.confirmedWithoutMail)).not.toBeInTheDocument();
  });

  it('warns that a confirmed address lets every account in where there is no mail', async () => {
    vi.spyOn(adminApi, 'operatorAi').mockResolvedValue({
      access: 'confirmed',
      mailConfigured: false,
      approved: 0,
    });
    shown();

    expect(await screen.findByText(o.confirmedWithoutMail)).toBeInTheDocument();
    expect(
      screen.getByText('Approvals count once AI_ADMIN_ACCESS is approved.'),
    ).toBeInTheDocument();
  });

  it('approves the account of an address, says so and counts it', async () => {
    const overview = vi
      .spyOn(adminApi, 'operatorAi')
      .mockResolvedValueOnce({ access: 'approved', mailConfigured: false, approved: 0 })
      .mockResolvedValueOnce({ access: 'approved', mailConfigured: false, approved: 1 });
    const approve = vi.spyOn(adminApi, 'approveOperatorAi').mockResolvedValue(undefined);
    shown();

    await userEvent.type(await screen.findByLabelText(o.email), ' tester@example.test ');
    await userEvent.click(screen.getByRole('button', { name: o.approve }));

    expect(approve).toHaveBeenCalledWith('tester@example.test');
    expect(await screen.findByRole('status')).toHaveTextContent(
      "tester@example.test may use the instance's AI.",
    );
    expect(await screen.findByText('One account is approved.')).toBeInTheDocument();
    expect(overview).toHaveBeenCalledTimes(2);
  });

  it('takes an approval back', async () => {
    vi.spyOn(adminApi, 'operatorAi').mockResolvedValue({
      access: 'approved',
      mailConfigured: false,
      approved: 1,
    });
    const revoke = vi.spyOn(adminApi, 'revokeOperatorAi').mockResolvedValue(undefined);
    shown();

    await userEvent.type(await screen.findByLabelText(o.email), 'tester@example.test');
    await userEvent.click(screen.getByRole('button', { name: o.revoke }));

    expect(revoke).toHaveBeenCalledWith('tester@example.test');
    expect(await screen.findByRole('status')).toHaveTextContent(
      "tester@example.test is no longer approved for the instance's AI.",
    );
  });

  it('says when no account has the address', async () => {
    vi.spyOn(adminApi, 'operatorAi').mockResolvedValue({
      access: 'approved',
      mailConfigured: false,
      approved: 0,
    });
    vi.spyOn(adminApi, 'approveOperatorAi').mockRejectedValue(
      new ApiClientError(404, 'USER_NOT_FOUND', 'No account has that address.'),
    );
    shown();

    await userEvent.type(await screen.findByLabelText(o.email), 'nobody@example.test');
    await userEvent.click(screen.getByRole('button', { name: o.approve }));

    expect(await screen.findByRole('alert')).toHaveTextContent(messages.errors.USER_NOT_FOUND);
  });
});
