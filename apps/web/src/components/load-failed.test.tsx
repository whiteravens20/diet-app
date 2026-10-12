// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '@/lib/http';
import messages from '../../messages/en.json';
import { LoadFailed } from './load-failed';

function shown(error: unknown) {
  const onRetry = vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <LoadFailed error={error} onRetry={onRetry} />
    </NextIntlClientProvider>,
  );
  return onRetry;
}

describe('a page whose content could not be loaded', () => {
  it('says why, in the words of the application', () => {
    shown(new ApiClientError(0, 'NETWORK', 'Failed to fetch'));

    expect(screen.getByRole('alert')).toHaveTextContent(messages.errors.NETWORK);
  });

  it('says that something went wrong when it does not know more', () => {
    shown(new Error('boom'));

    expect(screen.getByRole('alert')).toHaveTextContent(messages.common.error);
  });

  it('offers to try again', async () => {
    const onRetry = shown(new ApiClientError(503, 'SERVER_BUSY', 'busy'));

    await userEvent.click(screen.getByRole('button', { name: messages.common.retry }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
