// Copyright (C) 2026 White Ravens. AGPL-3.0-only with an additional term; see LICENSE and NOTICE.

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DIET_TYPES, MEAL_SLOTS_BY_COUNT } from '@diet-app/shared/constants';
import { adminApi, type AdminHealth, type AdminOverview, type AdminStats } from '@/lib/admin-api';
import en from '../../../messages/en.json';
import pl from '../../../messages/pl.json';
import { AdminPanel } from './admin-panel';

/** What the API says of a panel nobody has set a password for: its own sentence, in English. */
const DISABLED = {
  enabled: false,
  message:
    'Admin panel is disabled. Set ADMIN_PASSWORD in .env to enable it, then restart the API.',
};

describe("the administrator's panel on an instance without an admin password", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['en', en],
    ['pl', pl],
  ] as const)(
    "says how to enable it in the language of the application (%s), not in the API's own words",
    async (locale, messages) => {
      vi.spyOn(adminApi, 'status').mockResolvedValue(DISABLED);
      const session = vi.spyOn(adminApi, 'session');

      render(
        <NextIntlClientProvider locale={locale} messages={messages}>
          <AdminPanel />
        </NextIntlClientProvider>,
      );

      expect(await screen.findByText(messages.admin.disabledHint)).toBeInTheDocument();
      expect(screen.getByText(messages.admin.disabled)).toBeInTheDocument();
      expect(screen.getByText(messages.admin.restartHint)).toBeInTheDocument();
      expect(screen.queryByText(DISABLED.message)).toBeNull();
      // A panel that does not exist is not asked for a session.
      expect(session).not.toHaveBeenCalled();
    },
  );
});

const byDietAndMeal = Object.fromEntries(
  DIET_TYPES.map((diet) => [
    diet,
    Object.fromEntries(MEAL_SLOTS_BY_COUNT[5]!.map((meal) => [meal, 0])),
  ]),
);

const STATS = {
  counts: { ingredients: 419, recipes: 183, substitutions: 8 },
  coverage: byDietAndMeal,
  coverageWaiting: byDietAndMeal,
  coverageTarget: 20,
  macros: {
    outOfReach: 0.1,
    diets: Object.fromEntries(
      DIET_TYPES.map((diet) => [
        diet,
        { target: { protein: 0.3, fat: 0.3, carbs: 0.4 }, reached: null },
      ]),
    ),
  },
  seed: {
    lastSeededAt: '2026-10-29T10:00:00.000Z',
    storedHash: 'a'.repeat(64),
    currentHash: 'a'.repeat(64),
    updateAvailable: false,
    files: [],
  },
} as unknown as AdminStats;

const NOTHING_WAITS: AdminOverview = {
  names: { missing: 0, rejected: 0, pending: 0, unapproved: 0, approved: 0 },
  recipes: { pending: 0, approved: 0 },
  mirror: { state: 'off', failure: null, checkedAt: null, pushedAt: null, copy: null },
};

const WAITING: AdminOverview = {
  ...NOTHING_WAITS,
  names: { missing: 12, rejected: 1, pending: 231, unapproved: 230, approved: 0 },
  recipes: { pending: 16, approved: 2 },
};

const HEALTH: AdminHealth = {
  checkedAt: '2026-10-31T10:00:00.000Z',
  database: { up: true, pingMs: 2, bytes: 48 * 1_048_576 },
  worker: { state: 'ok', lastPassAt: '2026-10-31T09:00:00.000Z', failedJobs: 0 },
  api: { version: '0.150.0', startedAt: '2026-10-28T09:00:00.000Z', memoryBytes: 180 * 1_048_576 },
  requests: { counted: 1000, medianMs: 12, p95Ms: 80, serverErrors: 0 },
  ai: { configured: true, used: 12, limit: 300 },
  mail: { configured: true },
};

const text = en.admin;

describe('the panel of a signed-in administrator, in parts', () => {
  /** The panel signed in, with `overview` waiting and the rest of what its parts read answering nothing much. */
  const signedIn = (
    { overview = WAITING, stats = STATS, retired = 0, address = '/admin' } = {} as {
      overview?: AdminOverview;
      stats?: AdminStats;
      retired?: number;
      address?: string;
    },
  ) => {
    window.history.replaceState(null, '', address);
    vi.spyOn(adminApi, 'status').mockResolvedValue({ enabled: true } as never);
    vi.spyOn(adminApi, 'session').mockResolvedValue({
      signedIn: true,
      secondFactor: false,
    } as never);
    vi.spyOn(adminApi, 'stats').mockResolvedValue(stats);
    vi.spyOn(adminApi, 'overview').mockResolvedValue(overview);
    vi.spyOn(adminApi, 'health').mockResolvedValue(HEALTH);
    vi.spyOn(adminApi, 'retiredIngredients').mockResolvedValue(
      Array.from({ length: retired }, (_, index) => ({
        id: `11111111-1111-4111-8111-11111111111${index}`,
        slug: 'nuts-almonds-whole-raw',
        name: 'Nuts, almonds, whole, raw',
        retiredAt: '2026-10-16T10:37:06.000Z',
        uses: {
          libraryRecipes: 0,
          ownRecipes: 1,
          drafts: 0,
          pantryRows: 0,
          profiles: 0,
          shoppingRows: 0,
        },
        usedIn: [],
      })),
    );
    // What the parts read when they are opened: they say themselves when it fails.
    const notLookedAt = new Error('not looked at here');
    vi.spyOn(adminApi, 'dbUpdateStatus').mockRejectedValue(notLookedAt);
    vi.spyOn(adminApi, 'shipConfig').mockRejectedValue(notLookedAt);
    vi.spyOn(adminApi, 'usdaImportStatus').mockRejectedValue(notLookedAt);
    vi.spyOn(adminApi, 'connection').mockRejectedValue(notLookedAt);
    vi.spyOn(adminApi, 'operatorAi').mockRejectedValue(notLookedAt);
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <AdminPanel />
      </NextIntlClientProvider>,
    );
  };
  const tab = (name: string | RegExp) =>
    screen.findByRole('tab', { name: typeof name === 'string' ? new RegExp(`^${name}`) : name });

  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('opens on the overview, with what the instance holds and what waits', async () => {
    signedIn();

    expect(await tab(text.tabs.overview)).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('419')).toBeInTheDocument();
    const shown = await screen.findByRole('button', { name: /231 names to judge/ });
    expect(shown).toBeInTheDocument();
    for (const line of [
      '1 rejected name waits for a new proposal',
      '12 ingredients without a proposed name',
      '16 recipes to judge',
      '2 approved recipes to ship',
    ]) {
      expect(screen.getByRole('button', { name: new RegExp(line) })).toBeInTheDocument();
    }
  });

  it('says how the instance stands on the overview, and reads it anew on coming back and at a press', async () => {
    signedIn();

    expect(await screen.findByText(text.health.title)).toBeVisible();
    expect(await screen.findByText(text.health.database)).toBeVisible();
    expect(screen.getByText(text.mirror.state.off)).toBeVisible();
    expect(adminApi.health).toHaveBeenCalledTimes(1);

    await userEvent.click(await tab(text.tabs.queue.slice(0, 5)));
    await userEvent.click(await tab(text.tabs.overview));
    await vi.waitFor(() => expect(adminApi.health).toHaveBeenCalledTimes(2));

    await userEvent.click(screen.getByRole('button', { name: text.health.refresh }));
    await vi.waitFor(() => expect(adminApi.health).toHaveBeenCalledTimes(3));
  });

  it('says so when how the instance stands cannot be read, and goes on working', async () => {
    signedIn();
    vi.mocked(adminApi.health).mockRejectedValue(new Error('no'));

    expect(await screen.findByText(text.health.failed)).toBeVisible();
    expect(await tab(text.tabs.overview)).toBeInTheDocument();
  });

  it('says how many wait on the queue, to the eye and to a screen reader', async () => {
    signedIn();

    // 231 + 1 + 0 names, 16 + 2 recipes.
    const queue = await tab(/^Queue, 250 wait/);
    expect(within(queue).getByText('250')).toHaveAttribute('aria-hidden', 'true');
  });

  it('marks the catalogue while something there wants attention, and not otherwise', async () => {
    signedIn({ overview: NOTHING_WAITS });
    expect(await tab(text.tabs.catalogue)).toBeInTheDocument();
    expect(await screen.findByText(text.overview.nothing)).toBeInTheDocument();
  });

  it.each([
    [
      'an update',
      {
        stats: { ...STATS, seed: { ...STATS.seed, updateAvailable: true } },
      },
      text.overview.updateAvailable,
    ],
    [
      'a copy that failed',
      {
        overview: {
          ...NOTHING_WAITS,
          mirror: { ...NOTHING_WAITS.mirror, state: 'failed', failure: 'push' },
        } as AdminOverview,
      },
      text.overview.mirrorProblem,
    ],
    ['a retired ingredient', { retired: 1 }, '1 retired ingredient still in use'],
  ])(
    'marks the catalogue for %s, and leads there from the overview',
    async (_what, given, line) => {
      signedIn(given);

      const press = await screen.findByRole('button', { name: new RegExp(line) });
      expect(await tab(/^Catalogue/)).toHaveAccessibleName(`Catalogue, ${text.tabs.attention}`);

      await userEvent.click(press);

      expect(await tab(/^Catalogue/)).toHaveAttribute('aria-selected', 'true');
      expect(window.location.search).toBe('?tab=catalogue');
    },
  );

  it('keeps the part chosen in the address, and takes it from there', async () => {
    signedIn({ address: '/admin?tab=security' });

    expect(await tab(text.tabs.security)).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText(text.sessionsTitle)).toBeVisible();

    await userEvent.click(await tab(text.tabs.overview));

    expect(window.location.search).toBe('');
    expect(screen.getByText(text.sessionsTitle)).not.toBeVisible();
  });

  it('takes no part the address names wrongly', async () => {
    signedIn({ address: '/admin?tab=nonsense' });

    expect(await tab(text.tabs.overview)).toHaveAttribute('aria-selected', 'true');
  });

  it('moves along the tabs with the arrow keys, around the ends, and to the ends', async () => {
    signedIn({ overview: NOTHING_WAITS });
    const first = await tab(text.tabs.overview);
    first.focus();

    await userEvent.keyboard('{ArrowLeft}');
    expect(await tab(text.tabs.security)).toHaveFocus();
    expect(await tab(text.tabs.security)).toHaveAttribute('aria-selected', 'true');

    await userEvent.keyboard('{ArrowRight}');
    expect(first).toHaveFocus();

    await userEvent.keyboard('{End}');
    expect(await tab(text.tabs.security)).toHaveFocus();

    await userEvent.keyboard('{Home}');
    expect(first).toHaveFocus();
    // Only the tab chosen is in the order of the Tab key.
    expect(first).toHaveAttribute('tabindex', '0');
    expect(await tab(text.tabs.security)).toHaveAttribute('tabindex', '-1');
  });

  it('asks a part for nothing until it is opened, and keeps it after that', async () => {
    signedIn({ overview: NOTHING_WAITS });
    const update = vi
      .mocked(adminApi.dbUpdateStatus)
      .mockResolvedValue({ status: 'idle' } as never);
    const files = vi.mocked(adminApi.shipConfig);
    await tab(text.tabs.overview);
    await waitFor(() => expect(adminApi.overview).toHaveBeenCalled());

    expect(update).not.toHaveBeenCalled();
    expect(files).not.toHaveBeenCalled();

    await userEvent.click(await tab(text.tabs.catalogue));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));

    await userEvent.click(await tab(text.tabs.overview));
    await userEvent.click(await tab(text.tabs.catalogue));

    expect(update).toHaveBeenCalledTimes(1);
  });
});
