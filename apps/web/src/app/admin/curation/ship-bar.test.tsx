// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminApi, type InstanceDataState, type ShipConfigDto } from '@/lib/admin-api';
import messages from '../../../../messages/en.json';
import { ShipBar } from './ship-bar';

const text = messages.admin.curation;

/** The panel's answer about shipping, with the instance's files as `files` say. */
const configWith = (files: Partial<InstanceDataState> = {}): ShipConfigDto =>
  ({
    modes: { local: { available: true }, bundle: { available: true } },
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
      <ShipBar kind="recipe" onShipped={() => {}} listRead={0} />
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the count of what waits to be shipped', () => {
  it('is read again whenever the drafts beside the bar are, so a decision on one shows in it', async () => {
    const config = vi
      .spyOn(adminApi, 'shipConfig')
      .mockResolvedValueOnce({ ...configWith(), approvedCounts: { recipe: 0, ingredientName: 0 } })
      .mockResolvedValueOnce({ ...configWith(), approvedCounts: { recipe: 1, ingredientName: 0 } });
    const bar = (listRead: number) => (
      <NextIntlClientProvider locale="en" messages={messages}>
        <ShipBar kind="recipe" onShipped={() => {}} listRead={listRead} />
      </NextIntlClientProvider>
    );
    const { rerender } = render(bar(0));
    expect(await screen.findByText('0 approved')).toBeInTheDocument();

    // A draft was approved, and the panel read its drafts again.
    rerender(bar(1));

    expect(await screen.findByText('1 approved')).toBeInTheDocument();
    expect(config).toHaveBeenCalledTimes(2);
  });
});

describe('the bar, one row until more is asked for', () => {
  it('shows the ship into this instance, and has the file for a repository a press further', async () => {
    shown();

    expect(
      await screen.findByRole('button', { name: new RegExp(text.shipModeLocal) }),
    ).toBeEnabled();
    expect(screen.queryByRole('button', { name: new RegExp(text.shipModeBundle) })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: text.shipMore, expanded: false }));

    expect(screen.getByRole('button', { name: text.shipMore, expanded: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: new RegExp(text.shipModeBundle) })).toBeEnabled();
    expect(screen.getByText(text.shipExplain)).toBeVisible();
  });
});

describe("what a ship did with the instance's own files", () => {
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
});
