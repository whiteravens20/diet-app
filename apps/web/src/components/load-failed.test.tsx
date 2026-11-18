// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '@/lib/http';
import messages from '../../messages/en.json';
import { LoadFailed, ReadsFailed, type Read } from './load-failed';

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

/** A read as a page holds it: `data` is what its last answer brought, `isError` whether its last try failed. */
const aRead = (over: Partial<Read> = {}): Read => ({
  isError: false,
  error: null,
  data: undefined,
  isPlaceholderData: false,
  refetch: vi.fn(),
  ...over,
});

const NETWORK = new ApiClientError(0, 'NETWORK', 'Failed to fetch');

function noted(reads: Read[], unanswered = false) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ReadsFailed reads={reads} unanswered={unanswered} />
    </NextIntlClientProvider>,
  );
}

describe('reads that failed', () => {
  it('says nothing while every read holds its answer', () => {
    const { container } = noted([aRead({ data: [] }), aRead({ data: { id: 1 } })]);

    expect(container).toBeEmptyDOMElement();
  });

  it('leaves a read that failed with nothing to show to the place that shows it', () => {
    const { container } = noted([aRead({ isError: true, error: NETWORK })]);

    expect(container).toBeEmptyDOMElement();
  });

  it('says why, that what is seen was loaded earlier, and reads again every read that failed', async () => {
    const failed = aRead({ isError: true, error: NETWORK, data: [] });
    const other = aRead({ isError: true, error: NETWORK, data: { id: 1 } });
    const fine = aRead({ data: [] });
    noted([failed, other, fine]);

    expect(screen.getByRole('alert')).toHaveTextContent(messages.errors.NETWORK);
    expect(screen.getByRole('alert')).toHaveTextContent(messages.common.shownFromBefore);
    await userEvent.click(screen.getByRole('button', { name: messages.common.retry }));
    expect(failed.refetch).toHaveBeenCalledTimes(1);
    expect(other.refetch).toHaveBeenCalledTimes(1);
    expect(fine.refetch).not.toHaveBeenCalled();
  });

  it('does not take what stands in for an answer while the next one is read for an answer of its own', () => {
    const { container } = noted([
      aRead({ isError: true, error: NETWORK, data: [], isPlaceholderData: true }),
    ]);

    expect(container).toBeEmptyDOMElement();
  });

  it('says why a read never came where the place is this note, and no more than that', () => {
    noted([aRead({ isError: true, error: NETWORK })], true);

    expect(screen.getByRole('alert')).toHaveTextContent(messages.errors.NETWORK);
    expect(screen.getByRole('alert')).not.toHaveTextContent(messages.common.shownFromBefore);
  });
});
