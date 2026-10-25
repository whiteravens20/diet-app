// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SecondFactorState } from '@diet-app/shared';
import { api } from '@/lib/api';
import { ApiClientError } from '@/lib/http';
import messages from '../../../../messages/en.json';
import { SecondFactorCard } from './second-factor-card';

const m = messages.secondFactor;
const OFF: SecondFactorState = { enabled: false, since: null, recoveryCodesLeft: 0 };
const ON: SecondFactorState = {
  enabled: true,
  since: '2026-01-05T08:00:00.000Z',
  recoveryCodesLeft: 10,
};
const SETUP = {
  secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
  uri: 'otpauth://totp/Diet%20App:holder%40example.test?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
  enrolment: 'sealed',
  expiresIn: 900,
};
const CODES = [
  'AAAAA-11111',
  'BBBBB-22222',
  'CCCCC-33333',
  'DDDDD-44444',
  'EEEEE-55555',
  'FFFFF-66666',
  'GGGGG-77777',
  'HHHHH-88888',
  'JJJJJ-99999',
  'KKKKK-00000',
];

/** The card of an account whose two-step sign-in is as `state` says, and after a change as `then` says. */
function shown(state: SecondFactorState, then: SecondFactorState = state) {
  const get = vi
    .spyOn(api, 'get')
    .mockResolvedValueOnce(state as never)
    .mockResolvedValue(then as never);
  const post = vi.spyOn(api, 'post');
  const remove = vi.spyOn(api, 'delete').mockResolvedValue(undefined as never);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The list of sessions the settings page shows beside the card, as it was loaded.
  client.setQueryData(['sessions'], []);
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <QueryClientProvider client={client}>
        <SecondFactorCard />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  return { get, post, remove, client };
}

describe('two-step sign-in in the settings of an account', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('says that it is off, and offers to set it up', async () => {
    shown(OFF);

    expect(await screen.findByText(m.isOff)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: m.setUp })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: m.switchOff })).toBeNull();
  });

  it('sets it up: the password, then the code to scan with the key to type, then the first code from the app', async () => {
    const { post } = shown(OFF, ON);
    post
      .mockResolvedValueOnce(SETUP as never)
      .mockResolvedValueOnce({ recoveryCodes: CODES } as never);

    await userEvent.click(await screen.findByRole('button', { name: m.setUp }));
    await userEvent.type(screen.getByLabelText(m.password), 'a-password');
    await userEvent.click(screen.getByRole('button', { name: m.continue }));

    expect(await screen.findByTitle(m.qrLabel)).toBeInTheDocument();
    expect(screen.getByTestId('authenticator-key')).toHaveTextContent(
      'GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ',
    );
    expect(post).toHaveBeenLastCalledWith('/users/me/second-factor/setup', {
      currentPassword: 'a-password',
    });

    await userEvent.type(screen.getByLabelText(m.code, { exact: false }), '123456');
    await userEvent.click(screen.getByRole('button', { name: m.switchOn }));

    expect(post).toHaveBeenLastCalledWith('/users/me/second-factor', {
      enrolment: 'sealed',
      code: '123456',
    });
    expect(await screen.findByText(m.onNow)).toBeInTheDocument();
  });

  it('has the list of sessions read again once it is on: the other sessions have ended', async () => {
    const { post, client } = shown(OFF, ON);
    post
      .mockResolvedValueOnce(SETUP as never)
      .mockResolvedValueOnce({ recoveryCodes: CODES } as never);

    await userEvent.click(await screen.findByRole('button', { name: m.setUp }));
    await userEvent.type(screen.getByLabelText(m.password), 'a-password');
    await userEvent.click(screen.getByRole('button', { name: m.continue }));
    expect(client.getQueryState(['sessions'])?.isInvalidated).toBe(false);
    await userEvent.type(await screen.findByLabelText(m.code, { exact: false }), '123456');
    await userEvent.click(screen.getByRole('button', { name: m.switchOn }));
    await screen.findByText(m.onNow);

    expect(client.getQueryState(['sessions'])?.isInvalidated).toBe(true);
  });

  it('shows the ten recovery codes once, and can copy them', async () => {
    const { post } = shown(OFF, ON);
    post
      .mockResolvedValueOnce(SETUP as never)
      .mockResolvedValueOnce({ recoveryCodes: CODES } as never);
    const written = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: written } });
    await userEvent.click(await screen.findByRole('button', { name: m.setUp }));
    await userEvent.type(screen.getByLabelText(m.password), 'a-password');
    await userEvent.click(screen.getByRole('button', { name: m.continue }));
    await userEvent.type(await screen.findByLabelText(m.code, { exact: false }), '123456');
    await userEvent.click(screen.getByRole('button', { name: m.switchOn }));

    const list = await screen.findByRole('list', { name: m.recoveryTitle });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(CODES);
    await userEvent.click(screen.getByRole('button', { name: m.copy }));
    expect(written).toHaveBeenCalledWith(CODES.join('\n'));
    expect(await screen.findByRole('status')).toHaveTextContent(m.copied);

    await userEvent.click(screen.getByRole('button', { name: m.saved }));
    expect(screen.queryByText(CODES[0]!)).toBeNull();
    expect(await screen.findByText('On since Jan 5, 2026.')).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it('says what was wrong with the password or the code, and stays where it was', async () => {
    const { post } = shown(OFF);
    post.mockRejectedValueOnce(
      new ApiClientError(401, 'INVALID_PASSWORD', 'Current password is incorrect.'),
    );

    await userEvent.click(await screen.findByRole('button', { name: m.setUp }));
    await userEvent.type(screen.getByLabelText(m.password), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: m.continue }));
    expect(await screen.findByRole('alert')).toHaveTextContent(messages.errors.INVALID_PASSWORD);

    post
      .mockResolvedValueOnce(SETUP as never)
      .mockRejectedValueOnce(
        new ApiClientError(401, 'INVALID_SECOND_FACTOR_CODE', 'That code is not right.'),
      );
    await userEvent.click(screen.getByRole('button', { name: m.continue }));
    await userEvent.type(await screen.findByLabelText(m.code, { exact: false }), '000000');
    await userEvent.click(screen.getByRole('button', { name: m.switchOn }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      messages.errors.INVALID_SECOND_FACTOR_CODE,
    );
    expect(screen.getByTestId('authenticator-key')).toBeInTheDocument();
  });

  it('begins again when the set-up ran out', async () => {
    const { post } = shown(OFF);
    post
      .mockResolvedValueOnce(SETUP as never)
      .mockRejectedValueOnce(
        new ApiClientError(400, 'SECOND_FACTOR_SETUP_EXPIRED', 'This set-up has run out.'),
      );

    await userEvent.click(await screen.findByRole('button', { name: m.setUp }));
    await userEvent.type(screen.getByLabelText(m.password), 'a-password');
    await userEvent.click(screen.getByRole('button', { name: m.continue }));
    await userEvent.type(await screen.findByLabelText(m.code, { exact: false }), '123456');
    await userEvent.click(screen.getByRole('button', { name: m.switchOn }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      messages.errors.SECOND_FACTOR_SETUP_EXPIRED,
    );
    expect(screen.getByRole('button', { name: m.setUp })).toBeInTheDocument();
  });

  it('says since when it is on and how many recovery codes are left, and warns when they are few', async () => {
    shown({ ...ON, recoveryCodesLeft: 2 });

    expect(await screen.findByText('On since Jan 5, 2026.')).toBeInTheDocument();
    expect(screen.getByText(`Recovery codes left: 2. ${m.codesLow}`)).toBeInTheDocument();
  });

  it('switches it off for the password and a code', async () => {
    const { remove } = shown(ON, OFF);

    await userEvent.click(await screen.findByRole('button', { name: m.switchOff }));
    expect(screen.getByText(m.switchOffBody)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(m.password), 'a-password');
    await userEvent.type(screen.getByLabelText(m.codeOrRecovery), 'AAAAA-11111');
    await userEvent.click(screen.getByRole('button', { name: m.switchOff }));

    expect(remove).toHaveBeenCalledWith('/users/me/second-factor', {
      currentPassword: 'a-password',
      code: 'AAAAA-11111',
    });
    expect(await screen.findByText(m.isOff)).toBeInTheDocument();
  });

  it('replaces the recovery codes for the password and a code, and shows the new ones', async () => {
    const { post } = shown(ON);
    post.mockResolvedValueOnce({ recoveryCodes: CODES } as never);

    await userEvent.click(await screen.findByRole('button', { name: m.newCodes }));
    expect(screen.getByText(m.newCodesBody)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(m.password), 'a-password');
    await userEvent.type(screen.getByLabelText(m.codeOrRecovery), '123456');
    await userEvent.click(screen.getByRole('button', { name: m.newCodes }));

    expect(post).toHaveBeenCalledWith('/users/me/second-factor/recovery-codes', {
      currentPassword: 'a-password',
      code: '123456',
    });
    expect(await screen.findByText(CODES[9]!)).toBeInTheDocument();
    // Not the note of a factor that was just switched on.
    expect(screen.queryByText(m.onNow)).toBeNull();
  });

  it('says how long codes have to wait after too many wrong ones', async () => {
    const { remove } = shown(ON);
    remove.mockRejectedValueOnce(
      new ApiClientError(429, 'TOO_MANY_ATTEMPTS', 'Too many wrong codes.', undefined, 30),
    );

    await userEvent.click(await screen.findByRole('button', { name: m.switchOff }));
    await userEvent.type(screen.getByLabelText(m.password), 'a-password');
    await userEvent.type(screen.getByLabelText(m.codeOrRecovery), '000000');
    await userEvent.click(screen.getByRole('button', { name: m.switchOff }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many attempts. Try again in 30 seconds.',
    );
  });
});
