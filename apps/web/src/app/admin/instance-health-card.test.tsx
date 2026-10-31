// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import type { AdminHealth, InstanceMirror } from '@/lib/admin-api';
import en from '../../../messages/en.json';
import pl from '../../../messages/pl.json';
import { InstanceHealthCard } from './instance-health-card';

const t = en.admin.health;
const tMirror = en.admin.mirror;

const WELL: AdminHealth = {
  checkedAt: '2026-10-31T10:00:00.000Z',
  database: { up: true, pingMs: 2, bytes: 48 * 1_048_576 },
  worker: { state: 'ok', lastPassAt: '2026-10-31T09:00:00.000Z', failedJobs: 0 },
  api: { version: '0.150.0', startedAt: '2026-10-28T09:00:00.000Z', memoryBytes: 180 * 1_048_576 },
  requests: { counted: 1000, medianMs: 12, p95Ms: 80, serverErrors: 0 },
  ai: { configured: true, used: 12, limit: 300 },
  mail: { configured: true },
};

const COPIED: InstanceMirror = {
  state: 'current',
  failure: null,
  checkedAt: '2026-10-31T09:30:00Z',
  pushedAt: '2026-10-30T18:02:00Z',
  copy: { version: '0.150.0', recipes: 183, names: 87 },
};

function shown(
  over: Partial<AdminHealth> = {},
  mirror: InstanceMirror | null = COPIED,
  messages: typeof en = en,
) {
  const onRefresh = vi.fn();
  const onToCatalogue = vi.fn();
  render(
    <NextIntlClientProvider locale={messages === en ? 'en' : 'pl'} messages={messages}>
      <InstanceHealthCard
        health={{ ...WELL, ...over }}
        failed={false}
        mirror={mirror}
        onRefresh={onRefresh}
        onToCatalogue={onToCatalogue}
      />
    </NextIntlClientProvider>,
  );
  return { onRefresh, onToCatalogue };
}

describe('how the instance stands', () => {
  it('says all of it where all is well, the figures beside each', () => {
    shown();

    const beside = (label: string) => screen.getByText(label).parentElement!;
    expect(screen.getByText(tMirror.state.current)).toBeInTheDocument();
    expect(beside(t.database)).toHaveTextContent(t.databaseUp);
    expect(beside(t.api)).toHaveTextContent(t.apiUp);
    expect(screen.getByText(/^Answers in 2 ms · size 48/)).toBeInTheDocument();
    expect(beside(t.worker)).toHaveTextContent(t.workerOk);
    expect(
      screen.getByText(/^Version 0\.150\.0 · running since .* · memory 180/),
    ).toBeInTheDocument();
    expect(screen.getByText(t.requestsGood)).toBeInTheDocument();
    expect(
      screen.getByText('Half within 12 ms, 95% within 80 ms · server errors: 0 of the last 1,000'),
    ).toBeInTheDocument();
    expect(screen.getByText('12 of 300 in 30 days')).toBeInTheDocument();
    expect(screen.getByText(t.mailOn)).toBeInTheDocument();
  });

  it.each(['off', 'behind', 'empty', 'silent', 'unreadable'] as const)(
    'names the state of the copy on the overview, whichever it is: %s',
    (state) => {
      shown({}, { ...COPIED, state });

      expect(screen.getByText(tMirror.state[state])).toBeInTheDocument();
    },
  );

  it('says why a round of the copy failed, and leads to the catalogue', async () => {
    const { onToCatalogue } = shown({}, { ...COPIED, state: 'failed', failure: 'push' });

    expect(screen.getByText(tMirror.failure.push)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: en.admin.tabs.catalogue }));
    expect(onToCatalogue).toHaveBeenCalledTimes(1);
  });

  it('says a database that does not answer does not', () => {
    shown({ database: { up: false, pingMs: null, bytes: null } });

    expect(screen.getByText(t.databaseDown)).toBeInTheDocument();
    expect(screen.queryByText(/^Answers in/)).toBeNull();
  });

  it.each([
    [
      'failing',
      { state: 'failing', lastPassAt: WELL.worker.lastPassAt, failedJobs: 2 },
      t.workerFailing,
      '2 jobs failed in that pass.',
    ],
    [
      'silent',
      { state: 'silent', lastPassAt: WELL.worker.lastPassAt, failedJobs: 0 },
      t.workerSilent,
      t.workerSilentHint,
    ],
  ] as const)('says of scheduled tasks %s what to do', (_what, worker, state, detail) => {
    shown({ worker });

    expect(screen.getByText(state)).toBeInTheDocument();
    expect(screen.getByText(detail)).toBeInTheDocument();
    expect(screen.getByText(t.workerLogs)).toBeInTheDocument();
  });

  it('does not call scheduled tasks that never reported a fault, and asks nothing of the reader', () => {
    shown({ worker: { state: 'none', lastPassAt: null, failedJobs: 0 } });

    expect(screen.getByText(t.workerNone)).toBeInTheDocument();
    expect(screen.queryByText(t.workerLogs)).toBeNull();
  });

  it.each([
    [{ counted: 0, medianMs: null, p95Ms: null, serverErrors: 0 }, t.requestsNone],
    [{ counted: 500, medianMs: 12, p95Ms: 2000, serverErrors: 0 }, t.requestsGood],
    [{ counted: 500, medianMs: 12, p95Ms: 2001, serverErrors: 0 }, t.requestsSlow],
    [{ counted: 500, medianMs: 12, p95Ms: 80, serverErrors: 1 }, t.requestsErrors],
    [{ counted: 500, medianMs: 12, p95Ms: 5000, serverErrors: 1 }, t.requestsErrors],
  ])('judges the times %j', (requests, state) => {
    shown({ requests });

    expect(screen.getByText(state)).toBeInTheDocument();
  });

  it('says the AI is not set up, or that its limit is reached', () => {
    shown({ ai: { configured: false, used: 0, limit: 300 } });
    expect(screen.getByText(t.aiOff)).toBeInTheDocument();
  });

  it('says the limit of the AI is reached at the limit', () => {
    shown({ ai: { configured: true, used: 300, limit: 300 } });
    expect(screen.getByText('Limit reached: 300 of 300 in 30 days')).toBeInTheDocument();
  });

  it('says mail is not set up, and that is no fault', () => {
    shown({ mail: { configured: false } });
    expect(screen.getByText(t.mailOff)).toBeInTheDocument();
  });

  it('reads itself anew at a press', async () => {
    const { onRefresh } = shown();

    await userEvent.click(screen.getByRole('button', { name: t.refresh }));

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('says so when it could not be read', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <InstanceHealthCard
          health={null}
          failed
          mirror={null}
          onRefresh={() => undefined}
          onToCatalogue={() => undefined}
        />
      </NextIntlClientProvider>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(t.failed);
  });

  it('is said in the language of the application', () => {
    shown({}, COPIED, pl as unknown as typeof en);

    expect(screen.getByText(pl.admin.health.title)).toBeInTheDocument();
    expect(screen.getByText('12 z 300 w 30 dni')).toBeInTheDocument();
  });
});
