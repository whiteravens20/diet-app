// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { ApiClientError } from '@/lib/http';
import * as files from '@/lib/save-file';
import messages from '../../../../messages/en.json';
import { DataExportCard } from './data-export-card';

const texts = messages.settings;

/** The card, with the API answering the file as `answer` gives it. */
function shown(answer: () => Promise<Blob>) {
  const download = vi.spyOn(api, 'download').mockImplementation(answer);
  const saved = vi.spyOn(files, 'saveFile').mockImplementation(() => undefined);
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <QueryClientProvider client={new QueryClient()}>
        <DataExportCard />
      </QueryClientProvider>
    </NextIntlClientProvider>,
  );
  return {
    download,
    saved,
    ask: () => userEvent.click(screen.getByRole('button', { name: texts.dataExportButton })),
  };
}

const aFile = (text: string): Blob => new Blob([text], { type: 'application/json' });

describe('the card that hands an account everything it holds', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('asks the API for the file and hands it to the browser under a name with the day in it', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-01-05T12:00:00') });
    const whole = aFile('{"format":"diet-app/account/1","profiles":[],"complete":true}');
    const { download, saved, ask } = shown(() => Promise.resolve(whole));

    await ask();

    expect(download).toHaveBeenCalledWith('/users/me/export');
    await vi.waitFor(() =>
      expect(saved).toHaveBeenCalledWith(whole, 'diet-app-account-2026-01-05.json'),
    );
    expect(await screen.findByText(texts.dataExportSaved)).toBeInTheDocument();
  });

  it('does not hand on a file that was cut short on its way, and says so', async () => {
    const { saved, ask } = shown(() =>
      Promise.resolve(aFile('{"format":"diet-app/account/1","profiles":[{"id":"6f1c')),
    );

    await ask();

    expect(await screen.findByRole('alert')).toHaveTextContent(texts.dataExportFailed);
    expect(saved).not.toHaveBeenCalled();
    expect(screen.queryByText(texts.dataExportSaved)).toBeNull();
  });

  it('says how long to wait when the file was asked for too often', async () => {
    const { saved, ask } = shown(() =>
      Promise.reject(new ApiClientError(429, 'TOO_MANY_REQUESTS', 'slow down', undefined, 1500)),
    );

    await ask();

    expect(await screen.findByRole('alert')).toHaveTextContent(/25 minutes/);
    expect(saved).not.toHaveBeenCalled();
  });

  it('can be asked again after a failure', async () => {
    let fails = true;
    const whole = aFile('{"complete":true}');
    const { saved, ask } = shown(() =>
      fails ? Promise.reject(new Error('no answer')) : Promise.resolve(whole),
    );

    await ask();
    await screen.findByRole('alert');
    fails = false;
    await ask();

    await vi.waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
