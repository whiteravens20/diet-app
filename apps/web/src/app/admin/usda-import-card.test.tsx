// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminApi, type UsdaImportRunnerState } from '@/lib/admin-api';
import messages from '../../../messages/en.json';
import { UsdaImportCard } from './usda-import-card';

const idle: UsdaImportRunnerState = {
  status: 'idle',
  startedAt: null,
  finishedAt: null,
  page: null,
  totalPages: null,
  kept: 0,
  skipped: 0,
  excluded: 0,
  refused: 0,
  dataTypes: null,
  demoKey: false,
  result: null,
  error: null,
  errorReason: null,
  retryAfterSeconds: null,
};

/** The card as the panel shows it after a run that ended in `state`. */
async function renderAfter(state: Partial<UsdaImportRunnerState>) {
  vi.spyOn(adminApi, 'usdaImportStatus').mockResolvedValue({ ...idle, ...state });
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <UsdaImportCard onFinished={() => Promise.resolve()} />
    </NextIntlClientProvider>,
  );
  // The state arrives after the first render.
  await screen.findByRole('button', { name: messages.admin.usda.runImport });
}

const failed = (errorReason: UsdaImportRunnerState['errorReason'], more: Partial<UsdaImportRunnerState> = {}) =>
  renderAfter({ status: 'error', error: 'FDC API 429 on page 1', errorReason, ...more });

describe('the food import card', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('says when to try again once the key has had its requests, and what allows more', async () => {
    await failed('over_limit', { retryAfterSeconds: 649 });

    expect(
      await screen.findByText(
        'The food database takes no more requests for this key right now. Try again in about 11 minutes, or set FDC_API_KEY in .env: a free key of your own allows far more.',
      ),
    ).toBeInTheDocument();
    // What the source said stays readable as detail.
    expect(screen.getByText('FDC API 429 on page 1')).toBeInTheDocument();
  });

  it('says to try again later when the source named no wait', async () => {
    await failed('over_limit');

    expect(await screen.findByText(/Try again later, or set FDC_API_KEY/)).toBeInTheDocument();
  });

  it('says what to do about a key the source refuses', async () => {
    await failed('key_refused', { error: 'FDC API 403 on page 1' });

    expect(await screen.findByText('The food database refused the key. Check FDC_API_KEY in .env, then restart the API.')).toBeInTheDocument();
  });

  it('says nothing was changed when the source cannot be reached', async () => {
    await failed('unavailable', { error: 'FDC API did not answer on page 1: fetch failed' });

    expect(await screen.findByText('The food database failed or did not answer. Nothing was changed; try again later.')).toBeInTheDocument();
  });

  it('says how to let the API write when its data directory is closed to it', async () => {
    await failed('not_writable', { error: 'Cannot write to /app/data' });

    expect(await screen.findByText(/make it writable for the user the container runs as \(chown 1000 data\)/)).toBeInTheDocument();
    expect(screen.getByText('Cannot write to /app/data')).toBeInTheDocument();
  });

  it('shows the API\'s own words for a failure nobody foresaw', async () => {
    await failed('failed', { error: 'Unexpected end of JSON input' });

    expect(await screen.findByText('Import failed: Unexpected end of JSON input')).toBeInTheDocument();
    expect(screen.getAllByText(/Unexpected end of JSON input/)).toHaveLength(1);
  });
});
