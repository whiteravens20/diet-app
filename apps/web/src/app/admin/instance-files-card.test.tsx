// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  adminApi,
  type InstanceDataState,
  type InstanceMirror,
  type ShipConfigDto,
} from '@/lib/admin-api';
import { ApiClientError } from '@/lib/http';
import en from '../../../messages/en.json';
import pl from '../../../messages/pl.json';
import { InstanceFilesCard, mirrorNeedsAttention } from './instance-files-card';

const text = en.admin.curation;
const mirrorText = en.admin.mirror;

const NOTHING: InstanceMirror = {
  state: 'off',
  failure: null,
  checkedAt: null,
  pushedAt: null,
  copy: null,
};

const REPORTED: InstanceMirror = {
  state: 'current',
  failure: null,
  checkedAt: '2026-10-31T11:30:00Z',
  pushedAt: '2026-10-30T18:02:00Z',
  copy: { version: '0.150.0', recipes: 183, names: 87 },
};

function shown(
  files: Partial<InstanceDataState> = {},
  mirror: InstanceMirror | null = NOTHING,
  messages: typeof en = en,
) {
  vi.spyOn(adminApi, 'shipConfig').mockResolvedValue({
    instanceData: {
      writable: true,
      recipeFiles: 1,
      recipes: 4,
      names: 2,
      version: null,
      notRestored: 0,
      ...files,
    },
  } as ShipConfigDto);
  return render(
    <NextIntlClientProvider locale={messages === en ? 'en' : 'pl'} messages={messages}>
      <InstanceFilesCard mirror={mirror} readAgain={null} onRestored={() => undefined} />
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the instance's own files, in the panel", () => {
  it('say which version of the application wrote them', async () => {
    shown({ version: '0.78.0' });

    expect(
      await screen.findByText('Written by version 0.78.0 of the application.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/earlier layout/)).toBeNull();
  });

  it('say that files of the earlier layout are to be restored before anything is written', async () => {
    shown({ notRestored: 2 });

    expect(
      await screen.findByText(/^2 files of the earlier layout hold recipes/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Written by version/)).toBeNull();
  });

  it('refuse in words a restore of files a newer version wrote', async () => {
    shown({ version: '9.0.0' });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(adminApi, 'restoreInstanceData').mockRejectedValue(
      new ApiClientError(409, 'INSTANCE_DATA_NEWER', 'Newer.'),
    );

    await userEvent.click(await screen.findByRole('button', { name: text.restoreButton }));

    expect(await screen.findByText(en.errors.INSTANCE_DATA_NEWER)).toBeInTheDocument();
  });
});

describe('the copy of the files in a repository, in the panel', () => {
  it('says the service does not run, and how it is turned on, without calling that a fault', async () => {
    shown({}, NOTHING);

    expect(await screen.findByText(mirrorText.state.off)).toBeInTheDocument();
    expect(screen.getByText(mirrorText.explain.off)).toBeInTheDocument();
    expect(screen.queryByText(mirrorText.logs)).toBeNull();
    expect(screen.queryByText(mirrorText.checkedAt)).toBeNull();
    expect(mirrorNeedsAttention(NOTHING)).toBe(false);
  });

  it('says it is up to date, when it last ran and pushed, and what the repository holds', async () => {
    shown({}, REPORTED);

    expect(await screen.findByText(mirrorText.state.current)).toBeInTheDocument();
    expect(screen.getByText(mirrorText.checkedAt)).toBeInTheDocument();
    expect(screen.getByText(mirrorText.pushedAt)).toBeInTheDocument();
    expect(screen.getByText('Recipes: 183 · names: 87 · version 0.150.0')).toBeInTheDocument();
    expect(mirrorNeedsAttention(REPORTED)).toBe(false);
  });

  it.each(['behind', 'empty'] as const)('calls the state %s no fault', async (state) => {
    const mirror = { ...REPORTED, state };
    shown({}, mirror);

    expect(await screen.findByText(mirrorText.state[state])).toBeInTheDocument();
    expect(screen.getByText(mirrorText.explain[state])).toBeInTheDocument();
    expect(screen.queryByText(mirrorText.logs)).toBeNull();
    expect(mirrorNeedsAttention(mirror)).toBe(false);
  });

  it.each(['clone', 'foreign', 'unreachable', 'push'] as const)(
    'says why a round failed in its own words: %s, and where to read more',
    async (failure) => {
      const mirror = { ...REPORTED, state: 'failed' as const, failure };
      shown({}, mirror);

      expect(await screen.findByText(mirrorText.state.failed)).toBeInTheDocument();
      expect(screen.getByText(mirrorText.failure[failure])).toBeInTheDocument();
      expect(screen.getByText(mirrorText.logs)).toBeInTheDocument();
      expect(mirrorNeedsAttention(mirror)).toBe(true);
    },
  );

  it.each(['silent', 'unreadable'] as const)('calls the state %s a fault', async (state) => {
    const mirror = { ...REPORTED, state };
    shown({}, mirror);

    expect(await screen.findByText(mirrorText.explain[state])).toBeInTheDocument();
    expect(mirrorNeedsAttention(mirror)).toBe(true);
  });

  it('says there was no push yet where the service knows of none', async () => {
    shown({}, { ...REPORTED, state: 'failed', failure: 'clone', pushedAt: null, copy: null });

    expect(await screen.findByText(mirrorText.none)).toBeInTheDocument();
  });

  it('is said in the language of the application', async () => {
    shown({}, REPORTED, pl as unknown as typeof en);

    expect(await screen.findByText(pl.admin.mirror.state.current)).toBeInTheDocument();
    expect(screen.getByText('Przepisy: 183 · nazwy: 87 · wersja 0.150.0')).toBeInTheDocument();
  });

  it('waits to be read: nothing is said of it before that', async () => {
    shown({}, null);

    await screen.findByText(text.restoreButton);
    expect(screen.queryByText(mirrorText.title)).toBeNull();
  });
});
