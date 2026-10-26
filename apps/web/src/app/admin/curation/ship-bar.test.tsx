// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminApi, type InstanceDataState, type ShipConfigDto } from '@/lib/admin-api';
import { ApiClientError } from '@/lib/http';
import messages from '../../../../messages/en.json';
import { ShipBar } from './ship-bar';

const text = messages.admin.curation;

/** The panel's answer about shipping, with the instance's files as `files` say. */
const configWith = (files: Partial<InstanceDataState> = {}): ShipConfigDto =>
  ({
    modes: { local: { available: true }, bundle: { available: true } },
    pull: { available: true, defaultSource: '', tokenSet: false },
    instanceData: {
      writable: true,
      recipeFiles: 1,
      recipes: 4,
      names: 2,
      version: null,
      notRestored: 0,
      ...files,
    },
    approvedCounts: { recipe: 1, ingredientName: 0 },
  }) as ShipConfigDto;

function shown(files: Partial<InstanceDataState> = {}) {
  vi.spyOn(adminApi, 'shipConfig').mockResolvedValue(configWith(files));
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ShipBar kind="recipe" onShipped={() => {}} />
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

  it('say so when a ship went through but the files were not written for that reason', async () => {
    shown();
    vi.spyOn(adminApi, 'ship').mockResolvedValue({
      mode: 'local',
      kind: 'recipe',
      shippedDraftIds: ['d1'],
      skipped: [],
      sidecarPaths: [],
      sidecarError: 'files-not-restored',
    });

    await userEvent.click(
      await screen.findByRole('button', { name: new RegExp(text.shipModeLocal) }),
    );

    expect(await screen.findByText(text.shipFilesNotRestored)).toBeInTheDocument();
  });

  it('say which files a ship wrote', async () => {
    shown();
    vi.spyOn(adminApi, 'ship').mockResolvedValue({
      mode: 'local',
      kind: 'recipe',
      shippedDraftIds: ['d1'],
      skipped: [],
      sidecarPaths: ['recipes/library.json', 'ingredient-overrides.json', 'manifest.json'],
    });

    await userEvent.click(
      await screen.findByRole('button', { name: new RegExp(text.shipModeLocal) }),
    );

    expect(
      await screen.findByText(
        "Written to the instance's data directory: recipes/library.json, ingredient-overrides.json, manifest.json",
      ),
    ).toBeInTheDocument();
  });

  it('refuse in words a restore of files a newer version wrote', async () => {
    shown({ version: '9.0.0' });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(adminApi, 'restoreInstanceData').mockRejectedValue(
      new ApiClientError(409, 'INSTANCE_DATA_NEWER', 'Newer.'),
    );

    await userEvent.click(await screen.findByRole('button', { name: text.restoreButton }));

    expect(await screen.findByText(messages.errors.INSTANCE_DATA_NEWER)).toBeInTheDocument();
  });
});
