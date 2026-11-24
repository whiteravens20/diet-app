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

describe('a recipe draft a ship held back', () => {
  it('is named with every reason it was held back for, one after another', async () => {
    shown();
    vi.spyOn(adminApi, 'ship').mockResolvedValue({
      mode: 'local',
      kind: 'recipe',
      shippedDraftIds: [],
      skipped: [
        {
          draftId: 'd1',
          slug: 'yogurt-with-walnuts',
          reasons: [
            'facts-moved-since-review: calories 320 → 331',
            'title-taken: Greek yogurt with almonds & honey',
          ],
        },
      ],
      sidecarPaths: [],
    });

    await userEvent.click(
      await screen.findByRole('button', { name: new RegExp(text.shipModeLocal) }),
    );

    expect(await screen.findByRole('listitem')).toHaveTextContent(
      'yogurt-with-walnuts — its figures changed since it was reviewed (calories 320 → 331); save it again and have it approved; another recipe of the library is already called “Greek yogurt with almonds & honey”',
    );
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

describe('the names of ingredients the catalogue does not have, which a ship left in the queue', () => {
  /** The bar of names, after a ship into this instance that held `skipped` back. */
  async function shipped(skipped: { draftId: string; slug: string; reasons: string[] }[]) {
    vi.spyOn(adminApi, 'shipConfig').mockResolvedValue({
      ...configWith(),
      approvedCounts: { recipe: 0, ingredientName: skipped.length },
    });
    vi.spyOn(adminApi, 'ship').mockResolvedValue({
      mode: 'local',
      kind: 'ingredient-name',
      shippedDraftIds: [],
      skipped,
      sidecarPaths: [],
    });
    const onShipped = vi.fn();
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ShipBar kind="ingredient-name" onShipped={onShipped} listRead={0} />
      </NextIntlClientProvider>,
    );
    await userEvent.click(
      await screen.findByRole('button', { name: new RegExp(text.shipModeLocal) }),
    );
    await screen.findByText(/stayed in the queue:$/);
    return { onShipped };
  }
  const fuji = {
    draftId: 'd1',
    slug: 'apples-fuji-with-skin-raw',
    reasons: ['unknown-slug: apples-fuji-with-skin-raw'],
  };

  it('go, every draft of them, once it is said how many and that it cannot be undone', async () => {
    const { onShipped } = await shipped([fuji]);
    // The queue holds 56 such drafts, whatever their decision.
    const overview = vi.spyOn(adminApi, 'overview').mockResolvedValue({
      names: {
        missing: 0,
        rejected: 0,
        pending: 0,
        unapproved: 0,
        approved: 56,
        withoutIngredient: 56,
      },
      recipes: { pending: 0, approved: 0 },
    } as never);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const remove = vi
      .spyOn(adminApi, 'removeNamesWithoutIngredient')
      .mockResolvedValue({ removed: 56 });

    await userEvent.click(await screen.findByRole('button', { name: text.removeMissing }));

    expect(overview).toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledWith(
      'Remove 56\u00a0drafts of names of ingredients this instance\u2019s catalogue does not have? Approved, waiting and rejected; shipped ones stay. This cannot be undone.',
    );
    expect(remove).toHaveBeenCalledOnce();
    expect(await screen.findByRole('status')).toHaveTextContent('Removed 56 drafts.');
    expect(onShipped).toHaveBeenCalled();
  });

  it('are not removed when the word is taken back, and the button says when none are left', async () => {
    await shipped([fuji]);
    const remove = vi.spyOn(adminApi, 'removeNamesWithoutIngredient');
    vi.spyOn(adminApi, 'overview').mockResolvedValueOnce({
      names: {
        missing: 0,
        rejected: 0,
        pending: 0,
        unapproved: 0,
        approved: 1,
        withoutIngredient: 1,
      },
      recipes: { pending: 0, approved: 0 },
    } as never);
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    await userEvent.click(await screen.findByRole('button', { name: text.removeMissing }));
    expect(remove).not.toHaveBeenCalled();

    vi.spyOn(adminApi, 'overview').mockResolvedValueOnce({
      names: {
        missing: 0,
        rejected: 0,
        pending: 0,
        unapproved: 0,
        approved: 0,
        withoutIngredient: 0,
      },
      recipes: { pending: 0, approved: 0 },
    } as never);
    await userEvent.click(screen.getByRole('button', { name: text.removeMissing }));
    expect(await screen.findByRole('status')).toHaveTextContent(text.removeMissingNone);
    expect(remove).not.toHaveBeenCalled();
  });

  it('is offered only where a ship held back a name for that reason', async () => {
    await shipped([{ draftId: 'd2', slug: 'banana', reasons: ['not-approved: PENDING'] }]);

    expect(screen.queryByRole('button', { name: text.removeMissing })).toBeNull();
  });
});
