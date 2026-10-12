// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminApi, type DraftRunnerState } from '@/lib/admin-api';
import { ApiClientError } from '@/lib/http';
import messages from '../../../messages/en.json';
import { MissingLanguage } from './missing-language';

const text = messages.admin.curation.missingLanguage;
const idle: DraftRunnerState = {
  status: 'idle',
  startedAt: null,
  finishedAt: null,
  processed: 0,
  total: 0,
  failed: 0,
  written: 0,
  provider: null,
  model: null,
  batchId: null,
  error: null,
  skipped: 0,
  note: null,
  configured: true,
};

/** The section as the panel shows it while the run stands as `state`. */
async function renderWith(state: Partial<DraftRunnerState> = {}) {
  const status = vi.spyOn(adminApi, 'translationsStatus').mockResolvedValue({ ...idle, ...state });
  const onWritten = vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <MissingLanguage onWritten={onWritten} />
    </NextIntlClientProvider>,
  );
  await vi.waitFor(() => expect(status).toHaveBeenCalled());
  await screen.findByRole('button', { name: new RegExp(`^(${text.start}|Writing )`) });
  return { status, onWritten };
}

describe('the run that fills a language recipes lack, in the panel', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('offers the languages a recipe can lack, English not among them, and says what the run does and does not touch', async () => {
    await renderWith();

    const languages = screen.getByRole('combobox', { name: text.language });
    expect([...languages.querySelectorAll('option')].map((option) => option.textContent)).toEqual(['Polish']);
    expect(screen.getByRole('region', { name: text.title })).toHaveTextContent("Recipes of the catalogue's own data are left as they are.");
    expect(screen.getByRole('spinbutton', { name: text.limit })).toHaveValue(25);
  });

  it('starts the run for the language and the number that were chosen', async () => {
    const start = vi.spyOn(adminApi, 'startTranslations').mockResolvedValue({ ...idle, status: 'running', total: 3 });
    await renderWith();

    await userEvent.clear(screen.getByRole('spinbutton', { name: text.limit }));
    await userEvent.type(screen.getByRole('spinbutton', { name: text.limit }), '3');
    await userEvent.click(screen.getByRole('button', { name: text.start }));

    expect(start).toHaveBeenCalledExactlyOnceWith({ locale: 'pl', limit: 3 });
    expect(await screen.findByRole('button', { name: 'Writing 0 of 3…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: messages.admin.curation.stop })).toBeEnabled();
  });

  it('asks for no more than a run takes on, and for one where nothing sensible was typed', async () => {
    const start = vi.spyOn(adminApi, 'startTranslations').mockResolvedValue({ ...idle, status: 'done', note: 'nothing-to-translate' });
    await renderWith();
    const most = screen.getByRole('spinbutton', { name: text.limit });

    await userEvent.clear(most);
    await userEvent.type(most, '5000');
    await userEvent.click(screen.getByRole('button', { name: text.start }));
    await userEvent.clear(most);
    await userEvent.click(screen.getByRole('button', { name: text.start }));

    expect(start.mock.calls.map(([spec]) => spec.limit)).toEqual([200, 1]);
    expect(most).toHaveValue(1);
  });

  it('follows a run to its end, says what it wrote and has the queue read again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { status, onWritten } = await renderWith({ status: 'running', processed: 1, total: 3 });
    status.mockResolvedValue({ ...idle, status: 'done', processed: 3, total: 3, written: 2, failed: 1 });

    await vi.advanceTimersByTimeAsync(1600);

    expect(await screen.findByText('Last run: 2 texts written, 1 failed.')).toBeInTheDocument();
    expect(onWritten).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: text.start })).toBeEnabled();
  });

  it('says so when nothing lacks the language', async () => {
    await renderWith({ status: 'done', note: 'nothing-to-translate' });

    expect(screen.getByRole('status')).toHaveTextContent(messages.admin.curation.runNotes['nothing-to-translate']);
  });

  it('says how a run failed, and stops one that runs', async () => {
    const stop = vi.spyOn(adminApi, 'stopTranslations').mockResolvedValue({ ...idle, status: 'error', error: 'AI_DEFAULT_PROVIDER / AI_DEFAULT_MODEL not configured' });
    await renderWith({ status: 'running', processed: 0, total: 2 });

    await userEvent.click(screen.getByRole('button', { name: messages.admin.curation.stop }));

    expect(stop).toHaveBeenCalledOnce();
    expect(await screen.findByText('The run failed: AI_DEFAULT_PROVIDER / AI_DEFAULT_MODEL not configured')).toBeInTheDocument();
  });

  it('cannot be started where the operator set no model, and says why a start was refused', async () => {
    await renderWith({ configured: false });
    expect(screen.getByRole('button', { name: text.start })).toBeDisabled();
  });

  it('says that a run is under way already when another was asked for', async () => {
    vi.spyOn(adminApi, 'startTranslations').mockRejectedValue(new ApiClientError(409, 'TRANSLATIONS_IN_PROGRESS', 'A run that fills a language is already in progress.'));
    await renderWith();

    await userEvent.click(screen.getByRole('button', { name: text.start }));

    expect(await screen.findByText(messages.errors.TRANSLATIONS_IN_PROGRESS)).toBeInTheDocument();
  });
});
