// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminApi } from '@/lib/admin-api';
import { ApiClientError } from '@/lib/http';
import messages from '../../../messages/en.json';
import { AccountSecondFactorCard } from './account-second-factor-card';
import { AdminSecondFactorCard } from './admin-second-factor-card';

const a = messages.admin;
const m = messages.secondFactor;
const SETUP = {
  secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
  uri: 'otpauth://totp/Diet%20App%20admin:admin?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
  enrolment: 'sealed',
  expiresIn: 900,
};

const within = (ui: React.ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );

describe('two-step sign-in to the admin panel', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is set up with the password and the first code from the app, and tells the panel', async () => {
    const propose = vi.spyOn(adminApi, 'proposeSecondFactor').mockResolvedValue(SETUP);
    const begin = vi.spyOn(adminApi, 'beginSecondFactor').mockResolvedValue(undefined);
    const onChanged = vi.fn();
    within(<AdminSecondFactorCard on={false} onChanged={onChanged} />);

    expect(screen.getByText(a.secondFactorOff)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: m.setUp }));
    await userEvent.type(screen.getByLabelText(a.adminPassword), 'a-long-admin-password');
    await userEvent.click(screen.getByRole('button', { name: m.continue }));
    expect(await screen.findByTitle(m.qrLabel)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(m.code, { exact: false }), '123456');
    await userEvent.click(screen.getByRole('button', { name: m.switchOn }));

    expect(propose).toHaveBeenCalledWith('a-long-admin-password');
    expect(begin).toHaveBeenCalledWith('sealed', '123456');
    expect(await screen.findByRole('status')).toHaveTextContent(a.secondFactorOnNow);
    expect(onChanged).toHaveBeenCalledWith(true);
  });

  it('is switched off with the password and a code, and says how the operator gets back in without the app', async () => {
    const end = vi.spyOn(adminApi, 'endSecondFactor').mockResolvedValue(undefined);
    const onChanged = vi.fn();
    within(<AdminSecondFactorCard on onChanged={onChanged} />);

    expect(screen.getByText(a.secondFactorOn)).toBeInTheDocument();
    expect(screen.getByText(a.secondFactorLost)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: m.switchOff }));
    await userEvent.type(screen.getByLabelText(a.adminPassword), 'a-long-admin-password');
    await userEvent.type(screen.getByLabelText(m.code, { exact: false }), '654321');
    await userEvent.click(screen.getByRole('button', { name: m.switchOff }));

    expect(end).toHaveBeenCalledWith('a-long-admin-password', '654321');
    expect(await screen.findByRole('status')).toHaveTextContent(a.secondFactorOffNow);
    expect(onChanged).toHaveBeenCalledWith(false);
  });

  it("says what the API refused, in the visitor's language", async () => {
    vi.spyOn(adminApi, 'proposeSecondFactor').mockRejectedValue(
      new ApiClientError(409, 'ADMIN_SECOND_FACTOR_RESET_SET', 'ADMIN_SECOND_FACTOR_RESET is on'),
    );
    within(<AdminSecondFactorCard on={false} onChanged={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: m.setUp }));
    await userEvent.type(screen.getByLabelText(a.adminPassword), 'a-long-admin-password');
    await userEvent.click(screen.getByRole('button', { name: m.continue }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      messages.errors.ADMIN_SECOND_FACTOR_RESET_SET,
    );
  });
});

describe('two-step sign-in of an account, for the operator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is switched off for the account of an address only after the operator was asked again', async () => {
    const remove = vi.spyOn(adminApi, 'removeAccountSecondFactor').mockResolvedValue(undefined);
    within(<AccountSecondFactorCard />);

    await userEvent.type(screen.getByLabelText(a.accountFactorEmail), 'holder@example.test');
    await userEvent.click(screen.getByRole('button', { name: a.accountFactorRemove }));

    expect(remove).not.toHaveBeenCalled();
    expect(
      screen.getByText('Switch two-step sign-in off for holder@example.test?'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: a.accountFactorConfirmButton }));

    expect(remove).toHaveBeenCalledWith('holder@example.test');
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Two-step sign-in is off for holder@example.test.',
    );
  });

  it('does nothing when the operator thinks better of it', async () => {
    const remove = vi.spyOn(adminApi, 'removeAccountSecondFactor');
    within(<AccountSecondFactorCard />);

    await userEvent.type(screen.getByLabelText(a.accountFactorEmail), 'holder@example.test');
    await userEvent.click(screen.getByRole('button', { name: a.accountFactorRemove }));
    await userEvent.click(screen.getByRole('button', { name: messages.common.cancel }));

    expect(remove).not.toHaveBeenCalled();
    expect(screen.getByLabelText(a.accountFactorEmail)).toHaveValue('holder@example.test');
  });

  it('says so when no account of that address has it', async () => {
    vi.spyOn(adminApi, 'removeAccountSecondFactor').mockRejectedValue(
      new ApiClientError(
        404,
        'SECOND_FACTOR_NOT_FOUND',
        'No account with that address has a second factor.',
      ),
    );
    within(<AccountSecondFactorCard />);

    await userEvent.type(screen.getByLabelText(a.accountFactorEmail), 'nobody@example.test');
    await userEvent.click(screen.getByRole('button', { name: a.accountFactorRemove }));
    await userEvent.click(screen.getByRole('button', { name: a.accountFactorConfirmButton }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      messages.errors.SECOND_FACTOR_NOT_FOUND,
    );
  });
});
